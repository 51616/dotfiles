import type {
  DoNotStopAuditConfidence,
  DoNotStopAuditDecision,
  DoNotStopAuditResult,
} from "./do-not-stop.ts";

const DECISIONS = new Set<DoNotStopAuditDecision>(["complete", "continue", "unknown"]);
const CONFIDENCES = new Set<DoNotStopAuditConfidence>(["high", "medium", "low"]);

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

export function normalizeAuditResult(value: unknown): DoNotStopAuditResult {
  const record = asRecord(value);
  if (!record) throw new Error("audit result must be a JSON object");

  const rawDecision = stringField(record, "decision") as DoNotStopAuditDecision;
  const rawConfidence = stringField(record, "confidence") as DoNotStopAuditConfidence;
  const decision: DoNotStopAuditDecision = DECISIONS.has(rawDecision) ? rawDecision : "unknown";
  const confidence: DoNotStopAuditConfidence = CONFIDENCES.has(rawConfidence) ? rawConfidence : "low";

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

export function parseAuditResult(text: string): DoNotStopAuditResult {
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

export function isHighConfidenceComplete(audit: DoNotStopAuditResult): boolean {
  return (
    audit.decision === "complete" &&
    audit.confidence === "high" &&
    audit.evidence.length > 0 &&
    audit.sourcePaths.length > 0
  );
}

export function fallbackAuditResult(reason: string): DoNotStopAuditResult {
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
