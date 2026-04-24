export type AutockptContextUsage =
  | {
      tokens?: number | null;
      contextWindow?: number | null;
      percent?: number | null;
    }
  | undefined;

export type AutockptThreshold = {
  percent: number;
  tokens: number;
};

export type AutockptThresholdMatch = {
  matched: boolean;
  percentMatched: boolean;
  tokensMatched: boolean;
  percent: number | null;
  tokens: number | null;
};

export function parseAutockptThresholdTokens(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
  const n = Number.parseInt(value || String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isContextUsageAtOrAboveThreshold(
  usage: AutockptContextUsage,
  threshold: AutockptThreshold,
): AutockptThresholdMatch {
  const percent = usage?.percent;
  const tokens = usage?.tokens;
  const normalizedPercent = percent === null || percent === undefined ? null : percent;
  const normalizedTokens = tokens === null || tokens === undefined ? null : tokens;
  const percentMatched = normalizedPercent !== null && normalizedPercent >= threshold.percent;
  const tokensMatched = normalizedTokens !== null && normalizedTokens >= threshold.tokens;

  return {
    matched: percentMatched || tokensMatched,
    percentMatched,
    tokensMatched,
    percent: normalizedPercent,
    tokens: normalizedTokens,
  };
}

export function formatAutockptThreshold(threshold: AutockptThreshold): string {
  return `${threshold.percent}% or ${threshold.tokens} tokens`;
}

export function formatAutockptUsageMatch(match: AutockptThresholdMatch): string {
  const parts: string[] = [];
  if (match.percent !== null) parts.push(`${match.percent.toFixed(1)}%`);
  if (match.tokens !== null) parts.push(`${match.tokens} tokens`);
  return parts.length > 0 ? parts.join(", ") : "usage unknown";
}
