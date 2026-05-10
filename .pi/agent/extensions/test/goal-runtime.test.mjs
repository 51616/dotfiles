import test from "node:test";
import assert from "node:assert/strict";
import { createGoal } from "../goal/lib/goal-state.ts";
import {
  __resetGoalRuntimeStoreForTests,
  getGoalSnapshotForSession,
  getLastGoalSnapshot,
  isLegacyRepeatSnapshot,
  saveGoalSnapshot,
  snapshotFromSessionBranch,
} from "../goal/lib/goal-runtime.ts";
import { GOAL_STATE_ENTRY_TYPE } from "../goal/lib/goal.ts";

test("goal runtime store keeps per-session goal snapshots", () => {
  __resetGoalRuntimeStoreForTests();
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  const goalB = createGoal("finish b", { goalId: "b", nowMs: 2000 });

  saveGoalSnapshot("session-a", goalA);
  saveGoalSnapshot("session-b", goalB);

  assert.deepEqual(getGoalSnapshotForSession("session-a"), goalA);
  assert.deepEqual(getGoalSnapshotForSession("session-b"), goalB);
  assert.deepEqual(getLastGoalSnapshot(), goalB);
});

test("saving null clears a session goal snapshot", () => {
  __resetGoalRuntimeStoreForTests();
  saveGoalSnapshot("session-a", createGoal("finish a", { goalId: "a", nowMs: 1000 }));
  saveGoalSnapshot("session-a", null);
  assert.equal(getGoalSnapshotForSession("session-a"), null);
});

test("snapshotFromSessionBranch reconstructs the latest goal state entry", () => {
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  const goalB = createGoal("finish b", { goalId: "b", nowMs: 2000 });

  assert.deepEqual(
    snapshotFromSessionBranch([
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: goalA } },
      { type: "message", message: { role: "user", content: "ignore" } },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: goalB } },
    ]),
    goalB,
  );
});

test("snapshotFromSessionBranch reconstructs clear/null state", () => {
  const goalA = createGoal("finish a", { goalId: "a", nowMs: 1000 });
  assert.equal(
    snapshotFromSessionBranch([
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: goalA } },
      { type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: { goal: null } },
    ]),
    null,
  );
});

test("legacy repeat snapshots are detected but never restored as active goals", () => {
  const legacy = { enabled: true, repeatTarget: 3, pendingRepeats: 2, completedRepeats: 1 };
  assert.equal(isLegacyRepeatSnapshot(legacy), true);
  assert.equal(
    snapshotFromSessionBranch([{ type: "custom", customType: GOAL_STATE_ENTRY_TYPE, data: legacy }]),
    null,
  );
});
