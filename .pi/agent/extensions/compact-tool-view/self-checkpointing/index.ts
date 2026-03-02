import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { hasTrailingCheckpointNowStamp } from "../lib/autockpt/autockpt-context-stamp.ts";
import { assistantTextFromContent } from "../lib/autockpt/autockpt-footer-guards.ts";
import {
  buildAutockptDirectiveMessage,
  buildCommandAutotestKickoffMessage,
  buildCompactionInstructions,
  buildFlagAutotestKickoffMessage,
  buildResumeSelfPing,
} from "../lib/autockpt/autockpt-prompts.ts";
import { parseFooterDedupeWindowMs, type FooterHandledRecord } from "../lib/autockpt/autockpt-footer-dedupe.ts";
import { registerAutockptCommand } from "../lib/autockpt/autockpt-command.ts";
import { parseNonNegativeIntEnv } from "../lib/autockpt/autockpt-env.ts";
import { probeCtxState } from "../lib/autockpt/autockpt-ctx-probes.ts";

import { createSelfCheckpointingSessionStore } from "./lib/self-checkpointing-session-store.ts";
import { createAutoKickController, type AutoKickController } from "./lib/self-checkpointing-auto-kick.ts";
import { createPendingResumeController, type PendingResumeController } from "./lib/self-checkpointing-pending-resume.ts";
import { compactThenResume } from "./lib/self-checkpointing-compaction.ts";
import { createAutotestController, type AutotestController } from "./lib/self-checkpointing-autotest.ts";
import { cleanupStaleCompactionLocksInStateDir } from "./lib/self-checkpointing-lock-sweep.ts";
import { handleAssistantMessageEnd } from "./lib/self-checkpointing-footer-handler.ts";

/**
 * Self-checkpointing (orchestrator)
 *
 * Design:
 * - Primarily driven by `ctx.getContextUsage()` threshold (default 65%).
 * - Auto-kicks a directive message (custom_message, display=true)
 *   so checkpointing works even if the project doesn’t carry AGENTS.md.
 * - Watches assistant message end for a checkpoint footer.
 *   When seen, it triggers compaction, then sends a resume self-ping user message.
 */
