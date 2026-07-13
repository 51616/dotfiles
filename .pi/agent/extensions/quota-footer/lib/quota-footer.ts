import { spawn } from "node:child_process";
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
  source: "codex-session-log" | "codex-app-server";
  observedAtMs: number;
};

export type ReadQuotaOptions = {
  codexHome?: string;
  maxFiles?: number;
  tailBytes?: number;
};

export type ReadCodexAppServerQuotaOptions = {
  codexBinary?: string;
  codexHome?: string;
  timeoutMs?: number;
  observedAtMs?: number;
};

export type ReadCurrentQuotaOptions = ReadQuotaOptions & ReadCodexAppServerQuotaOptions;

export type FormatQuotaOptions = {
  barWidth?: number;
};

type JsonObject = Record<string, unknown>;

type SessionCandidate = {
  filePath: string;
  mtimeMs: number;
};

const DEFAULT_BAR_WIDTH = 6;
const DEFAULT_MAX_SESSION_FILES = 80;
const DEFAULT_TAIL_BYTES = 1024 * 1024;
const DEFAULT_APP_SERVER_TIMEOUT_MS = 8_000;
const FALLBACK_FRESH_MS = 10 * 60 * 1000;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const WINDOW_DURATION_TOLERANCE_MINUTES = 1;
const BAR_CHAR = "━";
const BAR_FILLED_COLOR = "#a6adc8";
const BAR_EMPTY_COLOR = "#45475a";
const TEXT_COLOR = "#6c7086";
const RGB_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

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
  sourceName: QuotaSnapshot["source"] = "codex-session-log",
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
    source: sourceName,
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

function selectCodexRateLimits(value: unknown): unknown {
  if (!isObject(value)) return value;

  const byLimitId = value.rateLimitsByLimitId ?? value.rate_limits_by_limit_id;
  if (isObject(byLimitId) && byLimitId.codex !== undefined) return byLimitId.codex;

  return value.rateLimits ?? value.rate_limits ?? value;
}

function parseCodexAppServerRateLimitsResponse(
  line: string,
  responseId: number,
  observedAtMs: number,
): QuotaSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isObject(parsed) || parsed.id !== responseId || parsed.result === undefined) return null;
  return normalizeQuotaSnapshot(selectCodexRateLimits(parsed.result), observedAtMs, "codex-app-server");
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

