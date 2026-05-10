import type { GoalState } from "./goal.ts";
import { GOAL_STATE_ENTRY_TYPE } from "./goal.ts";

export type GoalSnapshot = GoalState | null;

type GoalRuntimeStore = {
  bySession: Record<string, GoalSnapshot>;
  lastGoal: GoalSnapshot;
};

const STORE_KEY = "__PI_GOAL_RUNTIME__";

function getStore(): GoalRuntimeStore {
  const g = globalThis as Record<string, unknown>;
  const existing = g[STORE_KEY];
  if (existing && typeof existing === "object") {
    return existing as GoalRuntimeStore;
  }

  const created: GoalRuntimeStore = {
    bySession: {},
    lastGoal: null,
  };
  g[STORE_KEY] = created;
  return created;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const turnBudget = record.turnBudget;
  return (
    typeof record.goalId === "string" &&
    typeof record.objective === "string" &&
    (status === "active" || status === "budget_limited" || status === "complete") &&
    (turnBudget === null || (typeof turnBudget === "number" && Number.isSafeInteger(turnBudget) && turnBudget > 0)) &&
    typeof record.turnsUsed === "number" &&
    Number.isSafeInteger(record.turnsUsed) &&
    record.turnsUsed >= 0 &&
    typeof record.startedAtMs === "number" &&
    typeof record.updatedAtMs === "number" &&
    (record.completedAtMs === undefined || typeof record.completedAtMs === "number") &&
    (record.completionSummary === undefined || typeof record.completionSummary === "string") &&
    (record.completionEvidence === undefined || isStringArray(record.completionEvidence)) &&
    (record.completionSourcePaths === undefined || isStringArray(record.completionSourcePaths))
  );
}

export function isLegacyRepeatSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "enabled" in record || "repeatTarget" in record || "pendingRepeats" in record || "completedRepeats" in record;
}

export function cloneGoalSnapshot(goal: GoalSnapshot): GoalSnapshot {
  if (!goal) return null;
  const cloned: GoalState = { ...goal };
  if (goal.completionEvidence) cloned.completionEvidence = [...goal.completionEvidence];
  if (goal.completionSourcePaths) cloned.completionSourcePaths = [...goal.completionSourcePaths];
  return cloned;
}

export function getLastGoalSnapshot(): GoalSnapshot {
  return cloneGoalSnapshot(getStore().lastGoal);
}

export function getGoalSnapshotForSession(sessionId: string): GoalSnapshot {
  const key = String(sessionId ?? "").trim();
  if (!key) return null;
  return cloneGoalSnapshot(getStore().bySession[key] ?? null);
}

export function saveGoalSnapshot(sessionId: string | null | undefined, goal: GoalSnapshot): void {
  const store = getStore();
  const cloned = cloneGoalSnapshot(goal);
  store.lastGoal = cloned;

  const key = String(sessionId ?? "").trim();
  if (!key) return;
  store.bySession[key] = cloned;
}

function extractGoalFromCustomData(data: unknown): GoalSnapshot | undefined {
  if (data === null) return null;
  if (isGoalState(data)) return cloneGoalSnapshot(data);
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.goal === null) return null;
  if (isGoalState(record.goal)) return cloneGoalSnapshot(record.goal);
  if (isLegacyRepeatSnapshot(record)) return null;
  return undefined;
}

export function snapshotFromSessionBranch(entries: readonly unknown[]): GoalSnapshot {
  let latest: GoalSnapshot | undefined;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== GOAL_STATE_ENTRY_TYPE) continue;
    const next = extractGoalFromCustomData(record.data);
    if (next !== undefined) latest = next;
  }

  return latest ?? null;
}

export function __resetGoalRuntimeStoreForTests(): void {
  const store = getStore();
  store.lastGoal = null;
  store.bySession = {};
}
