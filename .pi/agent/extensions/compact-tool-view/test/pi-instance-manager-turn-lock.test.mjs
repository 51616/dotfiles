import test from "node:test";
import assert from "node:assert/strict";
import { createTurnLockController } from "../pi-instance-manager/lib/pi-instance-manager-turn-lock.ts";

test("createTurnLockController acquireTurnLock sets token/session on success", async () => {
  let activeToken = "";
  let activeSessionId = "";
  const retries = [];
  const errors = [];
  const awaitingValues = [];

  const controller = createTurnLockController({
    managerRequest: async (op) => {
      assert.equal(op, "lock.acquire");
      return { token: "lock-1" };
    },
    getActiveTurnLockToken: () => activeToken,
    setActiveTurnLockToken: (value) => {
      activeToken = value;
    },
    getActiveTurnLockSessionId: () => activeSessionId,
    setActiveTurnLockSessionId: (value) => {
      activeSessionId = value;
    },
    setAwaitingTurnEnd: (value) => {
      awaitingValues.push(value);
    },
    clearActiveTurnText: () => {},
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    onRenewAttemptFinished: () => {},
    turnLockRenewMs: 60_000,
  });

  const result = await controller.acquireTurnLock("s1");
  assert.equal(result.token, "lock-1");
  assert.equal(result.waited, false);
  assert.equal(activeToken, "lock-1");
  assert.equal(activeSessionId, "s1");
  assert.deepEqual(retries, []);
  assert.equal(errors.at(-1), "");
  assert.deepEqual(awaitingValues, []);

  controller.stopTurnLockRenew();
});

test("createTurnLockController releaseTurnLock clears local state and retries on release failure", async () => {
  let activeToken = "lock-2";
  let activeSessionId = "s2";
  let activeText = "hello";
  let awaitingTurnEnd = true;
  const retries = [];
  const errors = [];

  const controller = createTurnLockController({
    managerRequest: async () => {
      throw new Error("socket closed");
    },
    getActiveTurnLockToken: () => activeToken,
    setActiveTurnLockToken: (value) => {
      activeToken = value;
    },
    getActiveTurnLockSessionId: () => activeSessionId,
    setActiveTurnLockSessionId: (value) => {
      activeSessionId = value;
    },
    setAwaitingTurnEnd: (value) => {
      awaitingTurnEnd = value;
    },
    clearActiveTurnText: () => {
      activeText = "";
    },
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    onRenewAttemptFinished: () => {},
  });

  await controller.releaseTurnLock();

  assert.equal(activeToken, "");
  assert.equal(activeSessionId, "");
  assert.equal(activeText, "");
  assert.equal(awaitingTurnEnd, false);
  assert.equal(retries.at(-1), 1200);
  assert.match(String(errors.at(-1) || ""), /lock\.release failed: socket closed/);
});

test("createTurnLockController acquireTurnLock times out and schedules retry", async () => {
  let activeToken = "";
  let activeSessionId = "";
  const retries = [];
  const errors = [];

  const controller = createTurnLockController({
    managerRequest: async () => {
      throw new Error("timeout");
    },
    getActiveTurnLockToken: () => activeToken,
    setActiveTurnLockToken: (value) => {
      activeToken = value;
    },
    getActiveTurnLockSessionId: () => activeSessionId,
    setActiveTurnLockSessionId: (value) => {
      activeSessionId = value;
    },
    setAwaitingTurnEnd: () => {},
    clearActiveTurnText: () => {},
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    onRenewAttemptFinished: () => {},
    lockWaitTimeoutMs: 5,
  });

  const result = await controller.acquireTurnLock("s1");

  assert.equal(result.token, "");
  assert.equal(result.waited, true);
  assert.equal(retries.at(-1), 1500);
  assert.match(String(errors.at(-1) || ""), /lock\.acquire timed out/);
});
