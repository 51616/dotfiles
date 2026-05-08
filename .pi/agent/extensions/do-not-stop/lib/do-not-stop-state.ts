import { randomUUID } from "node:crypto";
import type { DoNotStopAuditResult, DoNotStopGoalState } from "./do-not-stop.ts";

export type GoalFactoryOptions = {
  nowMs?: number;
  goalId?: string;
  turnBudget?: number | null;
};

export type ScheduleDecisionOptions = {
  goal: DoNotStopGoalState | null;
  isIdle: boolean;
  hasPendingMessages: boolean;
  dispatchScheduled: boolean;
};

export function normalizeObjective(objective: string): string {
  return String(objective ?? "").trim().replace(/\s+/g, " ");
}

export function createGoal(objective: string, options: GoalFactoryOptions = {}): DoNotStopGoalState {
  const normalized = normalizeObjective(objective);
  if (!normalized) {
    throw new Error("do-not-stop objective must not be empty");
  }

  const nowMs = options.nowMs ?? Date.now();
  return {
    goalId: options.goalId ?? randomUUID(),
    objective: normalized,
    status: "active",
    turnBudget: options.turnBudget ?? null,
    turnsUsed: 0,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

export function replaceGoal(_existing: DoNotStopGoalState | null, objective: string, options: GoalFactoryOptions = {}): DoNotStopGoalState {
  return createGoal(objective, options);
}

export function setGoalBudget(goal: DoNotStopGoalState, turnBudget: number | null, nowMs = Date.now()): DoNotStopGoalState {
  return {
    ...goal,
    turnBudget,
    updatedAtMs: nowMs,
  };
}

export function markGoalBudgetLimited(goal: DoNotStopGoalState, nowMs = Date.now()): DoNotStopGoalState {
  return {
    ...goal,
    status: "budget_limited",
    updatedAtMs: nowMs,
  };
}

export function markGoalActive(goal: DoNotStopGoalState, nowMs = Date.now()): DoNotStopGoalState {
  return {
    ...goal,
    status: "active",
    updatedAtMs: nowMs,
    completedAtMs: undefined,
    completionSummary: undefined,
    completionEvidence: undefined,
    completionSourcePaths: undefined,
  };
}

export function markGoalCompleteFromAudit(
  goal: DoNotStopGoalState,
  audit: DoNotStopAuditResult,
  nowMs = Date.now(),
): DoNotStopGoalState {
  return {
    ...goal,
    status: "complete",
    updatedAtMs: nowMs,
    completedAtMs: nowMs,
    completionSummary: audit.summary,
    completionEvidence: [...audit.evidence],
    completionSourcePaths: [...audit.sourcePaths],
  };
}

export function incrementGoalTurnsUsed(goal: DoNotStopGoalState, nowMs = Date.now()): DoNotStopGoalState {
  return {
    ...goal,
    turnsUsed: goal.turnsUsed + 1,
    updatedAtMs: nowMs,
  };
}

export function shouldBudgetLimitGoal(goal: DoNotStopGoalState | null): boolean {
  return Boolean(goal && goal.status === "active" && goal.turnBudget !== null && goal.turnsUsed >= goal.turnBudget);
}

export function shouldScheduleGoalContinuation(options: ScheduleDecisionOptions): boolean {
  const goal = options.goal;
  if (!goal) return false;
  if (goal.status !== "active") return false;
  if (!options.isIdle) return false;
  if (options.hasPendingMessages) return false;
  if (options.dispatchScheduled) return false;
  if (shouldBudgetLimitGoal(goal)) return false;
  return true;
}

export function sameGoal(left: DoNotStopGoalState | null, right: DoNotStopGoalState | null): boolean {
  return Boolean(left && right && left.goalId === right.goalId);
}
