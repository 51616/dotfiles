import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { FooterHandledRecord } from "../../lib/autockpt/autockpt-footer-dedupe.ts";
import {
  clearCheckpointCycleState,
  isCheckpointCycleActive,
} from "../../lib/autockpt/autockpt-runtime-state.ts";
import type { AutoKickController } from "./self-checkpointing-auto-kick.ts";
import type { PendingResumeController } from "./self-checkpointing-pending-resume.ts";
import type { AutotestController } from "./self-checkpointing-autotest.ts";
import { cleanupStaleCompactionLocksInStateDir } from "./self-checkpointing-lock-sweep.ts";
import { handleAssistantMessageEnd } from "./self-checkpointing-footer-handler.ts";
import type { CheckpointProbe, CheckpointProbeInfo } from "./self-checkpointing-checkpoint-probe.ts";
import { isContextUsageAtOrAboveThreshold } from "../../lib/autockpt/autockpt-threshold.ts";

type SessionStoreDeps = {
  cleanupLockOnSessionStart: (ctx: ExtensionContext) => void;
  cleanupLockOnShutdown: (ctx: ExtensionContext) => void;
  releaseCompactionLock: (ctx: ExtensionContext, reason: string) => void;
  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath: string) => boolean;
};

export type SelfCheckpointingHookDeps = {
  pendingDir: string;
  compactionLockMaxAgeMs: number;
  debugWidgetKey: string;
  debugWidgetAuto: boolean;
  maxCheckpointAgeMs: number;
  footerDedupeWindowMs: number;
  checkpointProbe: CheckpointProbe;

  autoKick: AutoKickController;
  pendingResume: PendingResumeController;
  autotest: AutotestController;
  sessionStore: SessionStoreDeps;

  getHandledThisTurn: () => boolean;
  setHandledThisTurn: (next: boolean) => void;
  getLastHandledFooter: () => FooterHandledRecord | null;
  setLastHandledFooter: (next: FooterHandledRecord | null) => void;

  getArmed: () => boolean;
  setArmed: (next: boolean) => void;

  getPendingCompactionRequested: () => boolean;
  setPendingCompactionRequested: (next: boolean) => void;

  getUsage: (ctx: ExtensionContext) => { tokens?: number | null; contextWindow?: number | null; percent?: number | null } | undefined;
  getThresholdPercent: () => number;
  getThresholdTokens: () => number;

  setCheckpointCycleActive: (ctx: ExtensionContext, active: boolean) => void;
  syncCheckpointCycleState: (ctx: ExtensionContext) => void;
  updateArmedStatus: (ctx: ExtensionContext) => void;
  maybeAutoKick: (ctx: ExtensionContext, reason: string) => void;
  startCompaction: (ctx: ExtensionContext, checkpointPath: string, compactionInstructions?: string) => void;

  pushDebug: (ctx: ExtensionContext, line: string) => void;
  describeCheckpointProbe: () => CheckpointProbeInfo;
  setStatus: (ctx: ExtensionContext, text?: string) => void;
  clearCompactionLoader: (ctx: ExtensionContext) => void;
  isDebugEnabled: () => boolean;
};

function formatCheckpointProbeInfo(info: CheckpointProbeInfo): string {
  if (info.mode === "local") {
    return `mode=local source=${info.source}`;
  }

  return `mode=ssh source=${info.source} remote=${info.remote ?? "?"} port=${info.port ?? "?"} cwd=${info.remotePath ?? "?"}`;
}

