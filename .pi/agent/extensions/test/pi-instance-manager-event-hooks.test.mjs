import test from "node:test";
import assert from "node:assert/strict";
import { registerInstanceManagerEventHooks } from "../pi-instance-manager/lib/pi-instance-manager-event-hooks.ts";
import { SessionInputQueue } from "../pi-instance-manager/lib/pi-instance-manager-queue.ts";

function setupHooks({ initialSessionId = "", activeTicketId = "", activeCompactionId = "", enqueueError = "" } = {}) {
  const handlers = new Map();
  const queue = new SessionInputQueue();

  let currentSessionId = initialSessionId;
  let managerUnavailableError = "";
  let footerCalls = 0;
  let enqueueCalls = 0;
  let activeTicket = activeTicketId;
  let compactionId = activeCompactionId;

  const counters = {
    setLastCtx: 0,
    resetSessionScopedState: 0,
    refreshTrackedSessionFile: 0,
    refreshManagerState: 0,
    pumpInputQueue: 0,
    clearPollTimer: 0,
    clearQueueRetryTimer: 0,
    clearSpinnerTimer: 0,
    stopTurnLockRenew: 0,
    clearSessionResyncState: 0,
    finishTurnTicket: 0,
    endCompactionById: 0,
    releaseTurnLock: 0,
    clearUiState: 0,
  };

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };

  registerInstanceManagerEventHooks({
    pi,
    queue,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (value) => {
      currentSessionId = value;
    },
    setLastCtx: () => {
      counters.setLastCtx += 1;
    },
    setSessionResyncCurrentFile: () => {},
    resetExternalWriteExpected: () => {},
    refreshTrackedSessionFile: () => {
      counters.refreshTrackedSessionFile += 1;
    },
    resetSessionScopedState: () => {
      counters.resetSessionScopedState += 1;
    },
    ensurePollTimer: async () => {},
    clearPollTimer: () => {
      counters.clearPollTimer += 1;
    },
    clearQueueRetryTimer: () => {
      counters.clearQueueRetryTimer += 1;
    },
    clearSpinnerTimer: () => {
      counters.clearSpinnerTimer += 1;
    },
    stopTurnLockRenew: () => {
      counters.stopTurnLockRenew += 1;
    },
    clearSessionResyncState: () => {
      counters.clearSessionResyncState += 1;
    },
    getActiveTurnTicketId: () => activeTicket,
    clearActiveTurnTicketId: () => {
      activeTicket = "";
    },
    finishTurnTicket: async () => {
      counters.finishTurnTicket += 1;
    },
    getActiveCompactionId: () => compactionId,
    endCompactionById: async () => {
      counters.endCompactionById += 1;
    },
    clearActiveCompactionId: () => {
      compactionId = "";
    },
    releaseTurnLock: async () => {
      counters.releaseTurnLock += 1;
    },
    clearUiState: () => {
      counters.clearUiState += 1;
    },
    beginCompaction: async () => {},
    endCompaction: async () => {},
    guardBranchNavigation: async () => ({ cancel: false }),
    getActiveTurnLockToken: () => "",
    getActiveTurnLockSessionId: () => "",
    setAwaitingTurnEnd: () => {},
    refreshManagerState: async () => {
      counters.refreshManagerState += 1;
    },
    pumpInputQueue: async () => {
      counters.pumpInputQueue += 1;
    },
    setManagerUnavailableError: (value) => {
      managerUnavailableError = value;
    },
    setLastLocalSubmitAt: () => {},
    enqueueTurnTicket: async () => {
      enqueueCalls += 1;
      if (enqueueError) {
        throw new Error(enqueueError);
      }
      return "ticket-1";
    },
    setFooter: () => {
      footerCalls += 1;
    },
  });

  let ctxSessionId = "";
  let ctxSessionFile = "";

  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => ctxSessionId,
      getSessionFile: () => ctxSessionFile,
    },
    ui: {
      setEditorText: () => {},
    },
  };

  return {
    handlers,
    ctx,
    setCtxSession: ({ sessionId = "", sessionFile = "" } = {}) => {
      ctxSessionId = sessionId;
      ctxSessionFile = sessionFile;
    },
    getState: () => ({ currentSessionId, managerUnavailableError, footerCalls, enqueueCalls, counters }),
  };
}

