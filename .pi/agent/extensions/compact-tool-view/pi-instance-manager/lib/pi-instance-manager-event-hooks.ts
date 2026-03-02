import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";
import { type SessionInputQueue } from "./pi-instance-manager-queue.ts";

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
  ensurePollTimer,
  clearPollTimer,
  clearQueueRetryTimer,
  clearSpinnerTimer,
  stopTurnLockRenew,
  clearSessionResyncState,
  getActiveTurnTicketId,
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
  setLastLocalSubmitAt,
  enqueueTurnTicket,
  setFooter,
}: {
  pi: ExtensionAPI;
  queue: SessionInputQueue;
  getCurrentSessionId: () => string;
  setCurrentSessionId: (value: string) => void;
  setLastCtx: (ctx: ExtensionContext) => void;
  setSessionResyncCurrentFile: (value: string) => void;
  resetExternalWriteExpected: () => void;
  refreshTrackedSessionFile: (ctx: ExtensionContext) => void;
  ensurePollTimer: (ctx: ExtensionContext) => Promise<void>;
  clearPollTimer: () => void;
  clearQueueRetryTimer: () => void;
  clearSpinnerTimer: () => void;
  stopTurnLockRenew: () => void;
  clearSessionResyncState: () => void;
  getActiveTurnTicketId: () => string;
  clearActiveTurnTicketId: () => void;
  finishTurnTicket: (ticketId: string, op: QueueAction) => Promise<void>;
  getActiveCompactionId: () => string;
  endCompactionById: (compactionId: string) => Promise<void>;
  clearActiveCompactionId: () => void;
  releaseTurnLock: () => Promise<void>;
  clearUiState: (ctx: ExtensionContext) => void;
  beginCompaction: (ctx: ExtensionContext) => Promise<void>;
  endCompaction: (ctx: ExtensionContext) => Promise<void>;
  guardBranchNavigation: (ctx: ExtensionContext, op: "tree" | "fork") => Promise<{ cancel: boolean }>;
  getActiveTurnLockToken: () => string;
  getActiveTurnLockSessionId: () => string;
  setAwaitingTurnEnd: (value: boolean) => void;
  refreshManagerState: () => Promise<void>;
  pumpInputQueue: (ctx: ExtensionContext) => Promise<void>;
  setManagerUnavailableError: (value: string) => void;
  setLastLocalSubmitAt: (value: number) => void;
  enqueueTurnTicket: (sessionId: string, text: string) => Promise<string>;
  setFooter: (ctx: ExtensionContext) => void;
}) {
  pi.on("session_start", async (_event, ctx) => {
    setLastCtx(ctx);
    setCurrentSessionId(asString(ctx.sessionManager.getSessionId()).trim());
    resetExternalWriteExpected();
    refreshTrackedSessionFile(ctx);

    await ensurePollTimer(ctx);
    await pumpInputQueue(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    setCurrentSessionId(asString(ctx.sessionManager.getSessionId()).trim());
    resetExternalWriteExpected();
    refreshTrackedSessionFile(ctx);
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearPollTimer();
    clearQueueRetryTimer();
    clearSpinnerTimer();
    stopTurnLockRenew();
    resetExternalWriteExpected();
    clearSessionResyncState();

    const activeTicketId = getActiveTurnTicketId();
    if (activeTicketId) {
      await finishTurnTicket(activeTicketId, "turn.cancel");
      clearActiveTurnTicketId();
    }

    const compactionId = getActiveCompactionId();
    if (compactionId) {
      await endCompactionById(compactionId);
      clearActiveCompactionId();
    }

    await releaseTurnLock();
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

  pi.on("session_before_fork", async (_event, ctx) => {
    return guardBranchNavigation(ctx, "fork");
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
    clearActiveTurnTicketId();
    if (finishedTicketId) {
      await finishTurnTicket(finishedTicketId, "turn.done");
    }
    await releaseTurnLock();
    await refreshManagerState();
    await pumpInputQueue(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

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

      const ticketId = await enqueueTurnTicket(sid, event.text);
      if (!ticketId) {
        if (ctx.hasUI) setFooter(ctx);
        return { action: "handled" };
      }

      queue.enqueue(sid, {
        ticketId,
        text: event.text,
        queuedAt: Date.now(),
        owner: `pi-tui:prompt:pid=${process.pid}:session=${sid}`,
      });

      if (ctx.hasUI) {
        ctx.ui.setEditorText("");
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
