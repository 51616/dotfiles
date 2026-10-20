import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Never log to stdout/stderr from a TUI extension: it corrupts the rendered screen.
// Daily JSONL files under ~/.pi/agent/logs/quota-footer/, pruned after 7 days.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function quotaLogDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "logs", "quota-footer");
}

export function pruneQuotaLogs(dir = quotaLogDir(), nowMs = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      if (nowMs - statSync(filePath).mtimeMs > RETENTION_MS) rmSync(filePath, { force: true });
    } catch {
      continue;
    }
  }
}

export function appendQuotaLog(event: Record<string, unknown>, dir = quotaLogDir()): void {
  const now = new Date();
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify({ timestamp: now.toISOString(), pid: process.pid, ...event })}\n`,
      "utf8",
    );
  } catch {
    // Logging must never break the footer.
  }
}
