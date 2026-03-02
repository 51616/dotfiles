import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PendingResume = {
  v: 1;
  checkpointPath: string;
  resumeText: string;
  createdAt: number;
  attempts: number;
  lastSentAt?: number;

  // Ownership guards.
  ownerPid?: number;
  sessionId?: string;
};

function toPendingResume(value: unknown): PendingResume | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Record<string, unknown>;

  const checkpointPath = String(parsed.checkpointPath || "").trim();
  const resumeText = String(parsed.resumeText || "");
  if (!checkpointPath || !resumeText) return null;

  const createdAt = Number(parsed.createdAt || Date.now());
  const attempts = Number(parsed.attempts || 0);
  const lastSentAtRaw = Number(parsed.lastSentAt || 0);

  const ownerPidRaw = Number(parsed.ownerPid || 0);
  const ownerPid = Number.isFinite(ownerPidRaw) && ownerPidRaw > 0 ? ownerPidRaw : undefined;

  const sessionIdRaw = typeof parsed.sessionId === "string" ? parsed.sessionId.trim() : "";
  const sessionId = sessionIdRaw ? sessionIdRaw : undefined;

  return {
    v: 1,
    checkpointPath,
    resumeText,
    createdAt,
    attempts,
    lastSentAt: lastSentAtRaw > 0 ? lastSentAtRaw : undefined,
    ownerPid,
    sessionId,
  };
}

export function readPendingResume(pendingResumePath: string): PendingResume | null {
  try {
    if (!existsSync(pendingResumePath)) return null;
    const raw = String(readFileSync(pendingResumePath, "utf8") || "");
    const parsed = JSON.parse(raw);
    return toPendingResume(parsed);
  } catch {
    return null;
  }
}

export function writePendingResume(pendingResumePath: string, pending: PendingResume) {
  try {
    mkdirSync(path.dirname(pendingResumePath), { recursive: true });
    const tmp = `${pendingResumePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
    renameSync(tmp, pendingResumePath);
  } catch {
    // ignore
  }
}

export function clearPendingResume(pendingResumePath: string) {
  try {
    unlinkSync(pendingResumePath);
  } catch {
    // ignore
  }
}
