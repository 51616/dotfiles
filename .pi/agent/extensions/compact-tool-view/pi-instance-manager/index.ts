import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  asString,
  managerRequest,
  probeManagerState,
  shouldEnable,
  type ManagerLock,
  type ManagerStateProbe,
} from "./lib/pi-instance-manager-common.ts";
import { SessionInputQueue } from "./lib/pi-instance-manager-queue.ts";
import { registerQueueCommand } from "./lib/pi-instance-manager-queue-command.ts";
import { registerInstanceManagerEventHooks } from "./lib/pi-instance-manager-event-hooks.ts";
import { handleSteerCommand } from "./lib/pi-instance-manager-steer.ts";
import {
  clearSessionResyncState,
  createSessionResyncState,
  refreshTrackedSessionFile,
} from "./lib/pi-instance-manager-resync.ts";
import {
  countRemoteQueuedTurns,
  findSessionLock,
  isSessionCompacting,
  toLocalTicketIdSet,
} from "./lib/pi-instance-manager-state.ts";
import { isSessionEffectivelyCompacting } from "./lib/pi-instance-manager-status.ts";
import { type SpinnerState } from "./lib/pi-instance-manager-ui.ts";
import { createTurnTicketClient } from "./lib/pi-instance-manager-turn-ticket.ts";
import { createTurnLockController } from "./lib/pi-instance-manager-turn-lock.ts";
import { createQueueRetryScheduler } from "./lib/pi-instance-manager-queue-retry.ts";
import { triggerManagerAutoHealRuntime } from "./lib/pi-instance-manager-autoheal-runtime.ts";
import { reissueQueueTickets } from "./lib/pi-instance-manager-queue-reissue.ts";
import { guardBranchNavigation } from "./lib/pi-instance-manager-branch-guard.ts";
import {
  beginCompactionLifecycle,
  endCompactionLifecycle,
} from "./lib/pi-instance-manager-compaction-lifecycle.ts";
import { syncSessionResyncAfterStateRefresh } from "./lib/pi-instance-manager-refresh-sync.ts";
import { applyFooterStatus } from "./lib/pi-instance-manager-footer.ts";

