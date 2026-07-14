import type { GoalState } from "./goal.ts";

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Historical goal versions emitted starters and audited continuations as user messages.
// Keep those sentinels so blank /goal never adopts a legacy goal-authored entry as a human
// objective. Current tokenized dispatch uses custom messages, which this lookup ignores by role.
const GOAL_CONTINUATION_PREFIXES = ["Original objective:\n", "Objective:\n"];

function isGoalContinuationText(text: string): boolean {
  return GOAL_CONTINUATION_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type PreviousUserMessageForGoal = {
  text: string;
  startedAtMs: number | null;
};

function userMessageFromEntry(entry: unknown): PreviousUserMessageForGoal | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const entryRecord = entry as Record<string, unknown>;
  if (entryRecord.type !== "message") return null;

  const message = entryRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "user") return null;

  const text = contentToText(messageRecord.content).trim();
  if (!text || text.startsWith("/") || isGoalContinuationText(text)) return null;
  return {
    text,
    startedAtMs: parseTimestampMs(messageRecord.timestamp) ?? parseTimestampMs(entryRecord.timestamp),
  };
}

export function findPreviousUserMessageForGoalDetails(
  entries: readonly unknown[],
): PreviousUserMessageForGoal | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = userMessageFromEntry(entries[i]);
    if (message) return message;
  }
  return null;
}

export function findPreviousUserMessageForGoal(entries: readonly unknown[]): string | null {
  return findPreviousUserMessageForGoalDetails(entries)?.text ?? null;
}

export type AuditPromptInput = {
  goal: GoalState;
  cwd: string;
  sessionFile?: string;
  checkpointDir?: string;
  conductorDir?: string;
  progressHints?: string[];
};

export function buildAuditPrompt(input: AuditPromptInput): string {
  const sourceHints = [
    input.sessionFile ? `- Current session file: ${input.sessionFile}` : "- Current session file: unavailable from extension context",
    input.checkpointDir ? `- Auto-checkpoint directory: ${input.checkpointDir}` : "- Auto-checkpoint directory: /tmp/pi-work/checkpoints (inspect if it exists)",
    input.conductorDir ? `- Conductor tracks directory: ${input.conductorDir}` : "- Conductor tracks directory: conductor/tracks (inspect if it exists in cwd)",
    ...(input.progressHints ?? []).map((hint) => `- ${hint}`),
  ];

  return [
    "You are an external progress/completion auditor for a pi /goal objective.",
    "The active agent must not decide completion by itself; your job is to inspect real state and return strict JSON only.",
    "",
    "Goal state:",
    JSON.stringify(
      {
        objective: input.goal.objective,
        goalId: input.goal.goalId,
        status: input.goal.status,
        turnsUsed: input.goal.turnsUsed,
        turnBudget: input.goal.turnBudget,
      },
      null,
      2,
    ),
    "",
    `Working directory: ${input.cwd}`,
    "Source hints to inspect when available:",
    sourceHints.join("\n"),
    "",
    "Inspect the current session progress, conductor spec/plan/resume files, auto-checkpoints, progress notes/TODOs, and relevant repo state when available. Missing sources are not failure by themselves.",
    "",
    "Return exactly one JSON object with this schema and no prose outside JSON:",
    JSON.stringify(
      {
        decision: "complete | continue | unknown",
        confidence: "high | medium | low",
        summary: "short evidence-based summary",
        completedItems: ["done item to avoid repeating"],
        remainingItems: ["specific unfinished item"],
        evidence: ["specific evidence inspected"],
        sourcePaths: ["path inspected"],
        continuationMessage: "concrete next-step instructions if decision is continue/unknown, empty if complete",
      },
      null,
      2,
    ),
    "",
    "Rules:",
    "- Use decision=complete only when the objective is achieved with concrete evidence.",
    "- Use confidence=high only when evidence is strong enough to stop automatic continuation.",
    "- If uncertain, use decision=unknown or continue. Never invent completion.",
  ].join("\n");
}
