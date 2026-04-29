import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export type ContextUsageSnapshot = {
  percent: number | null;
  contextWindow: number;
};

export type ContextUsageHighlightLevel = "none" | "bold" | "yellow" | "orange" | "red";

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function buildContextUsageLabel(snapshot: ContextUsageSnapshot): string | undefined {
  if (!Number.isFinite(snapshot.contextWindow) || snapshot.contextWindow <= 0) return undefined;
  if (snapshot.percent === null) return `?/${formatTokens(snapshot.contextWindow)}`;
  return `${snapshot.percent.toFixed(1)}%/${formatTokens(snapshot.contextWindow)}`;
}

export function buildContextUsageBorderText(label: string): string {
  return ` ${label} `;
}

export function buildEditorBorderBadgeText(badges: string[], moreText?: string | null): string | undefined {
  const parts = badges.map((badge) => sanitizeStatusText(badge)).filter(Boolean);
  const extra = sanitizeStatusText(String(moreText ?? ""));
  if (extra) parts.push(extra);
  if (parts.length === 0) return undefined;
  return parts.join(" • ");
}

export function buildEditorTopBorderLine(args: {
  leftText?: string | null;
  rightText?: string | null;
  width: number;
  borderChar: string;
  colorizeBorder: (text: string) => string;
}): string | undefined {
  if (args.width <= 0) return "";

  const leftText = sanitizeStatusText(String(args.leftText ?? ""));
  const rightText = sanitizeStatusText(String(args.rightText ?? ""));
  if (!leftText && !rightText) return undefined;

  const leftLabel = leftText ? ` ${leftText} ` : "";
  const rightLabel = rightText ? ` ${rightText} ` : "";
  const rightWidth = visibleWidth(rightLabel);
  const trailingBorderWidth = rightWidth > 0 ? 1 : 0;

  if (rightWidth + trailingBorderWidth >= args.width) {
    return truncateToWidth(rightLabel, args.width, "");
  }

  const availableLeftWidth = Math.max(0, args.width - rightWidth - trailingBorderWidth - (rightWidth > 0 ? 1 : 0));
  const truncatedLeftLabel = leftLabel ? truncateToWidth(leftLabel, availableLeftWidth, "") : "";
  const leftWidth = visibleWidth(truncatedLeftLabel);
  const fillWidth = Math.max(0, args.width - leftWidth - rightWidth - trailingBorderWidth);
  const borderPrefix = `${truncatedLeftLabel}${args.borderChar.repeat(fillWidth)}`;
  const trailingBorder = trailingBorderWidth > 0 ? args.colorizeBorder(args.borderChar) : "";

  return `${args.colorizeBorder(borderPrefix)}${rightLabel}${trailingBorder}`;
}

export function getContextUsageHighlightLevel(tokens: number | null): ContextUsageHighlightLevel {
  if (!Number.isFinite(tokens) || tokens === null) return "none";
  if (tokens >= 224_000) return "red";
  if (tokens >= 192_000) return "orange";
  if (tokens >= 128_000) return "yellow";
  if (tokens >= 64_000) return "bold";
  return "none";
}

export function getContextUsageHighlightAnsiCodes(tokens: number | null): string | undefined {
  switch (getContextUsageHighlightLevel(tokens)) {
    case "bold":
      return "1";
    case "yellow":
      return "1;33";
    case "orange":
      return "1;38;5;208";
    case "red":
      return "1;31";
    default:
      return undefined;
  }
}

export function buildModelEffortLabel(
  modelId: string | undefined,
  reasoning: boolean | undefined,
  thinkingLevel: string | undefined,
): string {
  const normalizedModelId = modelId?.trim() ? modelId : "no-model";
  if (!reasoning) return normalizedModelId;

  const normalizedThinkingLevel = thinkingLevel?.trim() ? thinkingLevel : "off";
  return normalizedThinkingLevel === "off"
    ? `${normalizedModelId} • thinking off`
    : `${normalizedModelId} • ${normalizedThinkingLevel}`;
}

export function buildSingleLineFooter(left: string, right: string, width: number): string {
  if (width <= 0) return "";

  const normalizedRight = stripAnsi(truncateToWidth(right, width, ""));
  const rightWidth = visibleWidth(normalizedRight);
  if (rightWidth >= width) {
    return normalizedRight;
  }

  const availableLeft = Math.max(0, width - rightWidth - 1);
  const normalizedLeft = availableLeft > 0 ? stripAnsi(truncateToWidth(left, availableLeft, "...")) : "";
  const leftWidth = visibleWidth(normalizedLeft);
  const paddingWidth = Math.max(1, width - leftWidth - rightWidth);
  const padding = " ".repeat(paddingWidth);

  return `${normalizedLeft}${padding}${normalizedRight}`;
}
