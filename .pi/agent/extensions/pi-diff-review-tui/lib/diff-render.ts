import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { DiffScope, DiffViewportCache, InlineEmphasisRange, ParsedDiffRow, ParsedFilePatch, DiffRowRenderCache } from "./types.ts";
import { isNavigableDiffRow } from "./navigation.ts";
import { applyBackgroundAnsi, blendedDiffSelectionBg, brightenedBackgroundAnsi, diffRowBaseBg } from "./diff-background.ts";
import { buildInlineEmphasisMap, renderableDiffText } from "./inline-emphasis.ts";
import { padLine, wrapAndPadLines } from "./ui-helpers.ts";

const CURRENT_LINE_MARKER = "▌";
const CURRENT_LINE_MARKER_WIDTH = 1;
const COMMENT_MARKER_WIDTH = 3;
const MIN_LINE_NUMBER_WIDTH = 3;
const RESET = "\x1b[0m";
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/y;

// We already have add/remove background tint + bold line numbers.
// Keep +/- prefixes as a separate mode (off by default).
const SHOW_DIFF_PREFIX_SIGNS = false;

type StyledCell = {
  char: string;
  bold: boolean;
  fg: string | null;
  bg: string | null;
};

export function renderFileList({
  theme,
  files,
  width,
  height,
  fileScroll,
  selectedFileIndex,
  statusLetter,
  fileCommentCount,
  fileHasStale,
}: {
  theme: Theme;
  files: ParsedFilePatch[];
  width: number;
  height: number;
  fileScroll: number;
  selectedFileIndex: number;
  statusLetter: (status: string) => string;
  fileCommentCount: (fileKey: string) => number;
  fileHasStale: (fileKey: string) => boolean;
}): string[] {
  const visible = files.slice(fileScroll, fileScroll + height);
  if (!visible.length) {
    return Array.from({ length: height }, () => padLine(theme.fg("muted", "(no files in this scope)"), width));
  }

  return visible.map((file, idx) => {
    const absoluteIndex = fileScroll + idx;
    const selected = absoluteIndex === selectedFileIndex;
    const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
    const commentCount = fileCommentCount(file.fileKey);
    const badge = commentCount > 0
      ? fileHasStale(file.fileKey)
        ? theme.fg("warning", ` ◇${commentCount}`)
        : theme.fg("accent", ` ◆${commentCount}`)
      : "";
    const path = truncateToWidth(file.displayPath, Math.max(8, width - visibleWidth(prefix) - visibleWidth(badge) - 2), "…", true);
    return padLine(`${prefix}${statusLetter(file.status)} ${path}${badge}`, width);
  });
}

export function createDiffRowRenderCache({
  scope,
  fingerprint,
  fileKey,
  width,
  lineNumberWidth,
  commentsEpoch,
  highlightKey,
}: {
  scope: DiffScope;
  fingerprint: string;
  fileKey: string;
  width: number;
  lineNumberWidth: number;
  commentsEpoch: number;
  highlightKey: string;
}): DiffRowRenderCache {
  return {
    scope,
    fingerprint,
    fileKey,
    width,
    lineNumberWidth,
    commentsEpoch,
    highlightKey,
    contentRows: new Map(),
    baseRows: new Map(),
    selectedRows: new Map(),
    inlineEmphasisRows: new Map(),
    inlineEmphasisReady: false,
    emptyLine: " ".repeat(width),
  };
}

function computeLineNumberWidth(file: ParsedFilePatch): number {
  let maxValue = 0;
  for (const row of file.rows) {
    if (row.oldLine != null) maxValue = Math.max(maxValue, row.oldLine);
    if (row.newLine != null) maxValue = Math.max(maxValue, row.newLine);
  }
  const digits = String(maxValue || 0).length;
  return Math.max(MIN_LINE_NUMBER_WIDTH, digits);
}

function rowTextColor(row: ParsedDiffRow): "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "accent" | "dim" {
  if (row.kind === "added") return "toolDiffAdded";
  if (row.kind === "removed") return "toolDiffRemoved";
  if (row.kind === "context") return "toolDiffContext";
  if (row.kind === "hunk_header") return "accent";
  return "dim";
}

