import { compactSnippetFromRows, fileSnippetFromRows, fullHunkText, sha256, snippetFromRowRange } from "./diff-parser.ts";
import { isNavigableDiffRow } from "./navigation.ts";
import type {
  CommentAnchor,
  CommentKind,
  CommentSide,
  CommentStatus,
  DiffScope,
  ParsedDiffRow,
  ParsedFilePatch,
  ParsedHunk,
  RangeSelection,
  ReviewComment,
} from "./types.ts";

export interface CommentHunkRange {
  id: string;
  header: string;
  rowStart: number;
  rowEnd: number;
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

const CONTEXT_RADIUS = 2;

function nextOrdinal(comments: ReviewComment[], scope: DiffScope): number {
  return comments
    .filter((comment) => comment.scope === scope)
    .reduce((max, comment) => Math.max(max, comment.ordinal), 0) + 1;
}

export function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizedAnchorHash(text: string): string {
  return sha256(normalizeAnchorText(text));
}

export function cloneAnchor(anchor: CommentAnchor): CommentAnchor {
  return {
    ...anchor,
    contextBefore: [...anchor.contextBefore],
    contextAfter: [...anchor.contextAfter],
  };
}

export function anchorLocationEqual(
  a: CommentAnchor | null | undefined,
  b: CommentAnchor | null | undefined,
): boolean {
  if (!a || !b) return true;
  return a.kind === b.kind
    && a.side === b.side
    && (a.line ?? null) === (b.line ?? null)
    && (a.startLine ?? null) === (b.startLine ?? null)
    && (a.endLine ?? null) === (b.endLine ?? null)
    && (a.applyLine ?? null) === (b.applyLine ?? null)
    && (a.applyStartLine ?? null) === (b.applyStartLine ?? null)
    && (a.applyEndLine ?? null) === (b.applyEndLine ?? null);
}

export function trimContext(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function searchHandleFromText(text: string): string {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => line.length >= 6) ?? lines[0] ?? "";
  return preferred.slice(0, 96);
}

export function rowTargetText(row: ParsedDiffRow | undefined): string {
  return row?.text?.trim() ?? "";
}

export function lineForRow(row: ParsedDiffRow | undefined, side: Exclude<CommentSide, "file">): number | null {
  if (!row) return null;
  return side === "old" ? row.oldLine ?? null : row.newLine ?? null;
}

function isChangeRow(row: ParsedDiffRow): boolean {
  return row.kind === "added" || row.kind === "removed";
}

function isSideRow(row: ParsedDiffRow, side: Exclude<CommentSide, "file">): boolean {
  return side === "old" ? row.oldLine != null : row.newLine != null;
}

export function sideRows(file: ParsedFilePatch, side: Exclude<CommentSide, "file">): ParsedDiffRow[] {
  return file.rows.filter((row) => isNavigableDiffRow(row) && isSideRow(row, side));
}

export function updateCommentFileMetadata(comment: ReviewComment, file: ParsedFilePatch): ReviewComment {
  return {
    ...comment,
    fileKey: file.fileKey,
    fileStatus: file.status,
    oldPath: file.oldPath,
    newPath: file.newPath,
    editablePath: file.editablePath,
    displayPath: file.displayPath,
  };
}

export function compareNullableLines(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function findNearestGitHunk(file: ParsedFilePatch, rowIndex: number): ParsedHunk | null {
  return file.hunks.find((hunk) => rowIndex >= hunk.rowStart && rowIndex <= hunk.rowEnd) ?? null;
}

export function buildCommentHunkRanges(file: ParsedFilePatch, gitHunk: ParsedHunk): CommentHunkRange[] {
  const ranges: CommentHunkRange[] = [];
  const rows = file.rows.filter((row) => row.rowIndex >= gitHunk.rowStart && row.rowIndex <= gitHunk.rowEnd);
  let start = -1;

  const flush = (endIndex: number) => {
    if (start < 0) return;
    const chunkRows = rows.slice(start, endIndex + 1).filter(isChangeRow);
    if (!chunkRows.length) {
      start = -1;
      return;
    }
    const oldLines = chunkRows.map((row) => row.oldLine).filter((line): line is number => line != null);
    const newLines = chunkRows.map((row) => row.newLine).filter((line): line is number => line != null);
    ranges.push({
      id: `${gitHunk.id}:chunk:${ranges.length + 1}`,
      header: gitHunk.header,
      rowStart: chunkRows[0].rowIndex,
      rowEnd: chunkRows[chunkRows.length - 1].rowIndex,
      oldStart: oldLines[0] ?? null,
      oldEnd: oldLines[oldLines.length - 1] ?? null,
      newStart: newLines[0] ?? null,
      newEnd: newLines[newLines.length - 1] ?? null,
    });
    start = -1;
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isChangeRow(row)) {
      if (start < 0) start = index;
      continue;
    }
    flush(index - 1);
  }
  flush(rows.length - 1);

  if (ranges.length) return ranges;
  return [{
    id: `${gitHunk.id}:chunk:1`,
    header: gitHunk.header,
    rowStart: gitHunk.rowStart,
    rowEnd: gitHunk.rowEnd,
    oldStart: gitHunk.oldStart,
    oldEnd: gitHunk.oldStart + Math.max(gitHunk.oldCount - 1, 0),
    newStart: gitHunk.newStart,
    newEnd: gitHunk.newStart + Math.max(gitHunk.newCount - 1, 0),
  }];
}

function rangeForSelection(file: ParsedFilePatch, selection: RangeSelection): {
  rowStart: number;
  rowEnd: number;
  lineStart: number | null;
  lineEnd: number | null;
  rows: ParsedDiffRow[];
  hunkId: string | null;
  hunkHeader: string | null;
} | null {
  if (selection.fileKey !== file.fileKey) return null;
  const rowStart = Math.max(0, Math.min(selection.startRowIndex, selection.endRowIndex));
  const rowEnd = Math.min(file.rows.length - 1, Math.max(selection.startRowIndex, selection.endRowIndex));
  const rows = file.rows
    .slice(rowStart, rowEnd + 1)
    .filter((row) => isNavigableDiffRow(row) && isSideRow(row, selection.side));
  if (!rows.length) return null;

  const lines = rows
    .map((row) => lineForRow(row, selection.side))
    .filter((line): line is number => line != null);

  return {
    rowStart: rows[0].rowIndex,
    rowEnd: rows[rows.length - 1].rowIndex,
    lineStart: lines[0] ?? null,
    lineEnd: lines[lines.length - 1] ?? null,
    rows,
    hunkId: rows[0]?.hunkId ?? null,
    hunkHeader: file.rows.find((row) => row.kind === "hunk_header" && row.hunkId === rows[0]?.hunkId)?.rawText ?? null,
  };
}

export function buildLineContext({
  file,
  row,
  side,
}: {
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  side: Exclude<CommentSide, "file">;
}): { targetText: string; contextBefore: string[]; contextAfter: string[]; searchText: string; normalizedTargetHash: string } {
  const rows = sideRows(file, side);
  const index = rows.findIndex((entry) => entry.rowIndex === row.rowIndex);
  const before = rows.slice(Math.max(0, index - CONTEXT_RADIUS), index).map((entry) => trimContext(entry.text)).filter(Boolean);
  const after = rows.slice(index + 1, index + 1 + CONTEXT_RADIUS).map((entry) => trimContext(entry.text)).filter(Boolean);
  const targetText = rowTargetText(row);
  return {
    targetText,
    contextBefore: before,
    contextAfter: after,
    searchText: searchHandleFromText(targetText),
    normalizedTargetHash: normalizedAnchorHash(targetText),
  };
}

export function buildRangeContext({
  file,
  side,
  rowStart,
  rowEnd,
}: {
  file: ParsedFilePatch;
  side: Exclude<CommentSide, "file">;
  rowStart: number;
  rowEnd: number;
}): { targetText: string; contextBefore: string[]; contextAfter: string[]; searchText: string; normalizedTargetHash: string } {
  const rows = sideRows(file, side);
  const selected = rows.filter((row) => row.rowIndex >= rowStart && row.rowIndex <= rowEnd);
  const firstSelectedIndex = selected.length ? rows.findIndex((row) => row.rowIndex === selected[0].rowIndex) : -1;
  const lastSelectedIndex = selected.length ? rows.findIndex((row) => row.rowIndex === selected[selected.length - 1].rowIndex) : -1;
  const before = firstSelectedIndex >= 0
    ? rows.slice(Math.max(0, firstSelectedIndex - CONTEXT_RADIUS), firstSelectedIndex).map((row) => trimContext(row.text)).filter(Boolean)
    : [];
  const after = lastSelectedIndex >= 0
    ? rows.slice(lastSelectedIndex + 1, lastSelectedIndex + 1 + CONTEXT_RADIUS).map((row) => trimContext(row.text)).filter(Boolean)
    : [];
  const targetText = selected.map((row) => rowTargetText(row)).join("\n");
  return {
    targetText,
    contextBefore: before,
    contextAfter: after,
    searchText: searchHandleFromText(targetText),
    normalizedTargetHash: normalizedAnchorHash(targetText),
  };
}

function findNearestApplyLine(file: ParsedFilePatch, rowIndex: number): number | null {
  for (let index = rowIndex; index < file.rows.length; index += 1) {
    const line = file.rows[index]?.newLine ?? null;
    if (line != null) return line;
  }
  for (let index = rowIndex; index >= 0; index -= 1) {
    const line = file.rows[index]?.newLine ?? null;
    if (line != null) return line;
  }
  return null;
}

function sideForHunkRange(row: ParsedDiffRow, range: CommentHunkRange): Exclude<CommentSide, "file"> {
  if (row.kind === "removed") return "old";
  if (row.kind === "added") return "new";
  return range.newStart != null ? "new" : "old";
}

export function rangeApplyTarget(file: ParsedFilePatch, range: CommentHunkRange | { rowStart: number; rowEnd: number; newStart: number | null; newEnd: number | null }): {
  line: number | null;
  startLine: number | null;
  endLine: number | null;
} {
  if (range.newStart != null) {
    return {
      line: range.newStart,
      startLine: range.newStart,
      endLine: range.newEnd ?? range.newStart,
    };
  }
  const line = findNearestApplyLine(file, range.rowStart);
  return { line, startLine: line, endLine: line };
}

function buildAnchorForRow(file: ParsedFilePatch, row: ParsedDiffRow, kind: Extract<CommentKind, "line" | "range" | "file">): CommentAnchor {
  if (kind === "file") {
    return {
      kind: "file",
      origin: null,
      side: "file",
      line: null,
      startLine: null,
      endLine: null,
      applyLine: file.editablePath ? 1 : null,
      applyStartLine: file.editablePath ? 1 : null,
      applyEndLine: file.editablePath ? 1 : null,
      hunkId: null,
      hunkHeader: null,
      targetText: file.displayPath,
      contextBefore: [],
      contextAfter: [],
      normalizedTargetHash: normalizedAnchorHash(file.displayPath),
      searchText: searchHandleFromText(file.displayPath),
    };
  }

  if (kind === "line") {
    const side: Exclude<CommentSide, "file"> = row.kind === "removed" ? "old" : "new";
    const line = lineForRow(row, side);
    const applyLine = side === "new" ? line : rangeApplyTarget(file, {
      rowStart: row.rowIndex,
      rowEnd: row.rowIndex,
      newStart: row.newLine ?? null,
      newEnd: row.newLine ?? null,
    }).line;
    const context = buildLineContext({ file, row, side });
    return {
      kind: "line",
      origin: null,
      side,
      line,
      startLine: line,
      endLine: line,
      applyLine,
      applyStartLine: applyLine,
      applyEndLine: applyLine,
      hunkId: row.hunkId ?? null,
      hunkHeader: file.rows.find((entry) => entry.kind === "hunk_header" && entry.hunkId === row.hunkId)?.rawText ?? null,
      targetText: context.targetText,
      contextBefore: context.contextBefore,
      contextAfter: context.contextAfter,
      normalizedTargetHash: context.normalizedTargetHash,
      searchText: context.searchText,
    };
  }

  const range = getCommentHunkRange(file, row.rowIndex);
  const effectiveRange = range ?? {
    id: row.hunkId ?? `range:${row.rowIndex}`,
    header: file.rows.find((entry) => entry.kind === "hunk_header" && entry.hunkId === row.hunkId)?.rawText ?? null ?? "",
    rowStart: row.rowIndex,
    rowEnd: row.rowIndex,
    oldStart: row.oldLine ?? null,
    oldEnd: row.oldLine ?? null,
    newStart: row.newLine ?? null,
    newEnd: row.newLine ?? null,
  };
  const side = sideForHunkRange(row, effectiveRange);
  const context = buildRangeContext({ file, side, rowStart: effectiveRange.rowStart, rowEnd: effectiveRange.rowEnd });
  const apply = rangeApplyTarget(file, effectiveRange);
  return {
    kind: "range",
    origin: "auto_chunk",
    side,
    line: null,
    startLine: side === "old" ? effectiveRange.oldStart : effectiveRange.newStart,
    endLine: side === "old" ? effectiveRange.oldEnd : effectiveRange.newEnd,
    applyLine: apply.line,
    applyStartLine: apply.startLine,
    applyEndLine: apply.endLine,
    hunkId: effectiveRange.id,
    hunkHeader: effectiveRange.header || null,
    targetText: context.targetText,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    normalizedTargetHash: context.normalizedTargetHash,
    searchText: context.searchText,
  };
}

function buildAnchorForSelection(file: ParsedFilePatch, selection: RangeSelection): CommentAnchor | null {
  const range = rangeForSelection(file, selection);
  if (!range) return null;
  const context = buildRangeContext({ file, side: selection.side, rowStart: range.rowStart, rowEnd: range.rowEnd });
  const apply = selection.side === "new"
    ? { line: range.lineStart, startLine: range.lineStart, endLine: range.lineEnd }
    : rangeApplyTarget(file, {
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        newStart: range.rows.map((row) => row.newLine).filter((line): line is number => line != null)[0] ?? null,
        newEnd: range.rows.map((row) => row.newLine).filter((line): line is number => line != null).slice(-1)[0] ?? null,
      });

  return {
    kind: "range",
    origin: "user_range",
    side: selection.side,
    line: null,
    startLine: range.lineStart,
    endLine: range.lineEnd,
    applyLine: apply.line,
    applyStartLine: apply.startLine,
    applyEndLine: apply.endLine,
    hunkId: range.hunkId,
    hunkHeader: range.hunkHeader,
    targetText: context.targetText,
    contextBefore: context.contextBefore,
    contextAfter: context.contextAfter,
    normalizedTargetHash: context.normalizedTargetHash,
    searchText: context.searchText,
  };
}

function createCommentRecord({
  comments,
  file,
  scope,
  body,
  anchor,
  compactSnippet,
  fullSnippet,
}: {
  comments: ReviewComment[];
  file: ParsedFilePatch;
  scope: DiffScope;
  body: string;
  anchor: CommentAnchor;
  compactSnippet: string;
  fullSnippet: string;
}): ReviewComment {
  return {
    id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ordinal: nextOrdinal(comments, scope),
    fileKey: file.fileKey,
    fileStatus: file.status,
    oldPath: file.oldPath,
    newPath: file.newPath,
    editablePath: file.editablePath,
    displayPath: file.displayPath,
    scope,
    originalAnchor: cloneAnchor(anchor),
    anchor,
    body: body.trim(),
    compactSnippet,
    fullHunkText: fullSnippet,
    status: "ok",
    remapNotes: [],
    candidateRemaps: [],
  };
}

export function getCommentHunkRange(file: ParsedFilePatch, rowIndex: number): CommentHunkRange | null {
  const gitHunk = findNearestGitHunk(file, rowIndex);
  if (!gitHunk) return null;
  const ranges = buildCommentHunkRanges(file, gitHunk);
  const containing = ranges.find((range) => rowIndex >= range.rowStart && rowIndex <= range.rowEnd);
  if (containing) return containing;

  let best: CommentHunkRange | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const range of ranges) {
    const distance = rowIndex < range.rowStart
      ? range.rowStart - rowIndex
      : rowIndex > range.rowEnd
        ? rowIndex - range.rowEnd
        : 0;
    if (distance < bestDistance) {
      best = range;
      bestDistance = distance;
    }
  }
  return best;
}

