import test from "node:test";
import assert from "node:assert/strict";
import { buildQueuePopupRows } from "../pi-instance-manager/lib/pi-instance-manager-queue-rows.ts";

test("buildQueuePopupRows includes running row when awaiting turn end", () => {
  const rows = buildQueuePopupRows({
    managerLockOwner: "",
    awaitingTurnEnd: true,
    activeTurnText: "Current answer in progress",
    queued: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "running");
  assert.equal(rows[0]?.label, "Current assistant turn");
  assert.equal(rows[0]?.text, "Current answer in progress");
});

test("buildQueuePopupRows falls back to manager lock owner when no active text", () => {
  const rows = buildQueuePopupRows({
    managerLockOwner: "pi-discord-bot:prompt:session=abc",
    awaitingTurnEnd: false,
    activeTurnText: "",
    queued: [],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "running");
  assert.match(rows[0]?.text ?? "", /^pi-discord-bot:prompt:session=abc/);
});

test("buildQueuePopupRows appends queued rows in stable order", () => {
  const rows = buildQueuePopupRows({
    managerLockOwner: "",
    awaitingTurnEnd: false,
    activeTurnText: "",
    queued: [
      { ticketId: "t-1", text: "first" },
      { ticketId: "t-2", text: "second" },
    ],
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.kind), ["queued", "queued"]);
  assert.deepEqual(rows.map((row) => row.label), ["Queued #1", "Queued #2"]);
  assert.deepEqual(rows.map((row) => row.ticketId), ["t-1", "t-2"]);
});
