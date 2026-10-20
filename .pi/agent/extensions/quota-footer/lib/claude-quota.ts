import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { QuotaSnapshot, QuotaWindow } from "./quota-footer.ts";

// Claude subscription quota (Pro/Max) via the same endpoint Claude Code's `/usage` uses.
// Response shape (2026-10): { five_hour: { utilization, resets_at }, seven_day: { ... }, ... }
// where `utilization` is a used-percent (0-100) and `resets_at` an ISO timestamp.
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_TIMEOUT_MS = 8_000;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export type ClaudeQuotaErrorReason = "no-credentials" | "token-expired" | "http" | "bad-response";

// No TS parameter properties here: pi/node load .ts in strip-only mode, which rejects them.
export class ClaudeQuotaError extends Error {
  readonly reason: ClaudeQuotaErrorReason;

  constructor(reason: ClaudeQuotaErrorReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "ClaudeQuotaError";
  }
}

export type ClaudeOAuthCredentials = {
  accessToken: string;
  expiresAtMs: number | null;
};

export type ReadClaudeQuotaOptions = {
  claudeConfigDir?: string;
  usageUrl?: string;
  timeoutMs?: number;
  observedAtMs?: number;
  fetchImpl?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeConfigDir(options: ReadClaudeQuotaOptions): string {
  return options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export async function readClaudeOAuthCredentials(configDir: string): Promise<ClaudeOAuthCredentials> {
  const credentialsPath = path.join(configDir, ".credentials.json");
  let raw: string;
  try {
    raw = await fs.readFile(credentialsPath, "utf8");
  } catch {
    throw new ClaudeQuotaError("no-credentials", `no Claude Code credentials at ${credentialsPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeQuotaError("no-credentials", `unreadable JSON in ${credentialsPath}`);
  }

  const oauth = isObject(parsed) ? parsed.claudeAiOauth : undefined;
  if (!isObject(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken === "") {
    throw new ClaudeQuotaError("no-credentials", `no claudeAiOauth.accessToken in ${credentialsPath}`);
  }

  return {
    accessToken: oauth.accessToken,
    expiresAtMs: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
  };
}

function normalizeClaudeWindow(value: unknown, windowMinutes: number): QuotaWindow | null {
  if (!isObject(value) || typeof value.utilization !== "number") return null;
  const resetsAtMs = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
  return {
    usedPercent: value.utilization,
    windowMinutes,
    resetsAt: Number.isFinite(resetsAtMs) ? Math.floor(resetsAtMs / 1000) : null,
  };
}

export function normalizeClaudeUsageResponse(value: unknown, observedAtMs: number): QuotaSnapshot | null {
  if (!isObject(value)) return null;
  const primary = normalizeClaudeWindow(value.five_hour, FIVE_HOUR_WINDOW_MINUTES);
  const secondary = normalizeClaudeWindow(value.seven_day, WEEKLY_WINDOW_MINUTES);
  if (!primary && !secondary) return null;

  const limitReached = [primary, secondary].some((window) => window !== null && window.usedPercent >= 100);
  return {
    primary,
    secondary,
    planType: null,
    rateLimitReachedType: limitReached ? "claude-plan-limit" : null,
    source: "claude-oauth-usage",
    observedAtMs,
  };
}

export async function readClaudeRateLimits(options: ReadClaudeQuotaOptions = {}): Promise<QuotaSnapshot> {
  const observedAtMs = options.observedAtMs ?? Date.now();
  const credentials = await readClaudeOAuthCredentials(claudeConfigDir(options));

  // Do NOT refresh the token here. Claude Code owns ~/.claude/.credentials.json and
  // refresh tokens rotate on use: refreshing from this extension would invalidate the
  // copy Claude Code holds. Report expiry instead; the next Claude turn refreshes it.
  if (credentials.expiresAtMs !== null && credentials.expiresAtMs <= observedAtMs) {
    throw new ClaudeQuotaError("token-expired", "Claude Code access token expired");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.usageUrl ?? CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ClaudeQuotaError("http", `Claude usage request failed: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new ClaudeQuotaError("http", `Claude usage request returned HTTP ${response.status}`);
  }

  const snapshot = normalizeClaudeUsageResponse(await response.json(), observedAtMs);
  if (!snapshot) {
    throw new ClaudeQuotaError("bad-response", "Claude usage response had no five_hour/seven_day windows");
  }
  return snapshot;
}
