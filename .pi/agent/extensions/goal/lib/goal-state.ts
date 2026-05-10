import { randomUUID } from "node:crypto";
import type { GoalAuditResult, GoalState } from "./goal.ts";

export type GoalFactoryOptions = {
  nowMs?: number;
  goalId?: string;
  turnBudget?: number | null;
};

export type ScheduleDecisionOptions = {
  goal: GoalState | null;
  isIdle: boolean;
  hasPendingMessages: boolean;
  dispatchScheduled: boolean;
};

export function normalizeObjective(objective: string): string {
  return String(objective ?? "").trim().replace(/\s+/g, " ");
}

export function createGoal(objective: string, options: GoalFactoryOptions = {}): GoalState {
  const normalized = normalizeObjective(objective);
  if (!normalized) {
    throw new Error("goal objective must not be empty");
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

export function replaceGoal(_existing: GoalState | null, objective: string, options: GoalFactoryOptions = {}): GoalState {
  return createGoal(objective, options);
}

export function setGoalBudget(goal: GoalState, turnBudget: number | null, nowMs = Date.now()): GoalState {
  return {
    ...goal,
    turnBudget,
    updatedAtMs: nowMs,
  };
}

export function markGoalBudgetLimited(goal: GoalState, nowMs = Date.now()): GoalState {
  return {
    ...goal,
    status: "budget_limited",
    updatedAtMs: nowMs,
  };
}

export function markGoalActive(goal: GoalState, nowMs = Date.now()): GoalState {
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
  goal: GoalState,
  audit: GoalAuditResult,
  nowMs = Date.now(),
): GoalState {
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

export function incrementGoalTurnsUsed(goal: GoalState, nowMs = Date.now()): GoalState {
  return {
    ...goal,
    turnsUsed: goal.turnsUsed + 1,
    updatedAtMs: nowMs,
  };
}

export function shouldBudgetLimitGoal(goal: GoalState | null): boolean {
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

export function sameGoal(left: GoalState | null, right: GoalState | null): boolean {
  return Boolean(left && right && left.goalId === right.goalId);
}