function rowNumber({
  theme,
  value,
  width,
  tone,
}: {
  theme: Theme;
  value: number | undefined;
  width: number;
  tone: "added" | "removed" | "default";
}): string {
  if (value == null) return " ".repeat(width);
  const text = String(value).padStart(width, " ");
  const styled = tone === "default" ? text : (theme.bold ? theme.bold(text) : text);
  if (tone === "added") return theme.fg("toolDiffAdded", styled);
  if (tone === "removed") return theme.fg("toolDiffRemoved", styled);
  return theme.fg("muted", styled);
}

function buildGutters({
  theme,
  row,
  lineNumberWidth,
  commentMarker,
  selected,
}: {
  theme: Theme;
  row: ParsedDiffRow;
  lineNumberWidth: number;
  commentMarker: string;
  selected: boolean;
}): { first: string; continuation: string } {
  const oldNumber = rowNumber({
    theme,
    value: row.oldLine,
    width: lineNumberWidth,
    tone: row.kind === "removed" ? "removed" : "default",
  });
  const newNumber = rowNumber({
    theme,
    value: row.newLine,
    width: lineNumberWidth,
    tone: row.kind === "added" ? "added" : "default",
  });

  const join = theme.fg("muted", "⋮");
  // Internal separator should be grey (not the pane border color).
  const separator = theme.fg("muted", "│");

  const blankNumber = " ".repeat(lineNumberWidth);
  const blankCommentMarker = " ".repeat(COMMENT_MARKER_WIDTH);
  const currentLineMarker = selected ? theme.fg("accent", CURRENT_LINE_MARKER) : " ".repeat(CURRENT_LINE_MARKER_WIDTH);

  return {
    // Keep the join marker compact, reserve a dedicated current-line slot,
    // and leave the comment badge in the gutter so diff text stays left-flushed.
    first: `${oldNumber} ${join} ${newNumber} ${currentLineMarker}${commentMarker}${separator}`,
    continuation: `${blankNumber} ${join} ${blankNumber} ${currentLineMarker}${blankCommentMarker}${separator}`,
  };
}

function renderableRowText(row: ParsedDiffRow): string {
  return renderableDiffText(row.text);
}

function applySgr(state: Omit<StyledCell, "char">, ansi: string): Omit<StyledCell, "char"> {
  const params = ansi.slice(2, -1).split(";").filter(Boolean).map((value) => Number.parseInt(value, 10));
  const codes = params.length ? params : [0];
  const next = { ...state };

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      next.bold = false;
      next.fg = null;
      next.bg = null;
      continue;
    }
    if (code === 1) {
      next.bold = true;
      continue;
    }
    if (code === 22) {
      next.bold = false;
      continue;
    }
    if (code === 39) {
      next.fg = null;
      continue;
    }
    if (code === 49) {
      next.bg = null;
      continue;
    }
    if (code === 38 && codes[index + 1] === 5 && codes[index + 2] != null) {
      next.fg = `\x1b[38;5;${codes[index + 2]}m`;
      index += 2;
      continue;
    }
    if (code === 38 && codes[index + 1] === 2 && codes[index + 4] != null) {
      next.fg = `\x1b[38;2;${codes[index + 2]};${codes[index + 3]};${codes[index + 4]}m`;
      index += 4;
      continue;
    }
    if (code === 48 && codes[index + 1] === 5 && codes[index + 2] != null) {
      next.bg = `\x1b[48;5;${codes[index + 2]}m`;
      index += 2;
      continue;
    }
    if (code === 48 && codes[index + 1] === 2 && codes[index + 4] != null) {
      next.bg = `\x1b[48;2;${codes[index + 2]};${codes[index + 3]};${codes[index + 4]}m`;
      index += 4;
    }
  }

  return next;
}

function parseStyledCells(text: string): StyledCell[] {
  const cells: StyledCell[] = [];
  let state: Omit<StyledCell, "char"> = { bold: false, fg: null, bg: null };

  for (let index = 0; index < text.length;) {
    if (text[index] === "\x1b") {
      ANSI_ESCAPE.lastIndex = index;
      const match = ANSI_ESCAPE.exec(text);
      if (match?.[0]) {
        state = applySgr(state, match[0]);
        index += match[0].length;
        continue;
      }
    }
    cells.push({ char: text[index] ?? "", ...state });
    index += 1;
  }

  return cells;
}

