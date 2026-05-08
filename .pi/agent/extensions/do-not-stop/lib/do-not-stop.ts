export const DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE = "do-not-stop-goal-state";

export type DoNotStopGoalStatus = "active" | "budget_limited" | "complete";
export type DoNotStopAuditDecision = "complete" | "continue" | "unknown";
export type DoNotStopAuditConfidence = "high" | "medium" | "low";

export type DoNotStopGoalState = {
  goalId: string;
  objective: string;
  status: DoNotStopGoalStatus;
  turnBudget: number | null;
  turnsUsed: number;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  completionSummary?: string;
  completionEvidence?: string[];
  completionSourcePaths?: string[];
};

export type DoNotStopAuditResult = {
  decision: DoNotStopAuditDecision;
  confidence: DoNotStopAuditConfidence;
  summary: string;
  completedItems: string[];
  remainingItems: string[];
  evidence: string[];
  sourcePaths: string[];
  continuationMessage: string;
};

export type ObjectiveValidationResult = {
  ok: boolean;
  guidance?: string;
};

export type DoNotStopCommand =
  | { kind: "blank" }
  | { kind: "setObjective"; objective: string; replace: boolean }
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "setBudget"; turnBudget: number | null }
  | { kind: "help"; invalid?: string }
  | { kind: "unsupported"; command: string; guidance: string };

export function brightRed(text: string): string {
  return `\x1b[91m${text}\x1b[0m`;
}

const VAGUE_OBJECTIVE_NORMALIZED = new Set([
  "goal",
  "task",
  "work",
  "continue",
  "do it",
  "finish",
  "stuff",
  "things",
  "todo",
  "something",
]);

export function validateDoNotStopObjective(objective: string): ObjectiveValidationResult {
  const normalized = objective.trim().replace(/\s+/g, " ").replace(/[.!?]+$/g, "").toLowerCase();
  if (!normalized) {
    return { ok: false, guidance: "do-not-stop needs a concrete, verifiable objective." };
  }
  if (VAGUE_OBJECTIVE_NORMALIZED.has(normalized)) {
    return {
      ok: false,
      guidance: `do-not-stop needs a concrete, verifiable objective, not "${objective.trim()}". Example: /do-not-stop fix the failing auth tests and commit the fix`,
    };
  }
  return { ok: true };
}

export function parsePositiveInteger(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return Math.min(999, n);
}

export function parseDoNotStopCommand(args: string): DoNotStopCommand {
  const raw = String(args ?? "").trim();
  if (!raw) return { kind: "blank" };

  const tokens = raw.split(/\s+/).filter(Boolean);
  const first = (tokens[0] ?? "").toLowerCase();

  if (first === "help") return { kind: "help" };
  if (first === "status") return { kind: "status" };
  if (first === "clear") return { kind: "clear" };

  if (first === "pause" || first === "resume") {
    return {
      kind: "unsupported",
      command: first,
      guidance: `/${"do-not-stop"} ${first} is not supported. Use /do-not-stop clear to stop a goal, or /do-not-stop <objective> to create one.`,
    };
  }

  if (first === "on" || first === "off" || first === "toggle" || first === "enable" || first === "disable") {
    return {
      kind: "unsupported",
      command: first,
      guidance: "The old do-not-stop toggle was removed. Use /do-not-stop <objective>, /do-not-stop clear, or /do-not-stop budget <n>.",
    };
  }

  if (first === "repeats" || first === "repeat" || first === "set") {
    return {
      kind: "unsupported",
      command: first,
      guidance: "Repeat counts were removed. Use /do-not-stop budget <n> or /do-not-stop budget unlimited.",
    };
  }

  if (first === "budget") {
    const second = (tokens[1] ?? "").toLowerCase();
    if (second === "unlimited" || second === "none" || second === "off") {
      return { kind: "setBudget", turnBudget: null };
    }
    const budget = parsePositiveInteger(second);
    if (budget === null) {
      return { kind: "help", invalid: raw };
    }
    return { kind: "setBudget", turnBudget: budget };
  }

  if (first === "replace") {
    const objective = raw.slice(tokens[0]?.length ?? 0).trim();
    if (!objective) return { kind: "help", invalid: "replace" };
    return { kind: "setObjective", objective, replace: true };
  }

  if (first === "--replace") {
    const objective = raw.slice(tokens[0]?.length ?? 0).trim();
    if (!objective) return { kind: "help", invalid: "--replace" };
    return { kind: "setObjective", objective, replace: true };
  }

  return { kind: "setObjective", objective: raw, replace: false };
}

export function formatBudget(turnBudget: number | null): string {
  return turnBudget === null ? "∞" : String(turnBudget);
}

export function buildDoNotStopBorderLabel(goal: DoNotStopGoalState | null): string {
  if (!goal) return "goal none";
  return `goal ${goal.status.replace("_", "-")} ${Math.max(0, goal.turnsUsed)}/${formatBudget(goal.turnBudget)}`;
}

export function formatDurationMs(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds === 0) return "<1s";

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatElapsedMs(nowMs: number, startedAtMs: number): string {
  return formatDurationMs(Math.max(0, nowMs - startedAtMs));
}

export function formatTokenCount(tokens: number | null | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return "unknown";
  return Math.round(tokens).toLocaleString("en-US");
}

export function formatGoalCompletionStats(
  goal: DoNotStopGoalState,
  options: { nowMs?: number; totalTokens?: number | null } = {},
): string {
  const completedOrNowMs = options.nowMs ?? goal.completedAtMs ?? Date.now();
  const turnLabel = goal.turnsUsed === 1 ? "turn" : "turns";
  return `${goal.turnsUsed} ${turnLabel}, ${formatElapsedMs(completedOrNowMs, goal.startedAtMs)} total time used, ${formatTokenCount(options.totalTokens)} total tokens used`;
}

export function formatGoalStatusSummary(goal: DoNotStopGoalState | null, nowMs = Date.now()): string {
  if (!goal) {
    return "do-not-stop: no goal is set. Use /do-not-stop <objective> to create one.";
  }

  const parts = [
    `do-not-stop goal ${goal.status.replace("_", "-")}`,
    `turns ${goal.turnsUsed}/${formatBudget(goal.turnBudget)}`,
    `elapsed ${formatElapsedMs(nowMs, goal.startedAtMs)}`,
    `objective: ${goal.objective}`,
  ];
  if (goal.completionSummary) parts.push(`completion: ${goal.completionSummary}`);
  return parts.join("; ");
}

export function usageText(extra?: string): string {
  const prefix = extra ? `${extra}\n\n` : "";
  return `${prefix}Usage: /do-not-stop <objective> | status | clear | budget <n>|unlimited | replace <objective> | help`;
}
