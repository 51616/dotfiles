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
    setLastCtx: () => {},
    setSessionResyncCurrentFile: () => {},
    resetExternalWriteExpected: () => {},
    refreshTrackedSessionFile: () => {},
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
    refreshManagerState: async () => {},
    pumpInputQueue: async () => {},
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

  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "",
      getSessionFile: () => "",
    },
    ui: {
      setEditorText: () => {},
    },
  };

  return {
    handlers,
    ctx,
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