function styleTransition(from: Omit<StyledCell, "char">, to: Omit<StyledCell, "char">, rowBgAnsi: string | null): string {
  let out = "";

  if (from.bold && !to.bold) out += "\x1b[22m";
  if (from.fg && !to.fg) out += "\x1b[39m";

  if (from.bg !== to.bg) {
    if (to.bg) out += to.bg;
    else if (from.bg) out += rowBgAnsi ?? "\x1b[49m";
  }

  if (!from.bold && to.bold) out += "\x1b[1m";
  if (from.fg !== to.fg) {
    if (to.fg) out += to.fg;
    else if (from.fg) out += "\x1b[39m";
  }

  return out;
}

function serializeStyledCells(cells: StyledCell[], rowBgAnsi: string | null): string {
  let out = "";
  let previous: Omit<StyledCell, "char"> = { bold: false, fg: null, bg: null };
  for (const cell of cells) {
    const next = { bold: cell.bold, fg: cell.fg, bg: cell.bg };
    out += styleTransition(previous, next, rowBgAnsi);
    out += cell.char;
    previous = next;
  }
  return out;
}

function applyInlineEmphasis({
  baseText,
  emphasisRanges,
  chipBgAnsi,
  rowBgAnsi,
  expectedLength,
}: {
  baseText: string;
  emphasisRanges: InlineEmphasisRange[];
  chipBgAnsi: string;
  rowBgAnsi: string;
  expectedLength: number;
}): string {
  const cells = parseStyledCells(baseText);
  if (cells.length !== expectedLength) return baseText;

  let changed = false;
  for (const range of emphasisRanges) {
    const start = Math.max(0, Math.min(cells.length, range.start));
    const end = Math.max(start, Math.min(cells.length, range.end));
    for (let index = start; index < end; index += 1) {
      const cell = cells[index];
      if (!cell) continue;
      cell.bold = true;
      cell.bg = chipBgAnsi;
      changed = true;
    }
  }

  if (!changed) return baseText;
  return serializeStyledCells(cells, rowBgAnsi);
}

function codeText({
  theme,
  row,
  highlightedRows,
  emphasisRanges,
  rowBgAnsi,
}: {
  theme: Theme;
  row: ParsedDiffRow;
  highlightedRows: Map<number, string> | null;
  emphasisRanges: InlineEmphasisRange[] | null;
  rowBgAnsi: string | null;
}): string {
  if (row.kind === "meta" || row.kind === "hunk_header" || row.kind === "no_newline") {
    return theme.fg(rowTextColor(row), row.rawText);
  }

  const prefixChar = SHOW_DIFF_PREFIX_SIGNS
    ? row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "
    : "";

  const renderedText = renderableRowText(row);
  const highlightedCode = highlightedRows?.get(row.rowIndex);
  const baseCode = highlightedCode ?? theme.fg(rowTextColor(row), renderedText);
  const prefixedCode = prefixChar ? `${theme.fg(rowTextColor(row), prefixChar)}${baseCode}` : baseCode;

  if (!emphasisRanges?.length || !rowBgAnsi) return prefixedCode;
  const chipBgAnsi = brightenedBackgroundAnsi(theme, rowBgAnsi);
  if (!chipBgAnsi) return prefixedCode;
  return applyInlineEmphasis({
    baseText: prefixedCode,
    emphasisRanges,
    chipBgAnsi,
    rowBgAnsi,
    expectedLength: renderedText.length + prefixChar.length,
  });
}

