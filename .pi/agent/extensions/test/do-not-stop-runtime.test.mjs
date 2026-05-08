import test from "node:test";
import assert from "node:assert/strict";
import { createGoal } from "../do-not-stop/lib/do-not-stop-state.ts";
import {
  __resetDoNotStopRuntimeStoreForTests,
  getDoNotStopGoalSnapshotForSession,
  getLastDoNotStopGoalSnapshot,
  isLegacyRepeatSnapshot,
  saveDoNotStopGoalSnapshot,
  snapshotFromSessionBranch,
} from "../do-not-stop/lib/do-not-stop-runtime.ts";
import { DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE } from "../do-not-stop/lib/do-not-stop.ts";

test("do-not-stop runtime store keeps per-session goal snapshots", () => {
  __resetDoNotStopRuntimeStoreForTests();
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  const goalB = createGoal("finish b", { goalId: "b", nowMs: 2000 });

  saveDoNotStopGoalSnapshot("session-a", goalA);
  saveDoNotStopGoalSnapshot("session-b", goalB);

  assert.deepEqual(getDoNotStopGoalSnapshotForSession("session-a"), goalA);
  assert.deepEqual(getDoNotStopGoalSnapshotForSession("session-b"), goalB);
  assert.deepEqual(getLastDoNotStopGoalSnapshot(), goalB);
});

test("saving null clears a session goal snapshot", () => {
  __resetDoNotStopRuntimeStoreForTests();
  saveDoNotStopGoalSnapshot("session-a", createGoal("finish a", { goalId: "a", nowMs: 1000 }));
  saveDoNotStopGoalSnapshot("session-a", null);
  assert.equal(getDoNotStopGoalSnapshotForSession("session-a"), null);
});

test("snapshotFromSessionBranch reconstructs the latest goal state entry", () => {
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  const goalB = createGoal("finish b", { goalId: "b", nowMs: 2000 });

  assert.deepEqual(
    snapshotFromSessionBranch([
      { type: "custom", customType: DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, data: { goal: goalA } },
      { type: "message", message: { role: "user", content: "ignore" } },
      { type: "custom", customType: DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, data: { goal: goalB } },
    ]),
    goalB,
  );
});

test("snapshotFromSessionBranch reconstructs clear/null state", () => {
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  assert.equal(
    snapshotFromSessionBranch([
      { type: "custom", customType: DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, data: { goal: goalA } },
      { type: "custom", customType: DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, data: { goal: null } },
    ]),
    null,
  );
});

test("legacy repeat snapshots are detected but never restored as active goals", () => {
  const legacy = { enabled: true, repeatTarget: 3, pendingRepeats: 2, completedRepeats: 1 };
  assert.equal(isLegacyRepeatSnapshot(legacy), true);
  assert.equal(
    snapshotFromSessionBranch([{ type: "custom", customType: DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, data: legacy }]),
    null,
  );
});
