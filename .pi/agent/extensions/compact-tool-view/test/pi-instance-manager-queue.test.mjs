import test from "node:test";
import assert from "node:assert/strict";
import { SessionInputQueue } from "../pi-instance-manager/lib/pi-instance-manager-queue.ts";

test("SessionInputQueue: enqueue/shift lifecycle", () => {
  const q = new SessionInputQueue();
  const sid = "sess-a";

  q.enqueue(sid, { ticketId: "t1", text: "one", queuedAt: 1 });
  q.enqueue(sid, { ticketId: "t2", text: "two", queuedAt: 2 });

  assert.equal(q.list(sid).length, 2);
  assert.equal(q.shift(sid)?.ticketId, "t1");
  assert.equal(q.shift(sid)?.ticketId, "t2");
  assert.equal(q.shift(sid), null);
});

test("SessionInputQueue: list() is immutable from caller side", () => {
  const q = new SessionInputQueue();
  const sid = "sess-b";

  q.enqueue(sid, { ticketId: "a", text: "A", queuedAt: 1 });
  const listed = q.list(sid);
  listed.push({ ticketId: "x", text: "X", queuedAt: 9 });

  assert.deepEqual(
    q.list(sid).map((it) => it.ticketId),
    ["a"],
  );
});

test("SessionInputQueue: remove/unshift/replace by lifecycle", () => {
  const q = new SessionInputQueue();
  const sid = "sess-c";

  q.enqueue(sid, { ticketId: "a", text: "A", queuedAt: 1 });
  q.enqueue(sid, { ticketId: "b", text: "B", queuedAt: 2 });
  q.enqueue(sid, { ticketId: "c", text: "C", queuedAt: 3 });

  assert.equal(q.removeByTicket(sid, "b")?.ticketId, "b");
  assert.deepEqual(
    q.list(sid).map((it) => it.ticketId),
    ["a", "c"],
  );

  q.unshift(sid, { ticketId: "z", text: "Z", queuedAt: 0 });
  assert.deepEqual(
    q.list(sid).map((it) => it.ticketId),
    ["z", "a", "c"],
  );

  q.replace(sid, [{ ticketId: "r1", text: "R1", queuedAt: 11 }]);
  assert.deepEqual(
    q.list(sid).map((it) => it.ticketId),
    ["r1"],
  );
});

test("SessionInputQueue: dedupes by ticket id across enqueue/unshift/replace", () => {
  const q = new SessionInputQueue();
  const sid = "sess-d";

  q.enqueue(sid, { ticketId: " a ", text: "A1", queuedAt: 1 });
  q.enqueue(sid, { ticketId: "a", text: "A2", queuedAt: 2 });
  assert.deepEqual(
    q.list(sid).map((it) => [it.ticketId, it.text]),
    [["a", "A2"]],
  );

  q.enqueue(sid, { ticketId: "b", text: "B", queuedAt: 3 });
  q.unshift(sid, { ticketId: "b", text: "B2", queuedAt: 4 });
  assert.deepEqual(
    q.list(sid).map((it) => [it.ticketId, it.text]),
    [["b", "B2"], ["a", "A2"]],
  );

  q.replace(sid, [
    { ticketId: "x", text: "X1", queuedAt: 10 },
    { ticketId: "x", text: "X2", queuedAt: 11 },
    { ticketId: " ", text: "bad", queuedAt: 12 },
    { ticketId: "y", text: "Y", queuedAt: 13 },
  ]);

  assert.deepEqual(
    q.list(sid).map((it) => [it.ticketId, it.text]),
    [["x", "X1"], ["y", "Y"]],
  );
});
