import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  AUTOCHECKPOINT_DONE_MARKER,
  COMPACTION_INSTR_BEGIN,
} from "../../lib/autockpt/autockpt-markers.ts";
import { assistantTextFromContent, parseCheckpointFooter } from "../../lib/autockpt/autockpt-footer-guards.ts";
import {
  markFooterHandled,
  shouldSkipDuplicateFooter,
  type FooterHandledRecord,
} from "../../lib/autockpt/autockpt-footer-dedupe.ts";
import type { AutoKickController } from "./self-checkpointing-auto-kick.ts";
import type { CheckpointProbe } from "./self-checkpointing-checkpoint-probe.ts";
import { isContextUsageAtOrAboveThreshold } from "../../lib/autockpt/autockpt-threshold.ts";

export type FooterHandlerDeps = {
  autoKick: AutoKickController;

  getHandledThisTurn: () => boolean;
  setHandledThisTurn: (next: boolean) => void;

  setArmed: (next: boolean) => void;

  getLastHandledFooter: () => FooterHandledRecord | null;
  setLastHandledFooter: (next: FooterHandledRecord) => void;

  getUsage: (ctx: ExtensionContext) => { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | undefined;
  getThresholdPercent: () => number;
  getThresholdTokens: () => number;

  maxCheckpointAgeMs: number;
  footerDedupeWindowMs: number;
  checkpointProbe: CheckpointProbe;

  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath: string) => boolean;

  setCheckpointCycleActive: (ctx: ExtensionContext, active: boolean) => void;

  pushDebug: (ctx: ExtensionContext, line: string) => void;
  isDebugEnabled: () => boolean;
  notify: (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => void;

  updateArmedStatus: (ctx: ExtensionContext) => void;

  // Called after a footer was validated (may do compaction + resume).
  startCompaction: (
    ctx: ExtensionContext,
    checkpointPath: string,
    compactionInstructions?: string,
  ) => void;
};

export function handleAssistantMessageEnd(
  deps: FooterHandlerDeps,
  event: any,
  ctx: ExtensionContext,
) {
  const msg = (event?.message as any) ?? null;
  const role = (msg as any)?.role;
  if (deps.getHandledThisTurn()) return;
  if (String(role || "") !== "assistant") return;

  // Ignore custom messages (including the steering directive we inject ourselves).
  // They can contain footer marker examples and would otherwise trigger false footer parsing,
  // which can clear auto-kick state and cause repeated steering injections.
  const customType = typeof msg === "object" ? String((msg as any)?.customType || "").trim() : "";
  if (customType) return;

  const text = assistantTextFromContent((event?.message as any)?.content);
  const sawDoneMarker = text.includes(AUTOCHECKPOINT_DONE_MARKER);

  const usage = deps.getUsage(ctx);
  const threshold = {
    percent: deps.getThresholdPercent(),
    tokens: deps.getThresholdTokens(),
  };
  const thresholdMatch = isContextUsageAtOrAboveThreshold(usage, threshold);

  // Parse footers when either:
  // - we are in an auto-kick cycle (we explicitly requested a checkpoint), OR
  // - the context usage is currently above the threshold, OR
  // - the assistant explicitly emitted the done marker (manual [autockpt] runs)
  if (!deps.autoKick.isInFlight() && !thresholdMatch.matched && !sawDoneMarker) return;

  const parsed = parseCheckpointFooter(text, 8000);

  // If the assistant emitted the done marker but omitted `path=...`, try to infer the
  // newest checkpoint file. This keeps the system resilient to minor LLM formatting slips.
  let checkpointPath = parsed?.checkpointPath ?? "";
  const compactionInstructions = parsed?.compactionInstructions ?? "";

  if (!checkpointPath && sawDoneMarker) {
    const inferred = deps.checkpointProbe.inferLatestCheckpointPath(deps.maxCheckpointAgeMs);
    if (inferred) {
      checkpointPath = inferred;
      deps.pushDebug(ctx, `message_end: footer missing path; inferred checkpointPath=${checkpointPath}`);
    }
  }

  if (!checkpointPath) {
    // Only log if it *looks* like the assistant tried to emit the footer.
    if (deps.isDebugEnabled() && (text.includes(COMPACTION_INSTR_BEGIN) || sawDoneMarker)) {
      const lastLine = text.trimEnd().split("\n").slice(-1)[0] ?? "";
      deps.pushDebug(ctx, `message_end: footer not matched (lastLine='${lastLine.slice(0, 80)}')`);
    }

    // If we explicitly requested a checkpoint but didn’t get a valid footer, don’t leave the
    // status stuck on “writing checkpoint…” forever.
    if (deps.autoKick.isInFlight()) {
      if (deps.isDebugEnabled()) {
        const lastLine = text.trimEnd().split("\n").slice(-1)[0] ?? "";
        deps.pushDebug(ctx, `message_end: auto-kick footer missing (lastLine='${lastLine.slice(0, 80)}')`);
      }

      deps.autoKick.clearInFlight(ctx, "footer_not_matched_message_end");
      deps.updateArmedStatus(ctx);
    }

    return;
  }

  deps.pushDebug(ctx, `message_end: validating checkpoint path=${checkpointPath}`);
  const checkpointFresh = deps.checkpointProbe.isFreshCheckpointFile(checkpointPath, deps.maxCheckpointAgeMs);
  deps.pushDebug(ctx, `message_end: checkpoint probe fresh=${checkpointFresh} path=${checkpointPath}`);

  if (!checkpointFresh) {
    if (deps.autoKick.isInFlight()) {
      deps.autoKick.clearInFlight(ctx, `checkpoint_invalid:${checkpointPath}`);
      deps.updateArmedStatus(ctx);
    }

    return;
  }

  const nowMs = Date.now();
  if (
    shouldSkipDuplicateFooter({
      lastHandled: deps.getLastHandledFooter(),
      checkpointPath,
      nowMs,
      dedupeWindowMs: deps.footerDedupeWindowMs,
    })
  ) {
    deps.pushDebug(ctx, `message_end: duplicate footer ignored path=${checkpointPath}`);
    return;
  }

  if (!deps.ensureCompactionLock(ctx, checkpointPath)) {
    if (deps.autoKick.isInFlight()) {
      deps.autoKick.clearInFlight(ctx, `compaction_lock_missing:${checkpointPath}`);
      deps.updateArmedStatus(ctx);
    }
    return;
  }

  deps.setLastHandledFooter(markFooterHandled(checkpointPath, nowMs));

  deps.pushDebug(
    ctx,
    `checkpoint footer matched path=${checkpointPath}${compactionInstructions ? ` instrChars=${compactionInstructions.length}` : ""}`,
  );
  if (deps.isDebugEnabled() && ctx.hasUI) {
    deps.notify(ctx, "autockpt: footer matched; starting compaction…", "info");
  }

  deps.setHandledThisTurn(true);
  deps.setArmed(false);
  deps.autoKick.markFooterMatched();

  // As soon as we see a valid footer, mark the checkpoint cycle active so auto-kick
  // stays muted while compaction is spinning up.
  deps.setCheckpointCycleActive(ctx, true);

  const readHasUI = (): boolean | null => {
    try {
      return ctx.hasUI === true;
    } catch {
      return null;
    }
  };

  const startCompactionIfContextActive = () => {
    // Headless one-shot runs can invalidate the extension context as soon as the event
    // pipeline finishes. Never let a deferred timer touch a stale ctx; it escapes pi's
    // event-handler error boundary and crashes the Discord worker process.
    if (readHasUI() === null) return;

    try {
      deps.startCompaction(ctx, checkpointPath, compactionInstructions);
    } catch (err) {
      try {
        const msg = err instanceof Error ? err.message : String(err);
        deps.pushDebug(ctx, `message_end: compaction start failed (${msg})`);
      } catch {
        // ignore; the ctx may have gone stale between the guard and debug write
      }
    }
  };

  const hasUI = readHasUI();
  if (hasUI === null) return;

  if (!hasUI) {
    startCompactionIfContextActive();
    return;
  }

  // In the TUI, defer to next tick so we don't start compaction inside the event handler stack.
  const timer = setTimeout(startCompactionIfContextActive, 0);
  timer.unref?.();
}
