import type { DoNotStopGoalState } from "./do-not-stop.ts";
import { DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE } from "./do-not-stop.ts";

export type DoNotStopGoalSnapshot = DoNotStopGoalState | null;

type DoNotStopRuntimeStore = {
  bySession: Record<string, DoNotStopGoalSnapshot>;
  lastGoal: DoNotStopGoalSnapshot;
};

const STORE_KEY = "__PI_DO_NOT_STOP_GOAL_RUNTIME__";

function getStore(): DoNotStopRuntimeStore {
  const g = globalThis as Record<string, unknown>;
  const existing = g[STORE_KEY];
  if (existing && typeof existing === "object") {
    return existing as DoNotStopRuntimeStore;
  }

  const created: DoNotStopRuntimeStore = {
    bySession: {},
    lastGoal: null,
  };
  g[STORE_KEY] = created;
  return created;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isDoNotStopGoalState(value: unknown): value is DoNotStopGoalState {
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

export function cloneGoalSnapshot(goal: DoNotStopGoalSnapshot): DoNotStopGoalSnapshot {
  if (!goal) return null;
  const cloned: DoNotStopGoalState = { ...goal };
  if (goal.completionEvidence) cloned.completionEvidence = [...goal.completionEvidence];
  if (goal.completionSourcePaths) cloned.completionSourcePaths = [...goal.completionSourcePaths];
  return cloned;
}

export function getLastDoNotStopGoalSnapshot(): DoNotStopGoalSnapshot {
  return cloneGoalSnapshot(getStore().lastGoal);
}

export function getDoNotStopGoalSnapshotForSession(sessionId: string): DoNotStopGoalSnapshot {
  const key = String(sessionId ?? "").trim();
  if (!key) return null;
  return cloneGoalSnapshot(getStore().bySession[key] ?? null);
}

export function saveDoNotStopGoalSnapshot(sessionId: string | null | undefined, goal: DoNotStopGoalSnapshot): void {
  const store = getStore();
  const cloned = cloneGoalSnapshot(goal);
  store.lastGoal = cloned;

  const key = String(sessionId ?? "").trim();
  if (!key) return;
  store.bySession[key] = cloned;
}

function extractGoalFromCustomData(data: unknown): DoNotStopGoalSnapshot | undefined {
  if (data === null) return null;
  if (isDoNotStopGoalState(data)) return cloneGoalSnapshot(data);
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.goal === null) return null;
  if (isDoNotStopGoalState(record.goal)) return cloneGoalSnapshot(record.goal);
  if (isLegacyRepeatSnapshot(record)) return null;
  return undefined;
}

export function snapshotFromSessionBranch(entries: readonly unknown[]): DoNotStopGoalSnapshot {
  let latest: DoNotStopGoalSnapshot | undefined;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "custom" || record.customType !== DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE) continue;
    const next = extractGoalFromCustomData(record.data);
    if (next !== undefined) latest = next;
  }

  return latest ?? null;
}

export function __resetDoNotStopRuntimeStoreForTests(): void {
  const store = getStore();
  store.lastGoal = null;
  store.bySession = {};
}
