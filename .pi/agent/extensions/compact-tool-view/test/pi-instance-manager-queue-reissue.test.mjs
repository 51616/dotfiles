import test from "node:test";
import assert from "node:assert/strict";
import { SessionInputQueue } from "../pi-instance-manager/lib/pi-instance-manager-queue.ts";
import { reissueQueueTickets } from "../pi-instance-manager/lib/pi-instance-manager-queue-reissue.ts";

test("reissueQueueTickets replaces queue entries when all ticket reissues succeed", async () => {
  const queue = new SessionInputQueue();
  queue.enqueue("s1", { ticketId: "old-1", text: "old", queuedAt: 1, owner: "o1" });

  const finished = [];
  const result = await reissueQueueTickets({
    queue,
    sessionId: "s1",
    nextItems: [
      { text: "new-a", owner: "o2" },
      { text: "new-b" },
    ],
    enqueueTurnTicket: async (_sid, text) => `ticket-${text}`,
    finishTurnTicket: async (ticketId, op) => {
      finished.push({ ticketId, op });
    },
    nowMs: () => 123,
  });

  assert.equal(result, true);
  assert.deepEqual(finished, [{ ticketId: "old-1", op: "turn.cancel" }]);
  assert.deepEqual(queue.list("s1"), [
    { ticketId: "ticket-new-a", text: "new-a", queuedAt: 123, owner: "o2" },
    { ticketId: "ticket-new-b", text: "new-b", queuedAt: 123, owner: undefined },
  ]);
});

test("reissueQueueTickets cancels rebuilt tickets and keeps old queue on partial failure", async () => {
  const queue = new SessionInputQueue();
  queue.enqueue("s1", { ticketId: "old-1", text: "old", queuedAt: 1, owner: "o1" });

  const finished = [];
  const result = await reissueQueueTickets({
    queue,
    sessionId: "s1",
    nextItems: [{ text: "new-a" }, { text: "new-b" }],
    enqueueTurnTicket: async (_sid, text) => (text === "new-a" ? "ticket-a" : ""),
    finishTurnTicket: async (ticketId, op) => {
      finished.push({ ticketId, op });
    },
    nowMs: () => 123,
  });

  assert.equal(result, false);
  assert.deepEqual(finished, [{ ticketId: "ticket-a", op: "turn.cancel" }]);
  assert.deepEqual(queue.list("s1"), [{ ticketId: "old-1", text: "old", queuedAt: 1, owner: "o1" }]);
});
