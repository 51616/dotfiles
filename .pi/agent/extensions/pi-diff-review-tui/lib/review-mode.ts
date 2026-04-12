import type { ReviewMode } from "./types.ts";

export function reviewModeHotkey(mode: ReviewMode): string {
  return mode;
}

export function reviewModeName(mode: ReviewMode): string {
  if (mode === "t") return "last turn";
  return "workspace vs HEAD";
}

export function reviewModeLegend(): string {
  return "t/a";
}

export function reviewModeDisplay(mode: ReviewMode): string {
  return `${reviewModeName(mode)} [${reviewModeHotkey(mode)}]`;
}