export function commentAnchorForTarget(file: ParsedFilePatch, row: ParsedDiffRow, kind: CommentKind, selection?: RangeSelection | null): CommentAnchor | null {
  if (kind === "range" && selection) return buildAnchorForSelection(file, selection);
  return buildAnchorForRow(file, row, kind);
}

export function buildRangeSelection({
  file,
  side,
  startRowIndex,
  endRowIndex,
}: {
  file: ParsedFilePatch;
  side: Exclude<CommentSide, "file">;
  startRowIndex: number;
  endRowIndex: number;
}): RangeSelection | null {
  const range = rangeForSelection(file, {
    fileKey: file.fileKey,
    displayPath: file.displayPath,
    side,
    startRowIndex,
    endRowIndex,
    startLine: null,
    endLine: null,
  });
  if (!range) return null;
  return {
    fileKey: file.fileKey,
    displayPath: file.displayPath,
    side,
    startRowIndex: range.rowStart,
    endRowIndex: range.rowEnd,
    startLine: range.lineStart,
    endLine: range.lineEnd,
  };
}

export function findCommentAtTarget({
  comments,
  file,
  row,
  kind,
  scope,
  selection,
}: {
  comments: ReviewComment[];
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  kind: CommentKind;
  scope: DiffScope;
  selection?: RangeSelection | null;
}): ReviewComment | null {
  const anchor = commentAnchorForTarget(file, row, kind, selection);
  if (!anchor) return null;
  return comments.find((comment) => comment.scope === scope
    && comment.fileKey === file.fileKey
    && comment.anchor.kind === anchor.kind
    && comment.anchor.origin === anchor.origin
    && comment.anchor.side === anchor.side
    && comment.anchor.startLine === anchor.startLine
    && comment.anchor.endLine === anchor.endLine
    && comment.anchor.line === anchor.line
    && comment.anchor.hunkId === anchor.hunkId) ?? null;
}

