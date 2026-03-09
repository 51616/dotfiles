import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  AUTOCHECKPOINT_DONE_MARKER,
  COMPACTION_INSTR_BEGIN,
} from "../../lib/autockpt/autockpt-markers.ts";
import {
  assistantTextFromContent,
  isFreshCheckpointFile,
  parseCheckpointFooter,
} from "../../lib/autockpt/autockpt-footer-guards.ts";
import {
  markFooterHandled,
  shouldSkipDuplicateFooter,
  type FooterHandledRecord,
} from "../../lib/autockpt/autockpt-footer-dedupe.ts";
import type { AutoKickController } from "./self-checkpointing-auto-kick.ts";

export type FooterHandlerDeps = {
  autoKick: AutoKickController;

  getHandledThisTurn: () => boolean;
  setHandledThisTurn: (next: boolean) => void;

  setArmed: (next: boolean) => void;

  getLastHandledFooter: () => FooterHandledRecord | null;
  setLastHandledFooter: (next: FooterHandledRecord) => void;

  getUsage: (ctx: ExtensionContext) => { percent?: number | null } | undefined;
  getThresholdPercent: () => number;

  maxCheckpointAgeMs: number;
  footerDedupeWindowMs: number;

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

function inferLatestCheckpointPath(maxAgeMs: number): string | null {
  const dir = path.join("work", "log", "checkpoints");

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const nowMs = Date.now();

  let bestPath: string | null = null;
  let bestMtimeMs = -1;

  for (const name of entries) {
    if (!name.endsWith(".md")) continue;

    const p = path.join(dir, name);

    try {
      const st = statSync(p);
      const ageMs = nowMs - st.mtimeMs;
      if (maxAgeMs > 0 && ageMs > maxAgeMs) continue;

      if (st.mtimeMs > bestMtimeMs) {
        bestMtimeMs = st.mtimeMs;
        bestPath = p;
      }
    } catch {
      // ignore
    }
  }

  return bestPath;
}

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
  const pct = usage?.percent;
  const threshold = deps.getThresholdPercent();
  const aboveThreshold = pct !== null && pct !== undefined && pct >= threshold;

  // Parse footers when either:
  // - we are in an auto-kick cycle (we explicitly requested a checkpoint), OR
  // - the context usage is currently above the threshold, OR
  // - the assistant explicitly emitted the done marker (manual [autockpt] runs)
  if (!deps.autoKick.isInFlight() && !aboveThreshold && !sawDoneMarker) return;

  const parsed = parseCheckpointFooter(text, 8000);

  // If the assistant emitted the done marker but omitted `path=...`, try to infer the
  // newest checkpoint file. This keeps the system resilient to minor LLM formatting slips.
  let checkpointPath = parsed?.checkpointPath ?? "";
  const compactionInstructions = parsed?.compactionInstructions ?? "";

  if (!checkpointPath && sawDoneMarker) {
    const inferred = inferLatestCheckpointPath(deps.maxCheckpointAgeMs);
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

  if (!isFreshCheckpointFile(checkpointPath, deps.maxCheckpointAgeMs)) {
    if (deps.isDebugEnabled()) {
      deps.pushDebug(ctx, `message_end: checkpoint invalid/stale path=${checkpointPath}`);
    }

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

  // As soon as we see a valid footer, mute stamp emission so the user doesn't get
  // another __PI_CHECKPOINT_NOW__ line while compaction is spinning up.
  deps.setCheckpointCycleActive(ctx, true);

  // Defer to next tick so we don't start compaction inside the event handler stack.
  setTimeout(() => {
    deps.startCompaction(ctx, checkpointPath, compactionInstructions);
  }, 0);
}
