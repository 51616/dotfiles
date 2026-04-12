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

test("pending resume uses injected checkpoint availability for ssh-backed checkpoints", () => {
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
    isCheckpointAvailable: (checkpointPath) => {
      events.push(["isCheckpointAvailable", checkpointPath]);
      return checkpointPath === pending.checkpointPath;
    },
    pushDebug: (_ctx, line) => events.push(["debug", line]),
    sendUserMessage: (text) => events.push(["sendUserMessage", text]),
  });

  const sent = controller.trySend(ctx, "test");

  assert.equal(sent, true);
  assert.deepEqual(events.map(([name]) => name), [
    "isCheckpointAvailable",
    "writePending",
    "debug",
    "sendUserMessage",
  ]);
  assert.equal(events[3][1], pending.resumeText);
});

test("pending resume clears state when checkpoint is unavailable", () => {
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
    isCheckpointAvailable: (checkpointPath) => {
      events.push(["isCheckpointAvailable", checkpointPath]);
      return false;
    },
    pushDebug: (_ctx, line) => events.push(["debug", line]),
    sendUserMessage: (text) => events.push(["sendUserMessage", text]),
  });

  const sent = controller.trySend(ctx, "test");

  assert.equal(sent, false);
  assert.deepEqual(events, [
    ["isCheckpointAvailable", pending.checkpointPath],
    ["debug", `stale pending resume: missing checkpoint file (${pending.checkpointPath}); clearing`],
    ["clearPending"],
  ]);
});
