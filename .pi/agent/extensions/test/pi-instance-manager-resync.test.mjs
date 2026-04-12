import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createSessionResyncState,
  maybeRunPendingSessionResync,
  noteSessionFileMutation,
} from "../pi-instance-manager/lib/pi-instance-manager-resync.ts";

function makeCtx({ idle = true, onSwitch } = {}) {
  return {
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => "/tmp/current-session.jsonl",
    },
    switchSession: async (sessionPath) => {
      if (onSwitch) await onSwitch(sessionPath);
      return { cancelled: false };
    },
  };
}

test("maybeRunPendingSessionResync: no-op while local turn lock is still active", async () => {
  const state = createSessionResyncState();
  state.pendingSessionResync = true;
  state.trackedSessionFile = "/tmp/session-a.jsonl";

  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeRunPendingSessionResync({
    state,
    ctx,
    currentSessionId: "session-a",
    activeTurnLockToken: "tok-1",
    activeTurnLockSessionId: "session-a",
    queueDepth: 0,
    compacting: false,
  });

  assert.equal(calls.length, 0);
  assert.equal(state.pendingSessionResync, true);
});

test("maybeRunPendingSessionResync: switches when pending and safe", async () => {
  const state = createSessionResyncState();
  state.pendingSessionResync = true;
  state.trackedSessionFile = "/tmp/session-b.jsonl";

  const calls = [];
  const ctx = makeCtx({ onSwitch: async (path) => calls.push(path) });

  await maybeRunPendingSessionResync({
    state,
    ctx,
    currentSessionId: "session-b",
    activeTurnLockToken: "",
    activeTurnLockSessionId: "",
    queueDepth: 0,
    compacting: false,
  });

  assert.deepEqual(calls, ["/tmp/session-b.jsonl"]);
  assert.equal(state.pendingSessionResync, false);
  assert.ok(state.lastSessionResyncAt > 0);
});

test("noteSessionFileMutation: forcePendingResync overrides local-submit grace window", () => {
  const state = createSessionResyncState();
  const tmp = path.join(os.tmpdir(), `pi-session-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(tmp, "{}\n", "utf8");

  state.trackedSessionFile = tmp;
  state.trackedSessionFileMtimeMs = fs.statSync(tmp).mtimeMs;

  // Simulate local submit just happened; normal path should suppress pending marker.
  const lastLocalSubmitAt = Date.now();
  fs.appendFileSync(tmp, "{\"x\":1}\n", "utf8");
  state.trackedSessionFileMtimeMs = 0;
  noteSessionFileMutation(state, lastLocalSubmitAt, false);
  assert.equal(state.pendingSessionResync, false);

  // With force flag enabled (active Discord write window), mutation must mark pending.
  state.pendingSessionResync = false;
  fs.appendFileSync(tmp, "{\"x\":2}\n", "utf8");
  state.trackedSessionFileMtimeMs = 0;
  noteSessionFileMutation(state, lastLocalSubmitAt, true);
  assert.equal(state.pendingSessionResync, true);

  fs.unlinkSync(tmp);
});