export function registerSelfCheckpointingHooks(
  pi: Pick<ExtensionAPI, "on">,
  deps: SelfCheckpointingHookDeps,
) {
  let pendingResumeTimer: NodeJS.Timeout | null = null;

  pi.on("session_start", (_event, ctx) => {
    deps.setHandledThisTurn(false);
    deps.setLastHandledFooter(null);
    deps.setArmed(false);
    deps.setPendingCompactionRequested(false);

    deps.autoKick.resetForSessionStart();

    cleanupStaleCompactionLocksInStateDir({
      ctx,
      pendingDir: deps.pendingDir,
      lockMaxAgeMs: deps.compactionLockMaxAgeMs,
      pushDebug: deps.pushDebug,
      source: "session_start",
    });

    deps.sessionStore.cleanupLockOnSessionStart(ctx);

    deps.clearCompactionLoader(ctx);
    clearCheckpointCycleState(ctx);
    deps.setStatus(ctx, undefined);
    deps.pushDebug(ctx, "session_start");
    deps.pushDebug(ctx, `checkpoint_probe ${formatCheckpointProbeInfo(deps.describeCheckpointProbe())}`);

    if (ctx.hasUI && !deps.debugWidgetAuto) {
      ctx.ui.setWidget(deps.debugWidgetKey, undefined);
    }

    if (pendingResumeTimer) {
      clearInterval(pendingResumeTimer);
      pendingResumeTimer = null;
    }

    pendingResumeTimer = setInterval(() => {
      try {
        const cleared = deps.autoKick.maybeClearStale(ctx, "timer");

        if (!deps.getPendingCompactionRequested()) {
          deps.pendingResume.trySend(ctx, "timer");
        }

        if (cleared) {
          deps.updateArmedStatus(ctx);
        }
      } catch {
        // ignore
      }
    }, 1200);
    pendingResumeTimer.unref?.();

    deps.autotest.maybeStartFromFlag(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    deps.setHandledThisTurn(false);
    deps.setArmed(false);
    deps.syncCheckpointCycleState(ctx);
    deps.pushDebug(ctx, "turn_start");
    deps.updateArmedStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    deps.clearCompactionLoader(ctx);
    deps.sessionStore.cleanupLockOnShutdown(ctx);
    clearCheckpointCycleState(ctx);

    if (pendingResumeTimer) {
      clearInterval(pendingResumeTimer);
      pendingResumeTimer = null;
    }

    deps.updateArmedStatus(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    deps.clearCompactionLoader(ctx);
    if (!deps.getPendingCompactionRequested()) return;

    deps.pushDebug(ctx, "session_compact observed (autockpt); clearing pending compaction and resuming");

    deps.setPendingCompactionRequested(false);
    deps.setCheckpointCycleActive(ctx, false);
    deps.sessionStore.releaseCompactionLock(ctx, "session_compact");
    deps.autotest.cleanup(ctx, "session_compact");
    deps.pendingResume.trySend(ctx, "session_compact");
    deps.updateArmedStatus(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    deps.syncCheckpointCycleState(ctx);
    deps.autoKick.maybeClearStale(ctx, "turn_end");
    deps.autotest.onTurnEnd(ctx, deps.getPendingCompactionRequested());

    deps.pushDebug(
      ctx,
      `turn_end compacting=${deps.getPendingCompactionRequested()} autoKickInFlight=${deps.autoKick.isInFlight()} armed=${deps.getArmed()}`,
    );

    deps.updateArmedStatus(ctx);
    deps.maybeAutoKick(ctx, "turn_end");
  });

  pi.on("input", (event, ctx) => {
    try {
      const text = String(event?.text || "");
      deps.pendingResume.observeInputText(ctx, text, String((event as any)?.source || "?"));

      if (!deps.getPendingCompactionRequested()) {
        deps.pendingResume.trySend(ctx, "input_event");
      }
    } catch {
      // ignore
    }

    deps.updateArmedStatus(ctx);
  });

  pi.on("tool_call", (_event, _ctx) => {
    deps.autoKick.noteToolCall();
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      if (deps.autoKick.isInFlight()) {
        deps.autoKick.bumpActivity();
      }

      if (
        !isCheckpointCycleActive(ctx) &&
        !deps.getHandledThisTurn() &&
        !deps.getPendingCompactionRequested() &&
        !deps.autoKick.isInFlight()
      ) {
        const usage = deps.getUsage(ctx);
        const threshold = {
          percent: deps.getThresholdPercent(),
          tokens: deps.getThresholdTokens(),
        };
        const thresholdMatch = isContextUsageAtOrAboveThreshold(usage, threshold);

        if (thresholdMatch.matched) {
          deps.autoKick.start(ctx, "threshold_tool_result");
        }
      }
    } catch {
      // ignore
    }

    deps.updateArmedStatus(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    handleAssistantMessageEnd(
      {
        autoKick: deps.autoKick,
        getHandledThisTurn: deps.getHandledThisTurn,
        setHandledThisTurn: deps.setHandledThisTurn,
        setArmed: deps.setArmed,
        getLastHandledFooter: deps.getLastHandledFooter,
        setLastHandledFooter: deps.setLastHandledFooter,
        getUsage: deps.getUsage,
        getThresholdPercent: deps.getThresholdPercent,
        getThresholdTokens: deps.getThresholdTokens,
        maxCheckpointAgeMs: deps.maxCheckpointAgeMs,
        footerDedupeWindowMs: deps.footerDedupeWindowMs,
        checkpointProbe: deps.checkpointProbe,
        ensureCompactionLock: deps.sessionStore.ensureCompactionLock,
        setCheckpointCycleActive: deps.setCheckpointCycleActive,
        pushDebug: deps.pushDebug,
        isDebugEnabled: deps.isDebugEnabled,
        notify: (ctx2, msg, level) => ctx2.ui.notify(msg, level),
        updateArmedStatus: deps.updateArmedStatus,
        startCompaction: deps.startCompaction,
      },
      event,
      ctx,
    );
  });
}