test("input hook ignores extension-origin events", async () => {
  const { handlers, ctx, getState } = setupHooks();
  const input = handlers.get("input");
  assert.equal(typeof input, "function");

  const result = await input({ source: "extension", text: "hello" }, ctx);
  assert.deepEqual(result, { action: "continue" });
  assert.equal(getState().enqueueCalls, 0);
});

test("input hook fail-closes when session id is missing", async () => {
  const { handlers, ctx, getState } = setupHooks({ initialSessionId: "" });
  const input = handlers.get("input");
  assert.equal(typeof input, "function");

  const result = await input({ source: "user", text: "hello" }, ctx);

  assert.deepEqual(result, { action: "handled" });
  assert.equal(getState().managerUnavailableError, "missing sessionId");
  assert.equal(getState().enqueueCalls, 0);
  assert.equal(getState().footerCalls, 1);
});

test("input hook fail-closes when enqueueTurnTicket throws", async () => {
  const { handlers, ctx, getState } = setupHooks({
    initialSessionId: "s-1",
    enqueueError: "manager down",
  });
  const input = handlers.get("input");
  assert.equal(typeof input, "function");

  const result = await input({ source: "user", text: "hello" }, ctx);

  assert.deepEqual(result, { action: "handled" });
  assert.equal(getState().enqueueCalls, 1);
  assert.match(getState().managerUnavailableError, /^enqueue failed: manager down$/);
  assert.equal(getState().footerCalls, 1);
});

test("session_switch resets session-scoped manager state before refresh", async () => {
  const { handlers, ctx, setCtxSession, getState } = setupHooks({ initialSessionId: "old-session" });
  setCtxSession({ sessionId: "new-session", sessionFile: "/tmp/new-session.jsonl" });

  const onSwitch = handlers.get("session_switch");
  assert.equal(typeof onSwitch, "function");

  await onSwitch({}, ctx);

  const { currentSessionId, counters } = getState();
  assert.equal(currentSessionId, "new-session");
  assert.equal(counters.setLastCtx, 1);
  assert.equal(counters.resetSessionScopedState, 1);
  assert.equal(counters.refreshTrackedSessionFile, 1);
  assert.equal(counters.refreshManagerState, 1);
  assert.equal(counters.pumpInputQueue, 1);
});

test("session_fork resets session-scoped manager state for the new fork session", async () => {
  const { handlers, ctx, setCtxSession, getState } = setupHooks({ initialSessionId: "parent-session" });
  setCtxSession({ sessionId: "fork-session", sessionFile: "/tmp/fork-session.jsonl" });

  const onFork = handlers.get("session_fork");
  assert.equal(typeof onFork, "function");

  await onFork({}, ctx);

  const { currentSessionId, counters } = getState();
  assert.equal(currentSessionId, "fork-session");
  assert.equal(counters.setLastCtx, 1);
  assert.equal(counters.resetSessionScopedState, 1);
  assert.equal(counters.refreshTrackedSessionFile, 1);
  assert.equal(counters.refreshManagerState, 1);
  assert.equal(counters.pumpInputQueue, 1);
});

test("session_shutdown clears timers, cancels pending ticket, and clears UI", async () => {
  const { handlers, ctx, getState } = setupHooks({
    activeTicketId: "ticket-1",
    activeCompactionId: "cmp-1",
  });

  const shutdown = handlers.get("session_shutdown");
  assert.equal(typeof shutdown, "function");

  await shutdown({}, ctx);

  const { counters } = getState();
  assert.equal(counters.clearPollTimer, 1);
  assert.equal(counters.clearQueueRetryTimer, 1);
  assert.equal(counters.clearSpinnerTimer, 1);
  assert.equal(counters.stopTurnLockRenew, 1);
  assert.equal(counters.clearSessionResyncState, 1);
  assert.equal(counters.finishTurnTicket, 1);
  assert.equal(counters.endCompactionById, 1);
  assert.equal(counters.releaseTurnLock, 1);
  assert.equal(counters.clearUiState, 1);
});
