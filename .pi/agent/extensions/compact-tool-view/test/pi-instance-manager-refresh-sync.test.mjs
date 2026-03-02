import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSessionResyncState } from "../pi-instance-manager/lib/pi-instance-manager-resync.ts";
import { syncSessionResyncAfterStateRefresh } from "../pi-instance-manager/lib/pi-instance-manager-refresh-sync.ts";

function makeCtx({ idle = true, onSwitch } = {}) {
  return {
    isIdle: () => idle,
    sessionManager: {
      getSessionFile: () => "/tmp/current-session.jsonl",
      getSessionId: () => "session-test",
    },
    switchSession: async (sessionPath) => {
      if (onSwitch) await onSwitch(sessionPath);
      return { cancelled: false };
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      setEditorText: () => {},
    },
    hasUI: false,
  };
}

function writeTmpSessionFile(prefix = "pi-session") {
  const tmp = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(tmp, "{\"start\":true}\n", "utf8");
  return tmp;
}

test("syncSessionResyncAfterStateRefresh: does not arm pending resync for local-only session file mutations", async () => {
  const sessionFile = writeTmpSessionFile("pi-local-only");

  const sessionResync = createSessionResyncState();
  sessionResync.trackedSessionFile = sessionFile;
  sessionResync.currentSessionFile = sessionFile;

  const before = fs.statSync(sessionFile);
  sessionResync.trackedSessionFileMtimeMs = before.mtimeMs;
  sessionResync.trackedSessionFileSizeBytes = before.size;

  // Mutate file (simulates local TUI commands like /model writing to the session file).
  fs.appendFileSync(sessionFile, "{\"local\":1}\n", "utf8");

  const switched = [];
  const ctx = makeCtx({ onSwitch: async (p) => switched.push(p) });

  let externalWriteExpectedUntil = 0;

  await syncSessionResyncAfterStateRefresh({
    ctx,
    sid: "session-test",
    previousLock: null,
    nextLock: null,
    sessionResync,
    // Old local submit time would normally allow noteSessionFileMutation to arm resync,
    // but with the new gating it should not even run.
    lastLocalSubmitAt: 0,
    externalWriteExpectedUntil,
    setExternalWriteExpectedUntil: (v) => (externalWriteExpectedUntil = v),
    activeTurnLockToken: "",
    activeTurnLockSessionId: "",
    queueDrainInFlight: false,
    queueDepth: 0,
    compacting: false,
    hasActiveSessionLock: false,
  });

  assert.equal(sessionResync.pendingSessionResync, false);
  assert.deepEqual(switched, []);

  fs.unlinkSync(sessionFile);
});

test("syncSessionResyncAfterStateRefresh: arms + runs pending resync when Discord lock is observed", async () => {
  const sessionFile = writeTmpSessionFile("pi-discord-write");

  const sessionResync = createSessionResyncState();
  sessionResync.trackedSessionFile = sessionFile;
  sessionResync.currentSessionFile = sessionFile;

  const before = fs.statSync(sessionFile);
  sessionResync.trackedSessionFileMtimeMs = before.mtimeMs;
  sessionResync.trackedSessionFileSizeBytes = before.size;

  // Mutate file (simulates external writer).
  fs.appendFileSync(sessionFile, "{\"discord\":1}\n", "utf8");

  const switched = [];
  const ctx = makeCtx({ onSwitch: async (p) => switched.push(p) });

  let externalWriteExpectedUntil = 0;

  await syncSessionResyncAfterStateRefresh({
    ctx,
    sid: "session-test",
    previousLock: null,
    // Make sawDiscordLock true without triggering maybeResumeAfterDiscordTurn (it checks previousLock.owner).
    nextLock: { owner: "pi-discord-bot:prompt:pid=1:user=u:session=s", token: "tok" },
    sessionResync,
    lastLocalSubmitAt: 0,
    externalWriteExpectedUntil,
    setExternalWriteExpectedUntil: (v) => (externalWriteExpectedUntil = v),
    activeTurnLockToken: "",
    activeTurnLockSessionId: "",
    queueDrainInFlight: false,
    queueDepth: 0,
    compacting: false,
    hasActiveSessionLock: false,
  });

  assert.deepEqual(switched, [sessionFile]);
  assert.equal(sessionResync.pendingSessionResync, false);

  fs.unlinkSync(sessionFile);
});