export async function readCodexAppServerRateLimits(
  options: ReadCodexAppServerQuotaOptions = {},
): Promise<QuotaSnapshot | null> {
  const codexBinary = options.codexBinary ?? process.env.CODEX_BINARY ?? "codex";
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_APP_SERVER_TIMEOUT_MS);
  const observedAtMs = options.observedAtMs ?? Date.now();
  const responseId = 2;
  const env = options.codexHome
    ? { ...process.env, CODEX_HOME: options.codexHome }
    : process.env;

  return new Promise((resolve) => {
    let settled = false;
    let stdoutBuffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });

    function finish(snapshot: QuotaSnapshot | null): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.stdin?.destroy();
      child.kill();
      resolve(snapshot);
    }

    timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    child.on("error", () => {
      finish(null);
    });
    child.on("exit", () => {
      finish(null);
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const snapshot = parseCodexAppServerRateLimitsResponse(line, responseId, observedAtMs);
        if (snapshot) {
          finish(snapshot);
          return;
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stdin?.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "pi-quota-footer", version: "0" },
        capabilities: { experimentalApi: true },
      },
    })}\n${JSON.stringify({ id: responseId, method: "account/rateLimits/read", params: null })}\n`);
  });
}

export async function readCurrentCodexRateLimits(options: ReadCurrentQuotaOptions = {}): Promise<QuotaSnapshot | null> {
  const nowMs = options.observedAtMs ?? Date.now();
  const latestLogSnapshot = await readLatestCodexSessionRateLimits(options);
  if (
    latestLogSnapshot?.primary &&
    latestLogSnapshot.secondary &&
    quotaSnapshotIsFresh(latestLogSnapshot, nowMs)
  ) {
    return latestLogSnapshot;
  }

  return (await readCodexAppServerRateLimits({ ...options, observedAtMs: nowMs })) ?? latestLogSnapshot;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function ansiTrueColor(text: string, hex: string): string {
  const normalized = hex.trim();
  if (!RGB_HEX_REGEX.test(normalized) || !text) return text;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

export function renderProgressBar(usedPercent: number, width = DEFAULT_BAR_WIDTH): string {
  const barWidth = Math.max(1, Math.floor(width));
  const clampedPercent = clampPercent(usedPercent);
  const roundedCells = Math.round((clampedPercent / 100) * barWidth);
  const filledCells =
    clampedPercent === 0
      ? 0
      : clampedPercent === 100
        ? barWidth
        : Math.max(1, Math.min(barWidth - 1, roundedCells));
  const emptyCells = Math.max(0, barWidth - filledCells);
  const filledSegment = ansiTrueColor(BAR_CHAR.repeat(filledCells), BAR_FILLED_COLOR);
  const emptySegment = ansiTrueColor(BAR_CHAR.repeat(emptyCells), BAR_EMPTY_COLOR);
  return `${filledSegment}${emptySegment}`;
}

function windowIsFresh(window: QuotaWindow, observedAtMs: number, nowMs: number): boolean {
  if (window.resetsAt !== null) return window.resetsAt > Math.floor(nowMs / 1000);
  return nowMs - observedAtMs <= FALLBACK_FRESH_MS;
}

export function quotaSnapshotIsFresh(snapshot: QuotaSnapshot, nowMs: number): boolean {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is QuotaWindow => window !== null,
  );
  return (
    windows.length > 0 &&
    windows.every((window) => windowIsFresh(window, snapshot.observedAtMs, nowMs))
  );
}

type StandardQuotaWindows = {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
};

function hasWindowDuration(window: QuotaWindow, expectedMinutes: number): boolean {
  return (
    window.windowMinutes !== null &&
    Math.abs(window.windowMinutes - expectedMinutes) <= WINDOW_DURATION_TOLERANCE_MINUTES
  );
}

function selectStandardQuotaWindows(snapshot: QuotaSnapshot): StandardQuotaWindows {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is QuotaWindow => window !== null,
  );
  let fiveHour = windows.find((window) => hasWindowDuration(window, FIVE_HOUR_WINDOW_MINUTES)) ?? null;
  let weekly = windows.find((window) => hasWindowDuration(window, WEEKLY_WINDOW_MINUTES)) ?? null;

  // Older payloads did not always include durations. Preserve their documented
  // positional meaning without mislabeling newer single-window payloads.
  if (!fiveHour && snapshot.primary?.windowMinutes === null) fiveHour = snapshot.primary;
  if (!weekly && snapshot.secondary?.windowMinutes === null) weekly = snapshot.secondary;

  return { fiveHour, weekly };
}

function formatQuotaWindow(label: string, window: QuotaWindow, width: number): string {
  const availablePercent = Math.round(100 - clampPercent(window.usedPercent));
  const prefix = ansiTrueColor(`${label} `, TEXT_COLOR);
  const suffix = ansiTrueColor(` ${availablePercent}%`, TEXT_COLOR);
  return `${prefix}${renderProgressBar(availablePercent, width)}${suffix}`;
}

function formatUnavailableQuotaWindow(label: string): string {
  return ansiTrueColor(`${label} n/a`, TEXT_COLOR);
}

export function formatQuotaStatus(
  snapshot: QuotaSnapshot | null,
  nowMs = Date.now(),
  options: FormatQuotaOptions = {},
): string | undefined {
  if (!snapshot) return undefined;
  if (!quotaSnapshotIsFresh(snapshot, nowMs)) return "quota stale";

  const { fiveHour, weekly } = selectStandardQuotaWindows(snapshot);
  if (!fiveHour && !weekly) return undefined;

  const width = options.barWidth ?? DEFAULT_BAR_WIDTH;
  const fiveHourStatus = fiveHour
    ? formatQuotaWindow("5h", fiveHour, width)
    : formatUnavailableQuotaWindow("5h");
  const weeklyStatus = weekly
    ? formatQuotaWindow("weekly", weekly, width)
    : formatUnavailableQuotaWindow("weekly");
  const status = `${fiveHourStatus}${ansiTrueColor(" · ", TEXT_COLOR)}${weeklyStatus}`;
  return snapshot.rateLimitReachedType ? `${status} !` : status;
}
