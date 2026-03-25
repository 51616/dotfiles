import type { DiffScope } from "./types.ts";

export function scopeHotkey(scope: DiffScope): string {
  if (scope === "s") return "i";
  return scope;
}

export function scopeName(scope: DiffScope): string {
  if (scope === "t") return "last turn";
  if (scope === "u") return "unstaged";
  if (scope === "s") return "staged";
  return "all";
}

export function scopeLegend(): string {
  return "t/u/i/a";
}

export function scopeDisplay(scope: DiffScope): string {
  return `${scopeName(scope)} [${scopeHotkey(scope)}]`;
}
