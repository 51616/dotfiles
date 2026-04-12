import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetDoNotStopRuntimeStoreForTests,
  getDoNotStopSnapshotForSession,
  getLastActiveDoNotStopSnapshot,
  saveDoNotStopSnapshot,
} from "../do-not-stop/lib/do-not-stop-runtime.ts";

test("do-not-stop runtime store keeps per-session snapshots", () => {
  __resetDoNotStopRuntimeStoreForTests();

  saveDoNotStopSnapshot("session-a", {
    enabled: true,
    repeatTarget: 3,
    pendingRepeats: 2,
    completedRepeats: 1,
  });

  saveDoNotStopSnapshot("session-b", {
    enabled: false,
    repeatTarget: 1,
    pendingRepeats: 0,
    completedRepeats: 0,
  });

  assert.deepEqual(getDoNotStopSnapshotForSession("session-a"), {
    enabled: true,
    repeatTarget: 3,
    pendingRepeats: 2,
    completedRepeats: 1,
  });

  assert.deepEqual(getDoNotStopSnapshotForSession("session-b"), {
    enabled: false,
    repeatTarget: 1,
    pendingRepeats: 0,
    completedRepeats: 0,
  });
});

test("do-not-stop runtime store tracks last active snapshot", () => {
  __resetDoNotStopRuntimeStoreForTests();

  saveDoNotStopSnapshot("", {
    enabled: true,
    repeatTarget: 9,
    pendingRepeats: 4,
    completedRepeats: 5,
  });

  assert.deepEqual(getLastActiveDoNotStopSnapshot(), {
    enabled: true,
    repeatTarget: 9,
    pendingRepeats: 4,
    completedRepeats: 5,
  });
});
