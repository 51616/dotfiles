import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countRemoteQueuedTurns,
  findSessionLock,
  isSessionCompacting,
  toLocalTicketIdSet,
} from "../pi-instance-manager/lib/pi-instance-manager-state.ts";

test("isSessionCompacting matches by sessionId", () => {
  const state = {
    activeCompactions: [{ sessionId: "a" }, { sessionId: "b" }],
  };

  assert.equal(isSessionCompacting(state, "b"), true);
  assert.equal(isSessionCompacting(state, "c"), false);
  assert.equal(isSessionCompacting(state, ""), false);
  assert.equal(isSessionCompacting(null, "a"), false);
});

test("findSessionLock returns matching lock", () => {
  const lockA = { sessionId: "a", owner: "owner-a", token: "tok-a" };
  const lockB = { sessionId: "b", owner: "owner-b", token: "tok-b" };
  const state = {
    activeLocks: [lockA, lockB],
  };

  assert.deepEqual(findSessionLock(state, "b"), lockB);
  assert.equal(findSessionLock(state, "missing"), null);
  assert.equal(findSessionLock(state, ""), null);
});

test("toLocalTicketIdSet trims and filters empty ids", () => {
  const ids = toLocalTicketIdSet([
    { ticketId: " t1 " },
    { ticketId: "" },
    { ticketId: "t2" },
    {},
  ]);

  assert.deepEqual(Array.from(ids).sort(), ["t1", "t2"]);
});

test("countRemoteQueuedTurns excludes local, non-queued, and invalid tickets", () => {
  const state = {
    turnQueues: [
      {
        sessionId: "s1",
        items: [
          { ticketId: "l1", state: "queued" },
          { ticketId: "r1", state: "queued" },
          { ticketId: "r2", state: "queued" },
          { ticketId: "g1", state: "granted" },
          { ticketId: "", state: "queued" },
          { state: "queued" },
        ],
      },
      {
        sessionId: "s2",
        items: [{ ticketId: "x", state: "queued" }],
      },
    ],
  };

  const local = new Set(["l1"]);
  assert.equal(countRemoteQueuedTurns(state, "s1", local), 2);
  assert.equal(countRemoteQueuedTurns(state, "s2", local), 1);
  assert.equal(countRemoteQueuedTurns(state, "missing", local), 0);
  assert.equal(countRemoteQueuedTurns(null, "s1", local), 0);
});
