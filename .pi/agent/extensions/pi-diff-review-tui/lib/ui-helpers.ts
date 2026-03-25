import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

type BorderColor = "border" | "borderMuted" | "accent" | "borderAccent" | "muted";

const RESET = "\x1b[0m";

function border(theme: Theme, text: string, color: BorderColor = "border"): string {
  return theme.fg(color, text);
}

export function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…", true);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(pad)}`;
}

export function wrapAndPadLines(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => padLine(line, width));
}

export function boxLine(theme: Theme, left: string, content: string, width: number, right: string, borderColor: BorderColor = "border"): string {
  // Prefix each line with a hard reset to avoid ANSI bleed (esp. background) from previous lines.
  return `${RESET}${border(theme, left, borderColor)}${padLine(content, width)}${border(theme, right, borderColor)}${RESET}`;
}

export function topBorder(theme: Theme, title: string, width: number, borderColor: BorderColor = "border"): string {
  const safeTitle = truncateToWidth(title, Math.max(1, width - 4), "…").replace(/\x1b\[[0-9;]*m/g, "");
  const titleColor = borderColor === "accent" ? "accent" : borderColor === "borderAccent" ? "borderAccent" : "muted";
  const titleText = theme.fg(titleColor, theme.bold(safeTitle));
  const prefix = `${border(theme, "╭─ ", borderColor)}`;
  const titleGap = border(theme, " ", borderColor);
  const suffix = border(theme, "╮", borderColor);
  const fill = Math.max(0, width - visibleWidth(safeTitle) - 3);
  return `${RESET}${prefix}${titleText}${titleGap}${border(theme, "─".repeat(fill), borderColor)}${suffix}${RESET}`;
}

export function bottomBorder(theme: Theme, width: number, borderColor: BorderColor = "border"): string {
  return `${RESET}${border(theme, "╰", borderColor)}${border(theme, "─".repeat(width), borderColor)}${border(theme, "╯", borderColor)}${RESET}`;
}

export function horizontalRule(theme: Theme, left: string, widthLeft: number, join: string, widthRight: number, right: string, borderColor: BorderColor = "border"): string {
  return `${RESET}${border(theme, left, borderColor)}${border(theme, "─".repeat(widthLeft), borderColor)}${border(theme, join, borderColor)}${border(theme, "─".repeat(widthRight), borderColor)}${border(theme, right, borderColor)}${RESET}`;
}

export function statusColor(theme: Theme, text: string, status: "ok" | "moved" | "stale_unresolved"): string {
  if (status === "moved") return theme.fg("warning", text);
  if (status === "stale_unresolved") return theme.fg("error", text);
  return theme.fg("success", text);
}

export function formatHintColumns(width: number, items: string[], columns: number): string {
  const safeColumns = Math.max(1, columns);
  const gap = 2;
  const columnWidth = Math.max(8, Math.floor((width - gap * (safeColumns - 1)) / safeColumns));
  const cells: string[] = [];
  for (let index = 0; index < safeColumns; index += 1) {
    const item = items[index] ?? "";
    cells.push(padLine(item, columnWidth));
  }
  return cells.join(" ".repeat(gap)).trimEnd();
}