export default function piInstanceManager(pi: ExtensionAPI) {
  const cwd = process.cwd();
  if (!shouldEnable(cwd)) return;

  let lastCtx: ExtensionContext | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  const spinner: SpinnerState = { timer: null, index: 0, mode: "idle" };
  let managerCompactingThisSession = false;
  let managerLockThisSession: ManagerLock | null = null;
  let localCompactingUntil = 0;
  let localCompactingSessionId = "";
  let activeCompactionId = "";
  let currentSessionId = "";
  let queueDrainInFlight = false;
  let managerUnavailableError = "";
  let managerDownSince = 0;
  let remoteDiscordQueueDepth = 0;
  let activeTurnLockToken = "";
  let activeTurnLockSessionId = "";
  let activeTurnTicketId = "";
  let activeTurnText = "";
  let awaitingTurnEnd = false;
  let lastLocalSubmitAt = 0;
  let externalWriteExpectedUntil = 0;
  let autoHealInFlight = false;
  let lastAutoHealAt = 0;
  const sessionResync = createSessionResyncState();
  const queue = new SessionInputQueue();

  function setFooter(ctx: ExtensionContext) {
    const queued = queue.list(currentSessionId);

    applyFooterStatus({
      ctx,
      spinner,
      queued,
      managerLockOwner: asString(managerLockThisSession?.owner).trim(),
      managerUnavailableError,
      remoteDiscordQueueDepth,
      statusInput: {
        currentSessionId,
        managerCompactingThisSession,
        localCompactingUntil,
        localCompactingSessionId,
        managerUnavailableError,
        managerDownSince,
        awaitingTurnEnd,
        activeTurnLockSessionId,
        managerLockToken: asString(managerLockThisSession?.token).trim(),
        activeTurnLockToken,
        queueDrainInFlight,
        remoteDiscordQueueDepth,
        localQueueDepth: queued.length,
        nowMs: Date.now(),
      },
    });
  }

  const { scheduleQueueRetry, clearQueueRetryTimer } = createQueueRetryScheduler({
    onRetry: () => {
      if (lastCtx) void pumpInputQueue(lastCtx);
    },
  });

  const turnTicketClient = createTurnTicketClient({
    managerRequest,
    setManagerUnavailableError: (message) => {
      managerUnavailableError = message;
    },
    scheduleQueueRetry,
  });
  const { enqueueTurnTicket, waitForTurnGrant, finishTurnTicket } = turnTicketClient;

  function triggerManagerAutoHeal(ctx: ExtensionContext | null, probe: ManagerStateProbe) {
    triggerManagerAutoHealRuntime({
      cwd,
      ctx,
      probe,
      autoHealInFlight,
      lastAutoHealAt,
      managerDownSince,
      setAutoHealInFlight: (value) => (autoHealInFlight = value),
      setLastAutoHealAt: (value) => (lastAutoHealAt = value),
      setManagerUnavailableError: (value) => (managerUnavailableError = value),
      scheduleQueueRetry,
      onStatusUpdated: () => {
        if (lastCtx?.hasUI) setFooter(lastCtx);
      },
    });
  }

  const turnLockController = createTurnLockController({
    managerRequest,
    getActiveTurnLockToken: () => activeTurnLockToken,
    setActiveTurnLockToken: (value) => {
      activeTurnLockToken = value;
    },
    getActiveTurnLockSessionId: () => activeTurnLockSessionId,
    setActiveTurnLockSessionId: (value) => {
      activeTurnLockSessionId = value;
    },
    setAwaitingTurnEnd: (value) => {
      awaitingTurnEnd = value;
    },
    clearActiveTurnText: () => {
      activeTurnText = "";
    },
    setManagerUnavailableError: (message) => {
      managerUnavailableError = message;
    },
    scheduleQueueRetry,
    onRenewAttemptFinished: () => {
      if (lastCtx?.hasUI) setFooter(lastCtx);
    },
  });
  const { stopTurnLockRenew, releaseTurnLock, acquireTurnLock } = turnLockController;

  async function pumpInputQueue(ctx: ExtensionContext) {
    const sid = currentSessionId;
    if (!sid || queueDrainInFlight) {
      if (ctx.hasUI) setFooter(ctx);
      return;
    }

    if (isSessionEffectivelyCompacting({
      sessionId: sid,
      managerCompactingThisSession,
      localCompactingUntil,
      localCompactingSessionId,
      nowMs: Date.now(),
    })) {
      if (ctx.hasUI) setFooter(ctx);
      return;
    }

    if (awaitingTurnEnd && activeTurnLockSessionId === sid) {
      if (ctx.hasUI) setFooter(ctx);
      return;
    }

    const pending = queue.list(sid);
    if (pending.length === 0) {
      if (ctx.hasUI) setFooter(ctx);
      return;
    }

    if (Date.now() < externalWriteExpectedUntil && !sessionResync.pendingSessionResync) {
      if (ctx.hasUI) setFooter(ctx);
      return;
    }

    queueDrainInFlight = true;

    try {
      const next = pending[0];
      if (!next?.ticketId) {
        if (ctx.hasUI) setFooter(ctx);
        return;
      }

      const turn = await waitForTurnGrant(next.ticketId);
      if (!turn.granted) return;

      const lock = await acquireTurnLock(sid);
      if (!lock.token) {
        await finishTurnTicket(next.ticketId, "turn.cancel");
        const replacementTicketId = await enqueueTurnTicket(sid, next.text);
        if (replacementTicketId) {
          queue.removeByTicket(sid, next.ticketId);
          queue.unshift(sid, { ...next, ticketId: replacementTicketId, queuedAt: Date.now() });
        }
        return;
      }

      if (lock.waited || turn.waited) {
        const sessionPath = asString(ctx.sessionManager.getSessionFile()).trim();
        if (sessionPath) {
          try {
            await ctx.switchSession(sessionPath);
            refreshTrackedSessionFile(sessionResync, ctx);
            sessionResync.pendingSessionResync = false;
            externalWriteExpectedUntil = 0;
          } catch {
            // best effort only
          }
        }
      }

      const shifted = queue.shift(sid);
      const item = shifted && shifted.ticketId === next.ticketId ? shifted : next;
      if (!item) return;
      if (!shifted || shifted.ticketId !== next.ticketId) {
        queue.removeByTicket(sid, next.ticketId);
      }

      try {
        activeTurnTicketId = item.ticketId;
        activeTurnText = item.text;
        pi.sendUserMessage(item.text);
        awaitingTurnEnd = true;
      } catch {
        activeTurnTicketId = "";
        activeTurnText = "";
        await finishTurnTicket(item.ticketId, "turn.cancel");
        const replacementTicketId = await enqueueTurnTicket(sid, item.text);
        if (replacementTicketId) {
          queue.unshift(sid, { ...item, ticketId: replacementTicketId, queuedAt: Date.now() });
        }
        await releaseTurnLock();
      }
    } finally {
      queueDrainInFlight = false;
      if (ctx.hasUI) setFooter(ctx);
    }
  }

  async function refreshManagerState() {
    const previousLock = managerLockThisSession;
    const probe = await probeManagerState();
    const state = probe.state;

    if (!state) {
      managerCompactingThisSession = false;
      managerLockThisSession = null;
      remoteDiscordQueueDepth = 0;
      managerUnavailableError = asString(probe.errorMessage).trim() || "state.get failed";
      if (!managerDownSince) managerDownSince = Date.now();
      triggerManagerAutoHeal(lastCtx, probe);
      if (lastCtx?.hasUI) setFooter(lastCtx);
      return;
    }

    managerUnavailableError = "";
    managerDownSince = 0;

    const sid = currentSessionId;
    managerCompactingThisSession = isSessionCompacting(state, sid);
    managerLockThisSession = findSessionLock(state, sid);

    if (sid) {
      const localTicketIds = toLocalTicketIdSet(queue.list(sid));
      remoteDiscordQueueDepth = countRemoteQueuedTurns(state, sid, localTicketIds);
    } else {
      remoteDiscordQueueDepth = 0;
    }

    if (localCompactingUntil > 0 && Date.now() > localCompactingUntil) {
      localCompactingUntil = 0;
      localCompactingSessionId = "";
      activeCompactionId = "";
    }

    const queueDepth = queue.list(sid).length;
    await syncSessionResyncAfterStateRefresh({
      ctx: lastCtx,
      sid,
      previousLock,
      nextLock: managerLockThisSession,
      sessionResync,
      lastLocalSubmitAt,
      externalWriteExpectedUntil,
      setExternalWriteExpectedUntil: (value) => {
        externalWriteExpectedUntil = value;
      },
      activeTurnLockToken,
      activeTurnLockSessionId,
      queueDrainInFlight,
      queueDepth,
      compacting: isSessionEffectivelyCompacting({
        sessionId: sid,
        managerCompactingThisSession,
        localCompactingUntil,
        localCompactingSessionId,
        nowMs: Date.now(),
      }),
      hasActiveSessionLock: Boolean(managerLockThisSession),
    });
    if (lastCtx?.hasUI) setFooter(lastCtx);
    if (lastCtx) await pumpInputQueue(lastCtx);
  }

  async function beginCompaction(ctx: ExtensionContext) {
    await beginCompactionLifecycle({
      ctx,
      managerRequest,
      setCurrentSessionId: (value) => (currentSessionId = value),
      refreshTrackedSessionFile: (value) => refreshTrackedSessionFile(sessionResync, value),
      setLocalCompactingSessionId: (value) => (localCompactingSessionId = value),
      setLocalCompactingUntil: (value) => (localCompactingUntil = value),
      setFooter,
      setActiveCompactionId: (value) => (activeCompactionId = value),
    });
  }

  async function endCompaction(ctx: ExtensionContext) {
    await endCompactionLifecycle({
      ctx,
      managerRequest,
      activeCompactionId,
      setLocalCompactingSessionId: (value) => (localCompactingSessionId = value),
      setLocalCompactingUntil: (value) => (localCompactingUntil = value),
      setActiveCompactionId: (value) => (activeCompactionId = value),
      setFooter,
      pumpInputQueue,
    });
  }

  async function guardBranchNavigationWithChecks(ctx: ExtensionContext, op: "tree" | "fork") {
    return guardBranchNavigation({
      ctx,
      op,
      activeTurnLockToken,
      activeTurnLockSessionId,
      managerDownSince,
      setManagerDownSince: (value) => (managerDownSince = value),
      setManagerUnavailableError: (value) => (managerUnavailableError = value),
      probeManagerState,
      triggerManagerAutoHeal,
    });
  }

  async function reissueQueueTicketsForSession(
    sessionId: string,
    nextItems: Array<{ text: string; owner?: string }>,
  ): Promise<boolean> {
    return reissueQueueTickets({
      queue,
      sessionId,
      nextItems,
      enqueueTurnTicket,
      finishTurnTicket,
    });
  }

  pi.registerCommand("steer", {
    description: "Steer current run immediately (bypasses instance-manager queue)",
    handler: async (args, ctx) => {
      await handleSteerCommand({ args, ctx, pi });
    },
  });

  registerQueueCommand({
    pi,
    queue,
    getManagerLockOwner: () => asString(managerLockThisSession?.owner).trim(),
    getAwaitingTurnEnd: () => awaitingTurnEnd,
    getActiveTurnTicketId: () => activeTurnTicketId,
    clearActiveTurnTicketId: () => {
      activeTurnTicketId = "";
    },
    getActiveTurnText: () => activeTurnText,
    finishTurnTicket,
    refreshManagerState,
    reissueQueueTickets: reissueQueueTicketsForSession,
    setFooter,
  });

  registerInstanceManagerEventHooks({
    pi,
    queue,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (value) => {
      currentSessionId = value;
    },
    setLastCtx: (ctx) => {
      lastCtx = ctx;
    },
    setSessionResyncCurrentFile: (value) => {
      sessionResync.currentSessionFile = value;
    },
    resetExternalWriteExpected: () => {
      externalWriteExpectedUntil = 0;
    },
    refreshTrackedSessionFile: (ctx) => {
      refreshTrackedSessionFile(sessionResync, ctx);
    },
    ensurePollTimer: async (ctx) => {
      if (!ctx.hasUI || pollTimer) return;
      await refreshManagerState();
      pollTimer = setInterval(() => {
        void refreshManagerState();
      }, 250);
      pollTimer.unref?.();
    },
    clearPollTimer: () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    },
    clearQueueRetryTimer,
    clearSpinnerTimer: () => {
      if (!spinner.timer) return;
      clearInterval(spinner.timer);
      spinner.timer = null;
    },
    stopTurnLockRenew,
    clearSessionResyncState: () => {
      clearSessionResyncState(sessionResync);
    },
    getActiveTurnTicketId: () => activeTurnTicketId,
    clearActiveTurnTicketId: () => {
      activeTurnTicketId = "";
    },
    finishTurnTicket,
    getActiveCompactionId: () => activeCompactionId,
    endCompactionById: async (compactionId) => {
      try {
        await managerRequest("compaction.end", { compactionId }, 800);
      } catch {
        // ignore
      }
    },
    clearActiveCompactionId: () => {
      activeCompactionId = "";
    },
    releaseTurnLock,
    clearUiState: (ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus("pi-compact", undefined);
      ctx.ui.setStatus("pi-instance-manager", undefined);
      ctx.ui.setWidget("pi-compact-help", undefined, { placement: "belowEditor" });
    },
    beginCompaction,
    endCompaction,
    guardBranchNavigation: guardBranchNavigationWithChecks,
    getActiveTurnLockToken: () => activeTurnLockToken,
    getActiveTurnLockSessionId: () => activeTurnLockSessionId,
    setAwaitingTurnEnd: (value) => {
      awaitingTurnEnd = value;
    },
    refreshManagerState,
    pumpInputQueue,
    setManagerUnavailableError: (value) => {
      managerUnavailableError = value;
    },
    setLastLocalSubmitAt: (value) => {
      lastLocalSubmitAt = value;
    },
    enqueueTurnTicket,
    setFooter,
  });
}
