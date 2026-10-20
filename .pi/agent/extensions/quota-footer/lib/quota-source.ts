import { readClaudeRateLimits } from "./claude-quota.ts";
import {
  ansiTrueColor,
  formatQuotaStatus,
  QUOTA_TEXT_COLOR,
  readCurrentCodexRateLimits,
  type QuotaSnapshot,
} from "./quota-footer.ts";

export type QuotaSourceId = "codex" | "claude";

// pi provider id -> subscription quota source. Only subscription (OAuth) providers have
// plan windows; API-key providers (e.g. `anthropic`, `openai`) are billed per token.
const PROVIDER_QUOTA_SOURCES: Readonly<Record<string, QuotaSourceId>> = {
  "openai-codex": "codex",
  "claude-code": "claude",
};

const QUOTA_READERS: Readonly<Record<QuotaSourceId, () => Promise<QuotaSnapshot | null>>> = {
  codex: () => readCurrentCodexRateLimits(),
  claude: () => readClaudeRateLimits(),
};

export function resolveQuotaSource(provider: string | undefined): QuotaSourceId | null {
  if (!provider) return null;
  return PROVIDER_QUOTA_SOURCES[provider] ?? null;
}

export function formatUnsupportedProviderStatus(provider: string | undefined): string {
  return ansiTrueColor(`quota n/a for ${provider ?? "no model"}`, QUOTA_TEXT_COLOR);
}

export function formatQuotaReadFailureStatus(source: QuotaSourceId): string {
  return ansiTrueColor(`${source} quota unavailable`, QUOTA_TEXT_COLOR);
}

export type QuotaStatusResult = {
  text: string | undefined;
  /** Set when the read failed; surfaced for logging, never thrown into the TUI. */
  error?: Error;
};

export async function readQuotaStatusForProvider(
  provider: string | undefined,
  nowMs = Date.now(),
): Promise<QuotaStatusResult> {
  const source = resolveQuotaSource(provider);
  if (!source) return { text: formatUnsupportedProviderStatus(provider) };

  try {
    const snapshot = await QUOTA_READERS[source]();
    return { text: formatQuotaStatus(snapshot, nowMs) ?? formatQuotaReadFailureStatus(source) };
  } catch (error) {
    return { text: formatQuotaReadFailureStatus(source), error: error as Error };
  }
}
