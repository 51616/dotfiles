export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
export const GREP_MAX_LINE_LENGTH = 500;

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;
const FIND_WEAK_SAMPLE_SIZE = 5;

export interface FffFileAnnotationInput {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}

export interface FffSearchItem extends FffFileAnnotationInput {
  relativePath: string;
  fileName?: string;
}

export interface FffScore {
  total: number;
}

export interface FffSearchResult {
  items: FffSearchItem[];
  scores: FffScore[];
  totalMatched: number;
  totalFiles: number;
}

export interface FffGrepMatch extends FffFileAnnotationInput {
  relativePath: string;
  fileName?: string;
  lineNumber: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FffGrepResult {
  items: FffGrepMatch[];
  totalMatched: number;
  totalFiles: number;
  regexFallbackError?: string;
  nextCursorOffset?: number | null;
}

export interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

export function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export function fffFileAnnotation(item: FffFileAnnotationInput): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

export function formatGrepOutput(result: FffGrepResult): string {
  if (result.items.length === 0) return "No matches found";

  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line, index) => {
      const lineNumber = match.lineNumber - (match.contextBefore?.length ?? 0) + index;
      lines.push(` ${lineNumber}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line, index) => {
      const lineNumber = match.lineNumber + 1 + index;
      lines.push(` ${lineNumber}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 12;
  return Math.floor((perfect * 50) / 100);
}

export function formatFindOutput(
  result: FffSearchResult,
  limit: number,
  pattern: string,
): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < weakScoreThreshold(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = result.items.slice(0, effective);

  return {
    output: shown.map((item) => `${item.relativePath}${fffFileAnnotation(item)}`).join("\n"),
    weak,
    shownCount: shown.length,
  };
}

export function renderTextContent(content: string, maxLines: number): string {
  const lines = content.split("\n");
  const displayLines = lines.slice(0, maxLines);
  if (lines.length > displayLines.length) {
    displayLines.push(`\n... (${lines.length - displayLines.length} more lines)`);
  }
  return displayLines.join("\n");
}
