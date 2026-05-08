import type { DoNotStopGoalState } from "./do-not-stop.ts";

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

function messageTextFromEntry(entry: unknown): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const entryRecord = entry as Record<string, unknown>;
  if (entryRecord.type !== "message") return "";

  const message = entryRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord.role !== "user") return "";

  return contentToText(messageRecord.content).trim();
}

export function findPreviousUserMessageForGoal(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = messageTextFromEntry(entries[i]).trim();
    if (!text) continue;
    if (text.startsWith("/")) continue;
    if (text.includes("Continue the active /do-not-stop goal.")) continue;
    return text;
  }
  return null;
}

export type AuditPromptInput = {
  goal: DoNotStopGoalState;
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
    "You are an external progress/completion auditor for a pi /do-not-stop goal.",
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
