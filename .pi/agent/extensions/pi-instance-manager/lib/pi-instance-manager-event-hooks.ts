import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";
import { buildQueueToastMessage, type SessionInputQueue } from "./pi-instance-manager-queue.ts";

type QueueAction = "turn.cancel" | "turn.done";

export function registerInstanceManagerEventHooks({
  pi,
  queue,
  getCurrentSessionId,
  setCurrentSessionId,
  setLastCtx,
  setSessionResyncCurrentFile,
  resetExternalWriteExpected,
  refreshTrackedSessionFile,
  resetSessionScopedState,
  ensurePollTimer,
  clearPollTimer,
  clearQueueRetryTimer,
  clearSpinnerTimer,
  stopTurnLockRenew,
  stopTuiWriterRenew,
  releaseTuiWriterLease,
  clearSessionResyncState,
  getActiveTurnTicketId,
  getActiveTurnTicketFencingToken,
  clearActiveTurnTicketId,
  finishTurnTicket,
  getActiveCompactionId,
  endCompactionById,
  clearActiveCompactionId,
  releaseTurnLock,
  clearUiState,
  beginCompaction,
  endCompaction,
  guardBranchNavigation,
  getActiveTurnLockToken,
  getActiveTurnLockSessionId,
  setAwaitingTurnEnd,
  refreshManagerState,
  pumpInputQueue,
  setManagerUnavailableError,
  getManagerUnavailableError,
  setLastLocalSubmitAt,
  enqueueTurnTicket,
  getTuiPromptOwner,
  setFooter,
  expandQueuedCommandText,
}: {
  pi: ExtensionAPI;
  queue: SessionInputQueue;
  getCurrentSessionId: () => string;
  setCurrentSessionId: (value: string) => void;
  setLastCtx: (ctx: ExtensionContext) => void;
  setSessionResyncCurrentFile: (value: string) => void;
  resetExternalWriteExpected: () => void;
  refreshTrackedSessionFile: (ctx: ExtensionContext) => void;
  resetSessionScopedState: (ctx: ExtensionContext) => void;
  ensurePollTimer: (ctx: ExtensionContext) => Promise<void>;
  clearPollTimer: () => void;
  clearQueueRetryTimer: () => void;
  clearSpinnerTimer: () => void;
  stopTurnLockRenew: () => void;
  stopTuiWriterRenew: () => void;
  releaseTuiWriterLease: () => Promise<void>;
  clearSessionResyncState: () => void;
  getActiveTurnTicketId: () => string;
  getActiveTurnTicketFencingToken: () => string;
  clearActiveTurnTicketId: () => void;
  finishTurnTicket: (ticketId: string, op: QueueAction, fencingToken?: string) => Promise<void>;
  getActiveCompactionId: () => string;
  endCompactionById: (compactionId: string) => Promise<void>;
  clearActiveCompactionId: () => void;
  releaseTurnLock: () => Promise<void>;
  clearUiState: (ctx: ExtensionContext) => void;
  beginCompaction: (ctx: ExtensionContext) => Promise<void>;
  endCompaction: (ctx: ExtensionContext) => Promise<void>;
  guardBranchNavigation: (ctx: ExtensionContext, op: "tree" | "fork" | "clone") => Promise<{ cancel: boolean }>;
  getActiveTurnLockToken: () => string;
  getActiveTurnLockSessionId: () => string;
  setAwaitingTurnEnd: (value: boolean) => void;
  refreshManagerState: () => Promise<void>;
  pumpInputQueue: (ctx: ExtensionContext) => Promise<void>;
  setManagerUnavailableError: (value: string) => void;
  getManagerUnavailableError?: () => string;
  setLastLocalSubmitAt: (value: number) => void;
  enqueueTurnTicket: (
    sessionId: string,
    text: string,
  ) => Promise<{ ticketId: string; fencingToken: string; managerGeneration: number } | null>;
  getTuiPromptOwner: (sessionId: string) => string;
  setFooter: (ctx: ExtensionContext) => void;
  expandQueuedCommandText: (text: string) => string;
}) {
  pi.on("session_start", async (_event, ctx) => {
    setLastCtx(ctx);
    setCurrentSessionId(asString(ctx.sessionManager.getSessionId()).trim());
    resetExternalWriteExpected();
    resetSessionScopedState(ctx);
    refreshTrackedSessionFile(ctx);

    await ensurePollTimer(ctx);
    await pumpInputQueue(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    setLastCtx(ctx);
    setCurrentSessionId(asString(ctx.sessionManager.getSessionId()).trim());
    resetExternalWriteExpected();
    resetSessionScopedState(ctx);
    refreshTrackedSessionFile(ctx);
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    setLastCtx(ctx);
    setCurrentSessionId(asString(ctx.sessionManager.getSessionId()).trim());
    resetExternalWriteExpected();
    resetSessionScopedState(ctx);
    refreshTrackedSessionFile(ctx);
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPollTimer();
    clearQueueRetryTimer();
    clearSpinnerTimer();
    stopTurnLockRenew();
    stopTuiWriterRenew();
    resetExternalWriteExpected();
    clearSessionResyncState();

    const activeTicketId = getActiveTurnTicketId();
    if (activeTicketId) {
      await finishTurnTicket(activeTicketId, "turn.cancel", getActiveTurnTicketFencingToken());
      clearActiveTurnTicketId();
    }

    const compactionId = getActiveCompactionId();
    if (compactionId) {
      await endCompactionById(compactionId);
      clearActiveCompactionId();
    }

    await releaseTurnLock();
    await releaseTuiWriterLease();
    clearUiState(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    await beginCompaction(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await endCompaction(ctx);
  });

  pi.on("session_before_tree", async (_event, ctx) => {
    return guardBranchNavigation(ctx, "tree");
  });

  pi.on("session_before_fork", async (event, ctx) => {
    return guardBranchNavigation(ctx, event?.position === "at" ? "clone" : "fork");
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (getActiveTurnLockToken() && getActiveTurnLockSessionId() === getCurrentSessionId()) {
      setAwaitingTurnEnd(true);
    }
    if (ctx.hasUI) setFooter(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // turn_end can fire between tool-call subturns. Keep lock/spinner active until agent_end.
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const finishedTicketId = getActiveTurnTicketId();
    const finishedTicketFence = getActiveTurnTicketFencingToken();
    clearActiveTurnTicketId();
    if (finishedTicketId) {
      await finishTurnTicket(finishedTicketId, "turn.done", finishedTicketFence);
    }
    await releaseTurnLock();
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!ctx.hasUI) return { action: "continue" };

    const sid = getCurrentSessionId() || asString(ctx.sessionManager.getSessionId()).trim();
    setCurrentSessionId(sid);
    setSessionResyncCurrentFile(asString(ctx.sessionManager.getSessionFile()).trim());

    if (!sid) {
      setManagerUnavailableError("missing sessionId");
      if (ctx.hasUI) setFooter(ctx);
      return { action: "handled" };
    }

    try {
      setLastLocalSubmitAt(Date.now());

      const queuedText = expandQueuedCommandText(event.text) || event.text;
      const ticket = await enqueueTurnTicket(sid, queuedText);
      if (!ticket) {
        if (ctx.hasUI) {
          const reason = asString(getManagerUnavailableError?.()).trim() || "manager rejected the queued turn";
          ctx.ui.setEditorText(event.text);
          ctx.ui.notify(`Input was not queued: ${reason}\nYour text was restored to the editor.`, "warning");
          setFooter(ctx);
        }
        return { action: "handled" };
      }

      queue.enqueue(sid, {
        ticketId: ticket.ticketId,
        fencingToken: ticket.fencingToken,
        managerGeneration: ticket.managerGeneration,
        text: queuedText,
        queuedAt: Date.now(),
        owner: getTuiPromptOwner(sid),
      });

      if (ctx.hasUI) {
        ctx.ui.setEditorText("");
        const queueToast = buildQueueToastMessage(queue.list(sid));
        if (queueToast) ctx.ui.notify(queueToast, "info");
        setFooter(ctx);
      }

      await pumpInputQueue(ctx);
      return { action: "handled" };
    } catch (error) {
      setManagerUnavailableError(`enqueue failed: ${asString(error instanceof Error ? error.message : error)}`);
      if (ctx.hasUI) setFooter(ctx);
      return { action: "handled" };
    }
  });
}