export default function selfCheckpointing(pi: ExtensionAPI) {
  const enabled = (process.env.PI_SELF_CHECKPOINT_ENABLE ?? "1") !== "0";
  if (!enabled) return;

  const getThresholdPercent = (): number =>
    Number.parseFloat(
      process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME ??
        process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT ??
        "65",
    );

  const STATUS_KEY = "autockpt";

  const PENDING_DIR =
    process.env.PI_SELF_CHECKPOINT_STATE_DIR ??
    path.join(os.homedir(), ".pi", "agent", "state", "pi-self-checkpointing");

  // If overrides are set, we treat them as single global paths.
  // If unset, we scope to the active session id so independent sessions/processes don't interfere.
  const PENDING_RESUME_PATH_OVERRIDE = String(
    process.env.PI_SELF_CHECKPOINT_PENDING_RESUME_PATH ?? "",
  ).trim();
  const COMPACTION_LOCK_PATH_OVERRIDE = String(
    process.env.PI_SELF_CHECKPOINT_COMPACTION_LOCK_PATH ?? "",
  ).trim();

  const COMPACTION_LOCK_MAX_AGE_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_COMPACTION_LOCK_MAX_AGE_MS",
    600000,
  );

  const MAX_CHECKPOINT_AGE_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_MAX_CHECKPOINT_AGE_MS",
    600000,
  );

  const AUTOTEST_MAX_AGE_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTOTEST_MAX_AGE_MS",
    300000,
  );

  const AUTOTEST_MAX_TURNS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTOTEST_MAX_TURNS",
    12,
  );

  const FOOTER_DEDUPE_WINDOW_MS = parseFooterDedupeWindowMs(
    process.env.PI_SELF_CHECKPOINT_FOOTER_DEDUPE_MS,
    15_000,
  );

  let handledThisTurn = false;
  let lastHandledFooter: FooterHandledRecord | null = null;

  let pendingResumeTimer: NodeJS.Timeout | null = null;

  const setMarkerSuppressed = (on: boolean) => {
    if (on) {
      process.env.PI_SELF_CHECKPOINT_MARKER_SUPPRESS = "1";
    } else {
      delete process.env.PI_SELF_CHECKPOINT_MARKER_SUPPRESS;
    }
  };

  // "armed" means: current context usage is above the threshold.
  // (Used for status/debug; triggering is decided at footer-detection time.)
  let armed = false;

  let pendingCompactionRequested = false;

  const AUTO_KICK_MAX_AGE_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTO_KICK_MAX_AGE_MS",
    120000,
  );
  const AUTO_KICK_MIN_INTERVAL_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTO_KICK_MIN_INTERVAL_MS",
    10000,
  );

  const debugWidgetKey = "autockpt-debug";
  let debugEnabled = (process.env.PI_SELF_CHECKPOINT_DEBUG ?? "0") === "1";
  // If true, the debug widget is continuously updated with turn-by-turn logs.
  // Default off: spinner/status is enough for normal use.
  const debugWidgetAuto = (process.env.PI_SELF_CHECKPOINT_DEBUG_WIDGET_AUTO ?? "0") === "1";
  const debugLog: string[] = [];

  const setStatus = (ctx: ExtensionContext, text?: string) =>
    ctx.ui.setStatus(STATUS_KEY, text && text.trim() ? text : undefined);

  const getUsage = (ctx: ExtensionContext) => ctx.getContextUsage();

  const pushDebug = (ctx: ExtensionContext, line: string) => {
    if (!debugEnabled) return;

    const ts = new Date().toISOString().replace("T", " ").replace(/\..+$/, "Z");
    debugLog.push(`[${ts}] ${line}`);
    if (debugLog.length > 50) debugLog.splice(0, debugLog.length - 50);

    if (debugWidgetAuto && ctx.hasUI) {
      ctx.ui.setWidget(debugWidgetKey, debugLog.slice(-20), { placement: "aboveEditor" });
    }
  };

  const renderDebugWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      debugWidgetKey,
      debugLog.length ? debugLog.slice(-20) : ["(autockpt debug log empty)"],
      { placement: "aboveEditor" },
    );
  };

  const setDebugEnabled = (next: boolean) => {
    debugEnabled = next;
  };

  // sendUserMessage() will throw if the agent is currently streaming and deliverAs isn't specified.
  // For extension-driven follow-ups (resume pings, autotest kickoffs), default to followUp delivery.
  const sendFollowUpUserMessage = (text: string) => {
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      // Best-effort fallback (should only matter if the host disallows deliverAs while idle).
      try {
        pi.sendUserMessage(text);
      } catch {
        // ignore
      }
    }
  };

  const sessionStore = createSelfCheckpointingSessionStore({
    pendingDir: PENDING_DIR,
    pendingResumePathOverride: PENDING_RESUME_PATH_OVERRIDE,
    compactionLockPathOverride: COMPACTION_LOCK_PATH_OVERRIDE,
    lockMaxAgeMs: COMPACTION_LOCK_MAX_AGE_MS,
    pushDebug,
    isDebugEnabled: () => debugEnabled,
  });

  const updateArmedStatus = (ctx: ExtensionContext, autoKick: AutoKickController) => {
    if (handledThisTurn) return;

    autoKick.maybeClearStale(ctx, "update_status");

    if (pendingCompactionRequested) {
      armed = false;
      setStatus(ctx, "| Checkpoint: compacting… 🟡");
      return;
    }

    if (autoKick.isInFlight()) {
      armed = false;
      setStatus(ctx, "| Checkpoint: writing checkpoint… 🟡");
      return;
    }

    const usage = getUsage(ctx);
    const pct = usage?.percent;
    const threshold = getThresholdPercent();
    const aboveThreshold = pct !== null && pct !== undefined && pct >= threshold;

    armed = aboveThreshold;

    if (aboveThreshold && pct !== null && pct !== undefined) {
      setStatus(ctx, `| Checkpoint: armed (${pct.toFixed(1)}%) 🟡`);
      return;
    }

    setStatus(ctx, undefined);
  };

  const autoKick: AutoKickController = createAutoKickController({
    pi,
    pid: process.pid,
    customType: "pi-self-checkpointing",
    maxAgeMs: AUTO_KICK_MAX_AGE_MS,
    minIntervalMs: AUTO_KICK_MIN_INTERVAL_MS,
    attemptLimit: 3,
    buildDirectiveMessage: buildAutockptDirectiveMessage,
    getHandledThisTurn: () => handledThisTurn,
    getPendingCompactionRequested: () => pendingCompactionRequested,
    setArmed: (next) => {
      armed = next;
    },
    setMarkerSuppressed,
    setStatus,
    pushDebug,
    ensureCompactionLock: sessionStore.ensureCompactionLock,
    releaseCompactionLock: sessionStore.releaseCompactionLock,
    getActiveCompactionLock: sessionStore.getActiveCompactionLock,
  });

  const pendingResume: PendingResumeController = createPendingResumeController({
    pid: process.pid,
    readPending: sessionStore.readPending,
    writePending: sessionStore.writePending,
    clearPending: sessionStore.clearPending,
    sessionIdFor: sessionStore.sessionIdFor,
    getActiveCompactionLock: sessionStore.getActiveCompactionLock,
    pushDebug,
    sendUserMessage: (text) => sendFollowUpUserMessage(text),
  });

  const autotest: AutotestController = createAutotestController({
    flagPath: "work/.autockpt_autotest_once",
    maxAgeMs: AUTOTEST_MAX_AGE_MS,
    maxTurns: AUTOTEST_MAX_TURNS,
    setDebugEnabled,
    pushDebug,
    updateArmedStatus: (ctx) => updateArmedStatus(ctx, autoKick),
    getThresholdPercent,
    notify: (ctx, msg, level) => ctx.ui.notify(msg, level),
    sendUserMessage: (text) => sendFollowUpUserMessage(text),
    buildFlagKickoffMessage: buildFlagAutotestKickoffMessage,
    buildCommandKickoffMessage: buildCommandAutotestKickoffMessage,
  });

  const maybeAutoKick = (ctx: ExtensionContext, reason: string) => {
    if (handledThisTurn) return;
    if (pendingCompactionRequested) return;
    if (!armed) return;

    const { isIdle } = probeCtxState(ctx);
    if (!isIdle) return;

    autoKick.start(ctx, reason);
  };

  registerAutockptCommand(pi, {
    enabled,
    debugWidgetKey,
    getUsage,
    getThresholdPercent,
    getArmed: () => armed,
    getPendingCompactionRequested: () => pendingCompactionRequested,
    getAutotestInProgress: () => autotest.isInProgress(),
    getCompactionLock: (ctx) => sessionStore.getActiveCompactionLock(ctx),
    isDebugEnabled: () => debugEnabled,
    setDebugEnabled,
    getDebugLog: () => debugLog,
    clearDebugLog: () => {
      debugLog.splice(0, debugLog.length);
    },
    renderDebugWidget,
    updateArmedStatus: (ctx) => updateArmedStatus(ctx, autoKick),
    pushDebug,
    startAutotestFromCommand: (ctx, threshold) => autotest.startFromCommand(ctx, threshold),
  });

  pi.on("session_start", (_event, ctx) => {
    handledThisTurn = false;
    lastHandledFooter = null;
    armed = false;
    pendingCompactionRequested = false;

    autoKick.resetForSessionStart();

    cleanupStaleCompactionLocksInStateDir({
      ctx,
      pendingDir: PENDING_DIR,
      lockMaxAgeMs: COMPACTION_LOCK_MAX_AGE_MS,
      pushDebug,
      source: "session_start",
    });

    sessionStore.cleanupLockOnSessionStart(ctx);

    setMarkerSuppressed(false);
    setStatus(ctx, undefined);
    pushDebug(ctx, "session_start");

    // Default behavior: do NOT spam a live debug widget. Clear it on startup unless explicitly enabled.
    if (ctx.hasUI && !debugWidgetAuto) {
      ctx.ui.setWidget(debugWidgetKey, undefined);
    }

    if (pendingResumeTimer) {
      clearInterval(pendingResumeTimer);
      pendingResumeTimer = null;
    }

    pendingResumeTimer = setInterval(() => {
      try {
        const cleared = autoKick.maybeClearStale(ctx, "timer");

        if (!pendingCompactionRequested) {
          pendingResume.trySend(ctx, "timer");
        }

        if (cleared) {
          updateArmedStatus(ctx, autoKick);
        }
      } catch {
        // ignore
      }
    }, 1200);
    pendingResumeTimer.unref?.();

    // One-shot autotest hook (used for non-interactive testing).
    autotest.maybeStartFromFlag(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    handledThisTurn = false;
    armed = false;
    setMarkerSuppressed(pendingCompactionRequested || autoKick.isInFlight());
    pushDebug(ctx, "turn_start");
    updateArmedStatus(ctx, autoKick);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionStore.cleanupLockOnShutdown(ctx);

    if (pendingResumeTimer) {
      clearInterval(pendingResumeTimer);
      pendingResumeTimer = null;
    }

    updateArmedStatus(ctx, autoKick);
  });

  // Backup completion hook: if ctx.compact() callbacks are skipped for any reason,
  // ensure we clear the local "compacting" state and re-send pending resume.
  pi.on("session_compact", (_event, ctx) => {
    if (!pendingCompactionRequested) return;

    pushDebug(ctx, "session_compact observed (autockpt); clearing pending compaction and resuming");

    pendingCompactionRequested = false;
    setMarkerSuppressed(false);

    // Best-effort: if we still hold the lock, release it.
    sessionStore.releaseCompactionLock(ctx, "session_compact");

    // Best-effort: cleanup autotest runtime override if it’s still armed.
    autotest.cleanup(ctx, "session_compact");

    // Try immediate resume (safe-guarded by ownership + idle checks + spam guard).
    pendingResume.trySend(ctx, "session_compact");

    updateArmedStatus(ctx, autoKick);
  });

  pi.on("turn_end", (_event, ctx) => {
    // Keep marker suppression consistent across the whole auto-checkpoint cycle.
    setMarkerSuppressed(pendingCompactionRequested || autoKick.isInFlight());

    // Auto-kick watchdog: don't let "writing checkpoint" get stuck forever.
    autoKick.maybeClearStale(ctx, "turn_end");

    // Autotest failsafe: avoid leaving the runtime threshold override stuck low forever.
    autotest.onTurnEnd(ctx, pendingCompactionRequested);

    pushDebug(
      ctx,
      `turn_end compacting=${pendingCompactionRequested} autoKickInFlight=${autoKick.isInFlight()} armed=${armed}`,
    );

    updateArmedStatus(ctx, autoKick);

    // If we’re above threshold and idle, proactively inject a hidden directive so this works
    // even in repos that don’t carry AGENTS.md.
    maybeAutoKick(ctx, "turn_end");
  });

  // Keep status reasonably fresh + clear pending resume once we see it actually enter the input pipeline.
  pi.on("input", (event, ctx) => {
    try {
      const text = String(event?.text || "");
      pendingResume.observeInputText(ctx, text, String((event as any)?.source || "?"));

      // If idle and pending exists, this is a good moment to re-send.
      if (!pendingCompactionRequested) {
        pendingResume.trySend(ctx, "input_event");
      }
    } catch {
      // ignore
    }

    updateArmedStatus(ctx, autoKick);
  });

  // Interrupt mode: as soon as we detect we are above the threshold (or see the stamp marker),
  // inject the directive as a *steering* message so the agent stops the current task and checkpoints.
  pi.on("tool_result", (event, ctx) => {
    try {
      if (autoKick.isInFlight()) {
        autoKick.bumpActivity();
      }

      const markerSuppressed = (process.env.PI_SELF_CHECKPOINT_MARKER_SUPPRESS ?? "0") === "1";
      if (!markerSuppressed && !handledThisTurn && !pendingCompactionRequested && !autoKick.isInFlight()) {
        const usage = getUsage(ctx);
        const pct = usage?.percent;
        const threshold = getThresholdPercent();
        const aboveThreshold = pct !== null && pct !== undefined && pct >= threshold;

        const text = assistantTextFromContent((event as any)?.content);

        // IMPORTANT: tool output can include the raw marker string (e.g. when printing source code).
        // Only treat it as a signal when it matches the trailing context-stamp line format.
        const sawStampMarker = hasTrailingCheckpointNowStamp(text);

        if (sawStampMarker || aboveThreshold) {
          const reason = sawStampMarker ? "stamp_seen_tool_result" : "threshold_tool_result";
          autoKick.start(ctx, reason);
        }
      }
    } catch {
      // ignore
    }

    updateArmedStatus(ctx, autoKick);
  });

  const startCompaction = (
    ctx: ExtensionContext,
    checkpointPath: string,
    compactionInstructions?: string,
  ) => {
    compactThenResume(
      {
        pid: process.pid,
        getPendingCompactionRequested: () => pendingCompactionRequested,
        setPendingCompactionRequested: (next) => {
          pendingCompactionRequested = next;
        },
        ensureCompactionLock: (ctx2, checkpointPath2) => sessionStore.ensureCompactionLock(ctx2, checkpointPath2),
        releaseCompactionLock: sessionStore.releaseCompactionLock,
        setMarkerSuppressed,
        buildResumeText: buildResumeSelfPing,
        buildCustomInstructions: (checkpointPath2, extraInstructions) =>
          buildCompactionInstructions({ checkpointPath: checkpointPath2, extraInstructions }),
        writePending: sessionStore.writePending,
        sessionIdFor: sessionStore.sessionIdFor,
        trySendPendingResume: (ctx2, reason) => pendingResume.trySend(ctx2, reason),
        pushDebug,
        setStatus,
        cleanupAutotest: (ctx2, reason) => autotest.cleanup(ctx2, reason),
        getDebugEnabled: () => debugEnabled,
        notify: (ctx2, msg, level) => ctx2.ui.notify(msg, level),
        sendUserMessage: (text2) => sendFollowUpUserMessage(text2),
        updateArmedStatus: (ctx2) => updateArmedStatus(ctx2, autoKick),
      },
      ctx,
      checkpointPath,
      compactionInstructions,
    );
  };

  // Detect checkpoint footer only at assistant message end (full message available).
  pi.on("message_end", (event, ctx) => {
    handleAssistantMessageEnd(
      {
        autoKick,
        getHandledThisTurn: () => handledThisTurn,
        setHandledThisTurn: (next) => {
          handledThisTurn = next;
        },
        setArmed: (next) => {
          armed = next;
        },
        getLastHandledFooter: () => lastHandledFooter,
        setLastHandledFooter: (next) => {
          lastHandledFooter = next;
        },
        getUsage,
        getThresholdPercent,
        maxCheckpointAgeMs: MAX_CHECKPOINT_AGE_MS,
        footerDedupeWindowMs: FOOTER_DEDUPE_WINDOW_MS,
        ensureCompactionLock: (ctx2, checkpointPath) => sessionStore.ensureCompactionLock(ctx2, checkpointPath),
        setMarkerSuppressed,
        pushDebug,
        isDebugEnabled: () => debugEnabled,
        notify: (ctx2, msg, level) => ctx2.ui.notify(msg, level),
        updateArmedStatus: (ctx2) => updateArmedStatus(ctx2, autoKick),
        startCompaction,
      },
      event,
      ctx,
    );
  });
}
