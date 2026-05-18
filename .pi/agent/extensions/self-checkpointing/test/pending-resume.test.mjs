import assert from "node:assert/strict";
import test from "node:test";

import { createPendingResumeController } from "../lib/self-checkpointing-pending-resume.ts";

function createCtx() {
  return {
    sessionManager: { getSessionId: () => "sess-1" },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function createPending() {
  return {
    v: 1,
    checkpointPath: "work/log/checkpoints/remote-only.md",
    resumeText: "resume please",
    createdAt: Date.now(),
    attempts: 0,
    ownerPid: process.pid,
    sessionId: "sess-1",
  };
}

test("pending resume sends without probing checkpoint availability", () => {
  const events = [];
  const pending = createPending();
  const ctx = createCtx();

  const controller = createPendingResumeController({
    pid: process.pid,
    readPending: () => pending,
    writePending: (_ctx, next) => events.push(["writePending", next]),
    clearPending: () => events.push(["clearPending"]),
    sessionIdFor: () => "sess-1",
    getActiveCompactionLock: () => null,
    pushDebug: (_ctx, line) => events.push(["debug", line]),
    sendUserMessage: (text) => events.push(["sendUserMessage", text]),
  });

  const sent = controller.trySend(ctx, "test");

  assert.equal(sent, true);
  assert.deepEqual(events.map(([name]) => name), ["writePending", "debug", "sendUserMessage"]);
  assert.equal(events[2][1], pending.resumeText);
});

test("pending resume takes over a dead owner process for the same session", () => {
  const events = [];
  const pending = {
    ...createPending(),
    ownerPid: 999_999_999,
  };
  const ctx = createCtx();

  const controller = createPendingResumeController({
    pid: process.pid,
    readPending: () => pending,
    writePending: (_ctx, next) => events.push(["writePending", next]),
    clearPending: () => events.push(["clearPending"]),
    sessionIdFor: () => "sess-1",
    getActiveCompactionLock: () => null,
    pushDebug: (_ctx, line) => events.push(["debug", line]),
    sendUserMessage: (text) => events.push(["sendUserMessage", text]),
  });

  const sent = controller.trySend(ctx, "test");

  assert.equal(sent, true);
  assert.equal(events[0][0], "debug");
  assert.match(events[0][1], /taking over pending resume from dead ownerPid=/);
  assert.equal(events[1][0], "writePending");
  assert.equal(events[1][1].ownerPid, process.pid);
  assert.equal(events[2][0], "debug");
  assert.deepEqual(events[3], ["sendUserMessage", pending.resumeText]);
});
