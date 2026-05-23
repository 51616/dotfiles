import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type QuotaWindow = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type QuotaSnapshot = {
  primary: QuotaWindow | null;
  secondary: QuotaWindow | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  source: "codex-session-log";
  observedAtMs: number;
};

export type ReadQuotaOptions = {
  codexHome?: string;
  maxFiles?: number;
  tailBytes?: number;
};

export type FormatQuotaOptions = {
  barWidth?: number;
};

type JsonObject = Record<string, unknown>;

type SessionCandidate = {
  filePath: string;
  mtimeMs: number;
};

const DEFAULT_BAR_WIDTH = 5;
const DEFAULT_MAX_SESSION_FILES = 80;
const DEFAULT_TAIL_BYTES = 1024 * 1024;
const FALLBACK_FRESH_MS = 10 * 60 * 1000;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(object: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function readNumber(object: JsonObject, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readTimestampMs(object: JsonObject, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readTimestampSeconds(object: JsonObject, keys: readonly string[]): number | null {
  const timestampMs = readTimestampMs(object, keys);
  return timestampMs === null ? null : Math.floor(timestampMs / 1000);
}

function normalizeWindow(value: unknown): QuotaWindow | null {
  if (!isObject(value)) return null;

  const usedPercent = readNumber(value, ["usedPercent", "used_percent"]);
  if (usedPercent === null) return null;

  const explicitWindowMinutes = readNumber(value, [
    "windowDurationMins",
    "window_duration_mins",
    "windowMinutes",
    "window_minutes",
  ]);
  const windowSeconds = readNumber(value, [
    "limitWindowSeconds",
    "limit_window_seconds",
    "windowSeconds",
    "window_seconds",
  ]);
  const windowMinutes = explicitWindowMinutes ?? (windowSeconds === null ? null : windowSeconds / 60);
  const resetsAt = readTimestampSeconds(value, ["resetsAt", "resets_at", "resetAt", "reset_at"]);

  return {
    usedPercent,
    windowMinutes,
    resetsAt,
  };
}

function firstObject(value: unknown): JsonObject | null {
  if (isObject(value)) return value;
  if (!Array.isArray(value)) return null;

  for (const entry of value) {
    if (!isObject(entry)) continue;
    const limitId = readString(entry, ["limitId", "limit_id"]);
    if (limitId === "codex") return entry;
  }

  return value.find(isObject) ?? null;
}

export function normalizeQuotaSnapshot(
  value: unknown,
  observedAtMs: number,
): QuotaSnapshot | null {
  const root = firstObject(value);
  if (!root) return null;

  const nested = firstObject(root.rate_limits ?? root.rateLimits ?? root.limits);
  const source = nested ?? root;
  const primary = normalizeWindow(source.primary ?? source.primary_window ?? source.primaryWindow);
  const secondary = normalizeWindow(source.secondary ?? source.secondary_window ?? source.secondaryWindow);

  if (!primary && !secondary) return null;

  return {
    primary,
    secondary,
    planType: readString(source, ["planType", "plan_type"]),
    rateLimitReachedType: readString(source, ["rateLimitReachedType", "rate_limit_reached_type"]),
    source: "codex-session-log",
    observedAtMs,
  };
}

export function parseQuotaSnapshotFromJsonLine(line: string, fallbackObservedAtMs: number): QuotaSnapshot | null {
  if (!line.includes("rate_limits") && !line.includes("rateLimits")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(parsed)) return null;

  const observedAtMs = readTimestampMs(parsed, ["timestamp", "time"]) ?? fallbackObservedAtMs;
  const payload = isObject(parsed.payload) ? parsed.payload : parsed;
  const direct = payload.rate_limits ?? payload.rateLimits ?? parsed.rate_limits ?? parsed.rateLimits;
  const snapshot = direct === undefined ? normalizeQuotaSnapshot(payload, observedAtMs) : normalizeQuotaSnapshot(direct, observedAtMs);

  return snapshot;
}

export function parseLatestQuotaSnapshotFromText(text: string, fallbackObservedAtMs: number): QuotaSnapshot | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const snapshot = parseQuotaSnapshotFromJsonLine(lines[index] ?? "", fallbackObservedAtMs);
    if (snapshot) return snapshot;
  }
  return null;
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const stats = await fs.stat(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const length = stats.size - start;
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function collectSessionJsonlFiles(dir: string, candidates: SessionCandidate[]): Promise<void> {
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionJsonlFiles(entryPath, candidates);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    try {
      const stats = await fs.stat(entryPath);
      candidates.push({ filePath: entryPath, mtimeMs: stats.mtimeMs });
    } catch {
      continue;
    }
  }
}

export async function readLatestCodexSessionRateLimits(options: ReadQuotaOptions = {}): Promise<QuotaSnapshot | null> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_SESSION_FILES;
  const tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const candidates: SessionCandidate[] = [];

  await collectSessionJsonlFiles(sessionsDir, candidates);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      const tail = await readFileTail(candidate.filePath, tailBytes);
      const snapshot = parseLatestQuotaSnapshotFromText(tail, candidate.mtimeMs);
      if (snapshot) return snapshot;
    } catch {
      continue;
    }
  }

  return null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function renderProgressBar(usedPercent: number, width = DEFAULT_BAR_WIDTH): string {
  const barWidth = Math.max(1, Math.floor(width));
  const clampedPercent = clampPercent(usedPercent);
  const filled = clampedPercent === 0 ? 0 : Math.max(1, Math.round((clampedPercent / 100) * barWidth));
  return `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
}

function windowIsFresh(window: QuotaWindow, observedAtMs: number, nowMs: number): boolean {
  if (window.resetsAt !== null) return window.resetsAt > Math.floor(nowMs / 1000);
  return nowMs - observedAtMs <= FALLBACK_FRESH_MS;
}

export function quotaSnapshotIsFresh(snapshot: QuotaSnapshot, nowMs: number): boolean {
  if (!snapshot.primary || !snapshot.secondary) return false;
  return (
    windowIsFresh(snapshot.primary, snapshot.observedAtMs, nowMs) &&
    windowIsFresh(snapshot.secondary, snapshot.observedAtMs, nowMs)
  );
}

function formatQuotaWindow(label: string, window: QuotaWindow, width: number): string {
  const percent = Math.round(clampPercent(window.usedPercent));
  return `${label} [${renderProgressBar(percent, width)}]${percent}%`;
}

export function formatQuotaStatus(
  snapshot: QuotaSnapshot | null,
  nowMs = Date.now(),
  options: FormatQuotaOptions = {},
): string | undefined {
  if (!snapshot) return undefined;
  if (!snapshot.primary || !snapshot.secondary) return undefined;
  if (!quotaSnapshotIsFresh(snapshot, nowMs)) return "quota stale";

  const width = options.barWidth ?? DEFAULT_BAR_WIDTH;
  const status = `${formatQuotaWindow("5h", snapshot.primary, width)} ${formatQuotaWindow("wk", snapshot.secondary, width)}`;
  return snapshot.rateLimitReachedType ? `${status} !` : status;
}
