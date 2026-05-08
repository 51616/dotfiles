import type { DoNotStopAuditResult, DoNotStopGoalState } from "./do-not-stop.ts";
import { formatBudget } from "./do-not-stop.ts";

function bulletList(items: string[], emptyText: string): string {
  if (items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
}

export function formatBudgetForPrompt(goal: DoNotStopGoalState): string {
  return `${goal.turnsUsed}/${formatBudget(goal.turnBudget)} continuation turns used`;
}

export function buildInitialGoalMessage(goal: DoNotStopGoalState): string {
  return [
    "Objective:",
    goal.objective,
    "",
    "Do not stop until everything is complete, test, and verified. Write your findings and progress down as you go.",
    "",
    "Instructions:",
    "- Inspect the current session and repo state before changing files.",
    "- Make a concrete plan if the work is multi-step, then begin implementation immediately.",
    "- Keep going until the objective is actually complete.",
  ].join("\n");
}

export function buildAnchoredContinuationMessage(goal: DoNotStopGoalState, audit: DoNotStopAuditResult): string {
  const auditContinuation = audit.continuationMessage.trim();
  const nextSteps = auditContinuation || audit.remainingItems.join("\n").trim() || "Inspect the current repo/session state and continue with the next concrete unfinished step.";

  return [
    "Continue the active /do-not-stop goal.",
    "",
    "Original objective:",
    goal.objective,
    "",
    "Budget/progress:",
    `- ${formatBudgetForPrompt(goal)}`,
    "",
    "External audit summary:",
    audit.summary,
    "",
    "Audit source paths:",
    bulletList(audit.sourcePaths, "No concrete source paths were reported by the audit."),
    "",
    "Completed items — do not repeat unless verification shows they regressed:",
    bulletList(audit.completedItems, "No completed items were identified."),
    "",
    "Remaining work / next concrete steps:",
    nextSteps,
    "",
    "Guardrails:",
    "- Do not repeat completed work just to spend turns.",
    "- Do not claim the goal is complete because a turn budget is exhausted.",
    "- Inspect real state before changing files when the audit is uncertain.",
    "- Keep going until the objective is actually complete, budget-limited, or the user clears the goal.",
  ].join("\n");
}

export function buildFallbackContinuationMessage(goal: DoNotStopGoalState, failureReason: string): string {
  return [
    "Continue the active /do-not-stop goal.",
    "",
    "Original objective:",
    goal.objective,
    "",
    "Budget/progress:",
    `- ${formatBudgetForPrompt(goal)}`,
    "",
    "External audit status:",
    `- Anchored audit details are unavailable: ${failureReason}`,
    "",
    "Required next step:",
    "- Inspect the current session/repo state yourself, identify the next concrete unfinished step, and continue from there.",
    "",
    "Guardrails:",
    "- Do not repeat completed work if you can verify it is already done.",
    "- Do not claim completion from budget exhaustion or from this fallback message.",
    "- Prefer conductor spec/plan/resume files, auto-checkpoints, progress notes, TODOs, and repo status when deciding what remains.",
  ].join("\n");
}
