import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
import { isCheckpointCycleActive, setCheckpointCycleActive as setSharedCheckpointCycleActive } from "../lib/autockpt/autockpt-runtime-state.ts";

import { createSelfCheckpointingSessionStore } from "./lib/self-checkpointing-session-store.ts";
import { createAutoKickController, type AutoKickController } from "./lib/self-checkpointing-auto-kick.ts";
import { createPendingResumeController, type PendingResumeController } from "./lib/self-checkpointing-pending-resume.ts";
import { compactThenResume } from "./lib/self-checkpointing-compaction.ts";
import { createAutotestController, type AutotestController } from "./lib/self-checkpointing-autotest.ts";
import { createSelfCheckpointingUiRuntime } from "./lib/self-checkpointing-ui-runtime.ts";
import { registerSelfCheckpointingHooks } from "./lib/self-checkpointing-hooks.ts";

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
  let armed = false;
  let pendingCompactionRequested = false;

  const setCheckpointCycleActive = (ctx: ExtensionContext, active: boolean) => {
    setSharedCheckpointCycleActive(ctx, active);
  };

  const AUTO_KICK_MAX_AGE_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTO_KICK_MAX_AGE_MS",
    120000,
  );
  const AUTO_KICK_MIN_INTERVAL_MS = parseNonNegativeIntEnv(
    "PI_SELF_CHECKPOINT_AUTO_KICK_MIN_INTERVAL_MS",
    10000,
  );

  const debugWidgetAuto = (process.env.PI_SELF_CHECKPOINT_DEBUG_WIDGET_AUTO ?? "0") === "1";
  const uiRuntime = createSelfCheckpointingUiRuntime(pi, {
    statusKey: STATUS_KEY,
    debugWidgetKey: "autockpt-debug",
    debugEnabled: (process.env.PI_SELF_CHECKPOINT_DEBUG ?? "0") === "1",
    debugWidgetAuto,
  });
  const getUsage = (ctx: ExtensionContext) => ctx.getContextUsage();
  const debugWidgetKey = uiRuntime.debugWidgetKey;
  const setStatus = uiRuntime.setStatus;
  const pushDebug = uiRuntime.pushDebug;
  const renderDebugWidget = uiRuntime.renderDebugWidget;
  const setDebugEnabled = uiRuntime.setDebugEnabled;
  const isDebugEnabled = uiRuntime.isDebugEnabled;
  const getDebugLog = uiRuntime.getDebugLog;
  const clearDebugLog = uiRuntime.clearDebugLog;
  const sendFollowUpUserMessage = uiRuntime.sendFollowUpUserMessage;

  const sessionStore = createSelfCheckpointingSessionStore({
    pendingDir: PENDING_DIR,
    pendingResumePathOverride: PENDING_RESUME_PATH_OVERRIDE,
    compactionLockPathOverride: COMPACTION_LOCK_PATH_OVERRIDE,
    lockMaxAgeMs: COMPACTION_LOCK_MAX_AGE_MS,
    pushDebug,
    isDebugEnabled,
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
    setCheckpointCycleActive,
    setStatus,
    pushDebug,
    ensureCompactionLock: sessionStore.ensureCompactionLock,
    releaseCompactionLock: sessionStore.releaseCompactionLock,
    getActiveCompactionLock: sessionStore.getActiveCompactionLock,
  });

  const syncCheckpointCycleState = (ctx: ExtensionContext) => {
    const active = isCheckpointCycleActive(ctx) || pendingCompactionRequested || autoKick.isInFlight();
    setCheckpointCycleActive(ctx, active);
  };

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
    if (isCheckpointCycleActive(ctx)) return;

    const { isIdle } = probeCtxState(ctx);
    if (!isIdle) return;

    autoKick.start(ctx, reason);
  };

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
        setCheckpointCycleActive,
        buildResumeText: buildResumeSelfPing,
        buildCustomInstructions: (checkpointPath2, extraInstructions) =>
          buildCompactionInstructions({ checkpointPath: checkpointPath2, extraInstructions }),
        writePending: sessionStore.writePending,
        sessionIdFor: sessionStore.sessionIdFor,
        trySendPendingResume: (ctx2, reason) => pendingResume.trySend(ctx2, reason),
        pushDebug,
        setStatus,
        cleanupAutotest: (ctx2, reason) => autotest.cleanup(ctx2, reason),
        getDebugEnabled: isDebugEnabled,
        notify: (ctx2, msg, level) => ctx2.ui.notify(msg, level),
        updateArmedStatus: (ctx2) => updateArmedStatus(ctx2, autoKick),
      },
      ctx,
      checkpointPath,
      compactionInstructions,
    );
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
    isDebugEnabled,
    setDebugEnabled,
    getDebugLog,
    clearDebugLog,
    renderDebugWidget,
    updateArmedStatus: (ctx) => updateArmedStatus(ctx, autoKick),
    pushDebug,
    startAutotestFromCommand: (ctx, threshold) => autotest.startFromCommand(ctx, threshold),
  });

  registerSelfCheckpointingHooks(pi, {
    pendingDir: PENDING_DIR,
    compactionLockMaxAgeMs: COMPACTION_LOCK_MAX_AGE_MS,
    debugWidgetKey,
    debugWidgetAuto,
    maxCheckpointAgeMs: MAX_CHECKPOINT_AGE_MS,
    footerDedupeWindowMs: FOOTER_DEDUPE_WINDOW_MS,
    autoKick,
    pendingResume,
    autotest,
    sessionStore,
    getHandledThisTurn: () => handledThisTurn,
    setHandledThisTurn: (next) => {
      handledThisTurn = next;
    },
    getLastHandledFooter: () => lastHandledFooter,
    setLastHandledFooter: (next) => {
      lastHandledFooter = next;
    },
    getArmed: () => armed,
    setArmed: (next) => {
      armed = next;
    },
    getPendingCompactionRequested: () => pendingCompactionRequested,
    setPendingCompactionRequested: (next) => {
      pendingCompactionRequested = next;
    },
    getUsage,
    getThresholdPercent,
    setCheckpointCycleActive,
    syncCheckpointCycleState,
    updateArmedStatus: (ctx) => updateArmedStatus(ctx, autoKick),
    maybeAutoKick,
    startCompaction,
    pushDebug,
    setStatus,
    isDebugEnabled,
  });
}
