import type {
  GoalAuditConfidence,
  GoalAuditDecision,
  GoalAuditResult,
} from "./goal.ts";

const DECISIONS = new Set<GoalAuditDecision>(["complete", "continue", "unknown"]);
const CONFIDENCES = new Set<GoalAuditConfidence>(["high", "medium", "low"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function extractStrictJsonObject(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  return raw;
}

export function normalizeAuditResult(value: unknown): GoalAuditResult {
  const record = asRecord(value);
  if (!record) throw new Error("audit result must be a JSON object");

  const rawDecision = stringField(record, "decision") as GoalAuditDecision;
  const rawConfidence = stringField(record, "confidence") as GoalAuditConfidence;
  const decision: GoalAuditDecision = DECISIONS.has(rawDecision) ? rawDecision : "unknown";
  const confidence: GoalAuditConfidence = CONFIDENCES.has(rawConfidence) ? rawConfidence : "low";

  return {
    decision,
    confidence,
    summary: stringField(record, "summary") || "Audit returned no summary.",
    completedItems: stringArrayField(record, "completedItems"),
    remainingItems: stringArrayField(record, "remainingItems"),
    evidence: stringArrayField(record, "evidence"),
    sourcePaths: stringArrayField(record, "sourcePaths"),
    continuationMessage: stringField(record, "continuationMessage"),
  };
}

export function parseAuditResult(text: string): GoalAuditResult {
  const json = extractStrictJsonObject(text);
  if (!json) throw new Error("audit output must be exactly one JSON object");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`audit output was not valid JSON: ${message}`);
  }

  return normalizeAuditResult(parsed);
}

export function isHighConfidenceComplete(audit: GoalAuditResult): boolean {
  return (
    audit.decision === "complete" &&
    audit.confidence === "high" &&
    audit.evidence.length > 0 &&
    audit.sourcePaths.length > 0
  );
}

export function fallbackAuditResult(reason: string): GoalAuditResult {
  return {
    decision: "unknown",
    confidence: "low",
    summary: `Audit unavailable: ${reason}`,
    completedItems: [],
    remainingItems: [],
    evidence: [],
    sourcePaths: [],
    continuationMessage: "",
  };
}