function wrapRowLines({
  theme,
  cache,
  row,
  rowMarkers,
  highlightedRows,
  selected,
}: {
  theme: Theme;
  cache: DiffRowRenderCache;
  row: ParsedDiffRow;
  rowMarkers: Map<number, string>;
  highlightedRows: Map<number, string> | null;
  selected: boolean;
}): string[] {
  const target = selected ? cache.selectedRows : cache.baseRows;
  const cached = target.get(row.rowIndex);
  if (cached) return cached;

  const commentMarker = rowMarkers.get(row.rowIndex) ?? " ".repeat(COMMENT_MARKER_WIDTH);
  const gutters = buildGutters({ theme, row, lineNumberWidth: cache.lineNumberWidth, commentMarker, selected });
  const contentWidth = Math.max(1, cache.width - visibleWidth(gutters.first));

  const baseBgAnsi = selected
    ? row.kind === "added" || row.kind === "removed"
      ? blendedDiffSelectionBg(theme, row.kind)
      : null
    : diffRowBaseBg(theme, row.kind);

  const selectedBgAnsi = (selected && row.kind === "context" && (theme as any).getBgAnsi)
    ? (theme as any).getBgAnsi("selectedBg")
    : null;

  const contentBgAnsi = selectedBgAnsi ?? baseBgAnsi;
  const emphasisRanges = cache.inlineEmphasisRows.get(row.rowIndex) ?? null;
  const code = codeText({ theme, row, highlightedRows, emphasisRanges, rowBgAnsi: contentBgAnsi });
  const wrappedCode = wrapAndPadLines(code, contentWidth);

  const lines = wrappedCode.map((codeLine, index) => {
    const gutter = index === 0 ? gutters.first : gutters.continuation;
    const content = padLine(codeLine, contentWidth);

    // Only highlight the content area, not the line numbers / gutters.
    const highlightedContent = (selected && row.kind === "context" && !selectedBgAnsi)
      ? theme.bg("selectedBg", content)
      : applyBackgroundAnsi(content, contentBgAnsi);

    return `${RESET}${gutter}${highlightedContent}${RESET}`;
  });

  cache.contentRows.set(row.rowIndex, wrappedCode);
  target.set(row.rowIndex, lines);
  return lines;
}

function rowLines({
  theme,
  cache,
  row,
  rowMarkers,
  highlightedRows,
  selected,
}: {
  theme: Theme;
  cache: DiffRowRenderCache;
  row: ParsedDiffRow;
  rowMarkers: Map<number, string>;
  highlightedRows: Map<number, string> | null;
  selected: boolean;
}): string[] {
  return wrapRowLines({ theme, cache, row, rowMarkers, highlightedRows, selected });
}

function isVisibleDiffRow(row: ParsedDiffRow | undefined): boolean {
  return !!row && isNavigableDiffRow(row);
}

