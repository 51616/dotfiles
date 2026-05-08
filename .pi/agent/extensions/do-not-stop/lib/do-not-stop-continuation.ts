import type { DoNotStopAuditResult, DoNotStopGoalState } from "./do-not-stop.ts";

function bulletList(items: string[], emptyText: string): string {
  if (items.length === 0) return `- ${emptyText}`;
  return items.map((item) => `- ${item}`).join("\n");
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
    "Original objective:",
    goal.objective,
    "",
    "External audit summary:",
    audit.summary,
    "",
    "Completed items — do not repeat unless verification shows they regressed:",
    bulletList(audit.completedItems, "No completed items were identified."),
    "",
    "Remaining work / next concrete steps:",
    nextSteps,
    "",
    "Guardrails:",
    "- Do not repeat completed work just to spend turns.",
    "- Inspect real state before changing files when the audit is uncertain.",
    "- Keep going until the objective is actually complete.",
  ].join("\n");
}

export function buildFallbackContinuationMessage(goal: DoNotStopGoalState, failureReason: string): string {
  return [
    "Original objective:",
    goal.objective,
    "",
    "External audit status:",
    `- Anchored audit details are unavailable: ${failureReason}`,
    "",
    "Required next step:",
    "- Inspect the current session/repo state yourself, identify the next concrete unfinished step, and continue from there.",
    "",
    "Guardrails:",
    "- Do not repeat completed work if you can verify it is already done.",
    "- Prefer conductor spec/plan/resume files, auto-checkpoints, progress notes, TODOs, and repo status when deciding what remains.",
  ].join("\n");
}