export function createComment({
  comments,
  file,
  row,
  kind,
  scope,
  body,
  selection,
}: {
  comments: ReviewComment[];
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  kind: CommentKind;
  scope: DiffScope;
  body: string;
  selection?: RangeSelection | null;
}): ReviewComment {
  const anchor = commentAnchorForTarget(file, row, kind, selection);
  if (!anchor) {
    throw new Error("Could not build comment anchor.");
  }

  if (kind === "file") {
    return createCommentRecord({
      comments,
      file,
      scope,
      body,
      anchor,
      compactSnippet: fileSnippetFromRows(file.rows, 8),
      fullSnippet: fileSnippetFromRows(file.rows, 16),
    });
  }

  if (kind === "line") {
    return createCommentRecord({
      comments,
      file,
      scope,
      body,
      anchor,
      compactSnippet: compactSnippetFromRows(file.rows, row.rowIndex, 3),
      fullSnippet: anchor.hunkId ? fullHunkText(file.rows, anchor.hunkId) : compactSnippetFromRows(file.rows, row.rowIndex, 3),
    });
  }

  if (anchor.origin === "user_range" && selection) {
    const range = rangeForSelection(file, selection);
    if (!range) throw new Error("Could not resolve range selection.");
    return createCommentRecord({
      comments,
      file,
      scope,
      body,
      anchor,
      compactSnippet: snippetFromRowRange(file.rows, range.rowStart, range.rowEnd, 2),
      fullSnippet: snippetFromRowRange(file.rows, range.rowStart, range.rowEnd, 0),
    });
  }

  const autoRange = getCommentHunkRange(file, row.rowIndex);
  return createCommentRecord({
    comments,
    file,
    scope,
    body,
    anchor,
    compactSnippet: autoRange
      ? snippetFromRowRange(file.rows, autoRange.rowStart, autoRange.rowEnd, 1)
      : compactSnippetFromRows(file.rows, row.rowIndex, 3),
    fullSnippet: anchor.hunkId ? fullHunkText(file.rows, anchor.hunkId) : compactSnippetFromRows(file.rows, row.rowIndex, 3),
  });
}