export function renderDiffRows({
  theme,
  scope,
  fingerprint,
  file,
  width,
  height,
  commentsEpoch,
  highlightKey,
  diffCursorRow,
  diffScroll,
  rowMarkers,
  highlightedRows,
  rowCache,
  viewportCache,
}: {
  theme: Theme;
  scope: DiffScope;
  fingerprint: string;
  file: ParsedFilePatch;
  width: number;
  height: number;
  commentsEpoch: number;
  highlightKey: string;
  diffCursorRow: number;
  diffScroll: number;
  rowMarkers: Map<number, string>;
  highlightedRows: Map<number, string> | null;
  rowCache: DiffRowRenderCache | null;
  viewportCache: DiffViewportCache | null;
}): { lines: string[]; rowCache: DiffRowRenderCache; viewportCache: DiffViewportCache; diffScroll: number } {
  const lineNumberWidth = computeLineNumberWidth(file);
  const cache = rowCache
    && rowCache.scope === scope
    && rowCache.fingerprint === fingerprint
    && rowCache.fileKey === file.fileKey
    && rowCache.width === width
    && rowCache.lineNumberWidth === lineNumberWidth
    && rowCache.commentsEpoch === commentsEpoch
    && rowCache.highlightKey === highlightKey
    ? rowCache
    : createDiffRowRenderCache({ scope, fingerprint, fileKey: file.fileKey, width, lineNumberWidth, commentsEpoch, highlightKey });

  if (!cache.inlineEmphasisReady) {
    cache.inlineEmphasisRows = buildInlineEmphasisMap(file);
    cache.inlineEmphasisReady = true;
  }

  const maxRowIndex = Math.max(0, file.rows.length - 1);
  const boundedCursorRow = Math.max(0, Math.min(maxRowIndex, diffCursorRow));
  const boundedScroll = Math.max(0, Math.min(maxRowIndex, diffScroll));

  if (viewportCache
    && viewportCache.scope === scope
    && viewportCache.fingerprint === fingerprint
    && viewportCache.fileKey === file.fileKey
    && viewportCache.width === width
    && viewportCache.lineNumberWidth === lineNumberWidth
    && viewportCache.height === height
    && viewportCache.scroll === boundedScroll
    && viewportCache.commentsEpoch === commentsEpoch
    && viewportCache.highlightKey === highlightKey
    && viewportCache.selectedRow === boundedCursorRow) {
    return { lines: viewportCache.lines, rowCache: cache, viewportCache, diffScroll: boundedScroll };
  }

  const rowHeightInLines = (rowIndex: number): number => {
    const row = file.rows[rowIndex];
    if (!isVisibleDiffRow(row)) return 0;

    const cachedContent = cache.contentRows.get(row.rowIndex);
    if (cachedContent) return cachedContent.length;

    return rowLines({ theme, cache, row, rowMarkers, highlightedRows, selected: false }).length;
  };

  const visibleRows = file.rows.filter(isVisibleDiffRow);
  const cursorVisibleIndex = Math.max(0, visibleRows.findIndex((row) => row.rowIndex === boundedCursorRow));
  const boundedCursorHeight = rowHeightInLines(boundedCursorRow);
  const targetAbove = boundedCursorHeight >= height ? 0 : Math.max(0, Math.floor((height - boundedCursorHeight) / 2));

  let effectiveScroll = boundedScroll;

  if (visibleRows.length) {
    const lineStarts: number[] = [];
    let lineOffset = 0;
    for (let index = 0; index < visibleRows.length; index += 1) {
      const previousRow = index > 0 ? visibleRows[index - 1] : null;
      const row = visibleRows[index];
      const spacerHeight = previousRow?.hunkId && row.hunkId && previousRow.hunkId !== row.hunkId ? 1 : 0;
      lineOffset += spacerHeight;
      lineStarts.push(lineOffset);
      lineOffset += rowHeightInLines(row.rowIndex);
    }

    const cursorStart = lineStarts[cursorVisibleIndex] ?? 0;

    let bestStartVisibleIndex = cursorVisibleIndex;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= cursorVisibleIndex; index += 1) {
      const candidateStart = lineStarts[index] ?? 0;
      const cursorOffset = cursorStart - candidateStart;
      if (cursorOffset + boundedCursorHeight > height) continue;
      const distance = Math.abs(cursorOffset - targetAbove);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestStartVisibleIndex = index;
      }
    }

    effectiveScroll = visibleRows[bestStartVisibleIndex]?.rowIndex ?? boundedCursorRow;
  }

  if (viewportCache
    && viewportCache.scope === scope
    && viewportCache.fingerprint === fingerprint
    && viewportCache.fileKey === file.fileKey
    && viewportCache.width === width
    && viewportCache.lineNumberWidth === lineNumberWidth
    && viewportCache.height === height
    && viewportCache.scroll === effectiveScroll
    && viewportCache.commentsEpoch === commentsEpoch
    && viewportCache.highlightKey === highlightKey
    && viewportCache.selectedRow === boundedCursorRow) {
    return { lines: viewportCache.lines, rowCache: cache, viewportCache, diffScroll: effectiveScroll };
  }

  const lines: string[] = [];
  let lastVisibleHunkId: string | null = null;
  for (let rowIndex = effectiveScroll; rowIndex < file.rows.length && lines.length < height; rowIndex += 1) {
    const row = file.rows[rowIndex];
    if (!row) break;
    if (!isVisibleDiffRow(row)) continue;
    if (lines.length > 0 && row.hunkId && lastVisibleHunkId && row.hunkId !== lastVisibleHunkId) {
      lines.push(cache.emptyLine);
      if (lines.length >= height) break;
    }
    const selected = row.rowIndex === boundedCursorRow;
    const rendered = rowLines({ theme, cache, row, rowMarkers, highlightedRows, selected });
    for (const line of rendered) {
      if (lines.length >= height) break;
      lines.push(line);
    }
    lastVisibleHunkId = row.hunkId ?? lastVisibleHunkId;
  }
  lines.push(...Array.from({ length: Math.max(0, height - lines.length) }, () => cache.emptyLine));

  const nextViewportCache: DiffViewportCache = {
    scope,
    fingerprint,
    fileKey: file.fileKey,
    width,
    lineNumberWidth,
    height,
    scroll: effectiveScroll,
    commentsEpoch,
    highlightKey,
    selectedRow: boundedCursorRow,
    lines,
  };
  return { lines, rowCache: cache, viewportCache: nextViewportCache, diffScroll: effectiveScroll };
}
