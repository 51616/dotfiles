import test from "node:test";
import assert from "node:assert/strict";
import { createTurnTicketClient } from "../pi-instance-manager/lib/pi-instance-manager-turn-ticket.ts";

test("createTurnTicketClient enqueueTurnTicket returns ticketId and clears error", async () => {
  const retries = [];
  const errors = [];

  const client = createTurnTicketClient({
    managerRequest: async (op, payload) => {
      assert.equal(op, "turn.enqueue");
      assert.equal(payload.sessionId, "s1");
      return { ticketId: "t-1" };
    },
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    ownerPid: 999,
  });

  const ticketId = await client.enqueueTurnTicket("s1", "hello");
  assert.equal(ticketId, "t-1");
  assert.deepEqual(retries, []);
  assert.equal(errors.at(-1), "");
});

test("createTurnTicketClient waitForTurnGrant handles timeout then grant", async () => {
  const retries = [];
  const errors = [];
  let calls = 0;

  const client = createTurnTicketClient({
    managerRequest: async (op) => {
      assert.equal(op, "turn.wait");
      calls += 1;
      if (calls === 1) {
        throw new Error("timeout");
      }
      return { granted: true };
    },
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
    lockWaitTimeoutMs: 3000,
  });

  const result = await client.waitForTurnGrant("ticket-1");
  assert.equal(result.granted, true);
  assert.equal(result.waited, true);
  assert.equal(calls, 2);
  assert.deepEqual(retries, []);
  assert.equal(errors.at(-1), "");
});

test("createTurnTicketClient finishTurnTicket schedules retry on failure", async () => {
  const retries = [];
  const errors = [];

  const client = createTurnTicketClient({
    managerRequest: async () => {
      throw new Error("socket closed");
    },
    setManagerUnavailableError: (message) => {
      errors.push(message);
    },
    scheduleQueueRetry: (ms) => {
      retries.push(ms);
    },
  });

  await client.finishTurnTicket("ticket-1", "turn.cancel");

  assert.equal(retries.at(-1), 1200);
  assert.match(String(errors.at(-1) || ""), /turn\.cancel failed: socket closed/);
});
