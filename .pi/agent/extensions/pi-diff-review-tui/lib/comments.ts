import { compactSnippetFromRows, fileSnippetFromRows, fullHunkText, sha256, snippetFromRowRange } from "./diff-parser.ts";
import { isNavigableDiffRow } from "./navigation.ts";
import type {
  CandidateRemap,
  CommentAnchor,
  CommentKind,
  CommentRangeOrigin,
  CommentSide,
  CommentStatus,
  DiffScope,
  FileStatus,
  ParsedDiffRow,
  ParsedFilePatch,
  ParsedHunk,
  RangeSelection,
  ReviewComment,
} from "./types.ts";

interface CommentHunkRange {
  id: string;
  header: string;
  rowStart: number;
  rowEnd: number;
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

interface RangeWindowCandidate {
  rowStart: number;
  rowEnd: number;
  lineStart: number | null;
  lineEnd: number | null;
  hunkId: string | null;
  hunkHeader: string | null;
  text: string;
  preview: string;
}

const AUTO_REMAP_SCORE_MIN = 72;
const AUTO_REMAP_MARGIN_MIN = 15;
const CONTEXT_RADIUS = 2;

function nextOrdinal(comments: ReviewComment[], scope: DiffScope): number {
  return comments
    .filter((comment) => comment.scope === scope)
    .reduce((max, comment) => Math.max(max, comment.ordinal), 0) + 1;
}

function normalizeAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizedAnchorHash(text: string): string {
  return sha256(normalizeAnchorText(text));
}

function cloneAnchor(anchor: CommentAnchor): CommentAnchor {
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

function okOrMovedStatus(comment: ReviewComment): Exclude<CommentStatus, "stale_unresolved"> {
  // Defensive fallback for older test fixtures / ephemeral objects.
  const original = (comment as unknown as { originalAnchor?: CommentAnchor }).originalAnchor ?? comment.anchor;
  return anchorLocationEqual(original, comment.anchor) ? "ok" : "moved";
}

function trimContext(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function searchHandleFromText(text: string): string {
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = lines.find((line) => line.length >= 6) ?? lines[0] ?? "";
  return preferred.slice(0, 96);
}

function rowTargetText(row: ParsedDiffRow | undefined): string {
  return row?.text?.trim() ?? "";
}

function lineForRow(row: ParsedDiffRow | undefined, side: Exclude<CommentSide, "file">): number | null {
  if (!row) return null;
  return side === "old" ? row.oldLine ?? null : row.newLine ?? null;
}

function isChangeRow(row: ParsedDiffRow): boolean {
  return row.kind === "added" || row.kind === "removed";
}

function isSideRow(row: ParsedDiffRow, side: Exclude<CommentSide, "file">): boolean {
  return side === "old" ? row.oldLine != null : row.newLine != null;
}

function sideRows(file: ParsedFilePatch, side: Exclude<CommentSide, "file">): ParsedDiffRow[] {
  return file.rows.filter((row) => isNavigableDiffRow(row) && isSideRow(row, side));
}

function updateCommentFileMetadata(comment: ReviewComment, file: ParsedFilePatch): ReviewComment {
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

function compareNullableLines(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

function findNearestGitHunk(file: ParsedFilePatch, rowIndex: number): ParsedHunk | null {
  return file.hunks.find((hunk) => rowIndex >= hunk.rowStart && rowIndex <= hunk.rowEnd) ?? null;
}

function buildCommentHunkRanges(file: ParsedFilePatch, gitHunk: ParsedHunk): CommentHunkRange[] {
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

function buildLineContext({
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

function buildRangeContext({
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

function rangeApplyTarget(file: ParsedFilePatch, range: CommentHunkRange | { rowStart: number; rowEnd: number; newStart: number | null; newEnd: number | null }): {
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

function candidateRangeWindows(file: ParsedFilePatch, side: Exclude<CommentSide, "file">, spanLength: number): RangeWindowCandidate[] {
  const rows = sideRows(file, side);
  if (!rows.length) return [];
  const length = Math.max(1, spanLength);
  const windows: RangeWindowCandidate[] = [];
  for (let index = 0; index <= rows.length - length; index += 1) {
    const slice = rows.slice(index, index + length);
    if (!slice.length) continue;
    const lines = slice.map((row) => lineForRow(row, side)).filter((line): line is number => line != null);
    windows.push({
      rowStart: slice[0].rowIndex,
      rowEnd: slice[slice.length - 1].rowIndex,
      lineStart: lines[0] ?? null,
      lineEnd: lines[lines.length - 1] ?? null,
      hunkId: slice[0]?.hunkId ?? null,
      hunkHeader: file.rows.find((row) => row.kind === "hunk_header" && row.hunkId === slice[0]?.hunkId)?.rawText ?? null,
      text: slice.map((row) => rowTargetText(row)).join("\n"),
      preview: snippetFromRowRange(file.rows, slice[0].rowIndex, slice[slice.length - 1].rowIndex, 1),
    });
  }
  return windows;
}

function contextScore({
  contextBefore,
  contextAfter,
  candidateBefore,
  candidateAfter,
}: {
  contextBefore: string[];
  contextAfter: string[];
  candidateBefore: string[];
  candidateAfter: string[];
}): number {
  let score = 0;
  for (let index = 0; index < Math.min(contextBefore.length, candidateBefore.length); index += 1) {
    const expected = contextBefore[contextBefore.length - 1 - index];
    const actual = candidateBefore[candidateBefore.length - 1 - index];
    if (trimContext(expected) && trimContext(expected) === trimContext(actual)) score += 8;
  }
  for (let index = 0; index < Math.min(contextAfter.length, candidateAfter.length); index += 1) {
    const expected = contextAfter[index];
    const actual = candidateAfter[index];
    if (trimContext(expected) && trimContext(expected) === trimContext(actual)) score += 8;
  }
  return score;
}

function scoreLineCandidate({
  comment,
  file,
  row,
  side,
}: {
  comment: ReviewComment;
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  side: Exclude<CommentSide, "file">;
}): number {
  const rows = sideRows(file, side);
  const index = rows.findIndex((entry) => entry.rowIndex === row.rowIndex);
  const before = rows.slice(Math.max(0, index - CONTEXT_RADIUS), index).map((entry) => entry.text);
  const after = rows.slice(index + 1, index + 1 + CONTEXT_RADIUS).map((entry) => entry.text);
  const normalized = normalizedAnchorHash(rowTargetText(row));
  const candidateLine = lineForRow(row, side);
  const distance = comment.anchor.line != null && candidateLine != null ? Math.abs(comment.anchor.line - candidateLine) : 0;
  return (normalized === comment.anchor.normalizedTargetHash ? 40 : 0)
    + (rowTargetText(row) === comment.anchor.targetText ? 25 : 0)
    + (normalizeAnchorText(rowTargetText(row)) === normalizeAnchorText(comment.anchor.targetText) ? 18 : 0)
    + contextScore({
      contextBefore: comment.anchor.contextBefore,
      contextAfter: comment.anchor.contextAfter,
      candidateBefore: before,
      candidateAfter: after,
    })
    + Math.max(0, 12 - Math.min(distance, 12));
}

function scoreRangeCandidate({
  comment,
  file,
  side,
  candidate,
}: {
  comment: ReviewComment;
  file: ParsedFilePatch;
  side: Exclude<CommentSide, "file">;
  candidate: RangeWindowCandidate;
}): number {
  const rows = sideRows(file, side);
  const startIndex = rows.findIndex((row) => row.rowIndex === candidate.rowStart);
  const endIndex = rows.findIndex((row) => row.rowIndex === candidate.rowEnd);
  const before = startIndex >= 0 ? rows.slice(Math.max(0, startIndex - CONTEXT_RADIUS), startIndex).map((row) => row.text) : [];
  const after = endIndex >= 0 ? rows.slice(endIndex + 1, endIndex + 1 + CONTEXT_RADIUS).map((row) => row.text) : [];
  const normalized = normalizedAnchorHash(candidate.text);
  const targetStart = comment.anchor.startLine ?? comment.anchor.line;
  const distance = targetStart != null && candidate.lineStart != null ? Math.abs(targetStart - candidate.lineStart) : 0;
  return (normalized === comment.anchor.normalizedTargetHash ? 44 : 0)
    + (candidate.text === comment.anchor.targetText ? 24 : 0)
    + (normalizeAnchorText(candidate.text) === normalizeAnchorText(comment.anchor.targetText) ? 18 : 0)
    + (candidate.hunkHeader && candidate.hunkHeader === comment.anchor.hunkHeader ? 8 : 0)
    + contextScore({
      contextBefore: comment.anchor.contextBefore,
      contextAfter: comment.anchor.contextAfter,
      candidateBefore: before,
      candidateAfter: after,
    })
    + Math.max(0, 10 - Math.min(distance, 10));
}

function buildLineCandidates(file: ParsedFilePatch, comment: ReviewComment, side: Exclude<CommentSide, "file">): CandidateRemap[] {
  const rows = sideRows(file, side)
    .map((row) => ({ row, matchScore: scoreLineCandidate({ comment, file, row, side }) }))
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || compareNullableLines(lineForRow(a.row, side), lineForRow(b.row, side)));

  return rows.slice(0, 9).map(({ row, matchScore }) => ({
    kind: "candidate",
    fileKey: file.fileKey,
    displayPath: file.displayPath,
    side,
    line: lineForRow(row, side),
    startLine: lineForRow(row, side),
    endLine: lineForRow(row, side),
    hunkId: row.hunkId ?? null,
    rowIndex: row.rowIndex,
    preview: row.rawText,
    matchScore,
  }));
}

function buildRangeCandidates(file: ParsedFilePatch, comment: ReviewComment, side: Exclude<CommentSide, "file">): CandidateRemap[] {
  const spanLength = Math.max(1, (comment.anchor.endLine ?? comment.anchor.startLine ?? comment.anchor.line ?? 0) - (comment.anchor.startLine ?? comment.anchor.line ?? 0) + 1);
  const windows = (comment.anchor.origin === "auto_chunk"
    ? file.hunks.flatMap((hunk) => buildCommentHunkRanges(file, hunk).map((range) => ({
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        lineStart: side === "old" ? range.oldStart : range.newStart,
        lineEnd: side === "old" ? range.oldEnd : range.newEnd,
        hunkId: range.id,
        hunkHeader: range.header,
        text: sideRows(file, side)
          .filter((row) => row.rowIndex >= range.rowStart && row.rowIndex <= range.rowEnd)
          .map((row) => rowTargetText(row))
          .join("\n"),
        preview: snippetFromRowRange(file.rows, range.rowStart, range.rowEnd, 1),
      })))
    : candidateRangeWindows(file, side, spanLength))
    .map((candidate) => ({ candidate, matchScore: scoreRangeCandidate({ comment, file, side, candidate }) }))
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore || compareNullableLines(a.candidate.lineStart, b.candidate.lineStart));

  return windows.slice(0, 9).map(({ candidate, matchScore }) => ({
    kind: "candidate",
    fileKey: file.fileKey,
    displayPath: file.displayPath,
    side,
    line: candidate.lineStart,
    startLine: candidate.lineStart,
    endLine: candidate.lineEnd,
    hunkId: candidate.hunkId,
    rowIndex: candidate.rowStart,
    preview: candidate.preview,
    matchScore,
  }));
}

function autoRemapCandidate(candidates: CandidateRemap[]): CandidateRemap | null {
  const [best, second] = candidates;
  if (!best) return null;
  if (best.matchScore < AUTO_REMAP_SCORE_MIN) return null;
  if (second && best.matchScore - second.matchScore < AUTO_REMAP_MARGIN_MIN) return null;
  return best;
}

function remappedAnchorForCandidate(comment: ReviewComment, candidate: CandidateRemap): CommentAnchor {
  if (comment.anchor.kind === "line") {
    return {
      ...comment.anchor,
      side: candidate.side,
      line: candidate.line,
      startLine: candidate.line,
      endLine: candidate.line,
      applyLine: candidate.side === "new" ? candidate.line : comment.anchor.applyLine,
      applyStartLine: candidate.side === "new" ? candidate.startLine : comment.anchor.applyStartLine,
      applyEndLine: candidate.side === "new" ? candidate.endLine : comment.anchor.applyEndLine,
      hunkId: candidate.hunkId,
    };
  }

  return {
    ...comment.anchor,
    side: candidate.side,
    line: null,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    applyLine: candidate.side === "new" ? candidate.startLine : comment.anchor.applyLine,
    applyStartLine: candidate.side === "new" ? candidate.startLine : comment.anchor.applyStartLine,
    applyEndLine: candidate.side === "new" ? candidate.endLine : comment.anchor.applyEndLine,
    hunkId: candidate.hunkId,
  };
}

function findMatchingRange(file: ParsedFilePatch, comment: ReviewComment): CommentHunkRange | null {
  const side: Exclude<CommentSide, "file"> = comment.anchor.side === "old" ? "old" : "new";
  const ranges = file.hunks.flatMap((hunk) => buildCommentHunkRanges(file, hunk));
  const exact = ranges.find((range) => {
    const start = side === "old" ? range.oldStart : range.newStart;
    const end = side === "old" ? range.oldEnd : range.newEnd;
    return range.header === comment.anchor.hunkHeader && start === comment.anchor.startLine && end === comment.anchor.endLine;
  });
  if (exact) return exact;

  const sameStart = ranges.find((range) => {
    const start = side === "old" ? range.oldStart : range.newStart;
    return range.header === comment.anchor.hunkHeader && start === comment.anchor.startLine;
  });
  if (sameStart) return sameStart;

  return ranges.find((range) => {
    const start = side === "old" ? range.oldStart : range.newStart;
    const end = side === "old" ? range.oldEnd : range.newEnd;
    return start === comment.anchor.startLine && end === comment.anchor.endLine;
  }) ?? null;
}

function refreshAnchorContext(comment: ReviewComment, file: ParsedFilePatch): ReviewComment {
  if (comment.anchor.kind === "file") return comment;
  const side: Exclude<CommentSide, "file"> = comment.anchor.side === "old" ? "old" : "new";
  const rowIndex = mapCommentToRow(file, comment);
  if (rowIndex == null) return comment;
  const row = file.rows[rowIndex];
  if (!row) return comment;

  if (comment.anchor.kind === "line") {
    const context = buildLineContext({ file, row, side });
    return {
      ...comment,
      anchor: {
        ...comment.anchor,
        targetText: context.targetText,
        contextBefore: context.contextBefore,
        contextAfter: context.contextAfter,
        normalizedTargetHash: context.normalizedTargetHash,
        searchText: context.searchText,
      },
      compactSnippet: compactSnippetFromRows(file.rows, rowIndex, 3),
      fullHunkText: comment.anchor.hunkId ? fullHunkText(file.rows, comment.anchor.hunkId) : compactSnippetFromRows(file.rows, rowIndex, 3),
    };
  }

  const rowStart = file.rows.find((entry) => {
    if (side === "old") return entry.oldLine === comment.anchor.startLine;
    return entry.newLine === comment.anchor.startLine;
  })?.rowIndex ?? rowIndex;
  const rowEnd = file.rows.find((entry) => {
    if (side === "old") return entry.oldLine === comment.anchor.endLine;
    return entry.newLine === comment.anchor.endLine;
  })?.rowIndex ?? rowIndex;
  const context = buildRangeContext({ file, side, rowStart, rowEnd });
  return {
    ...comment,
    anchor: {
      ...comment.anchor,
      targetText: context.targetText,
      contextBefore: context.contextBefore,
      contextAfter: context.contextAfter,
      normalizedTargetHash: context.normalizedTargetHash,
      searchText: context.searchText,
    },
    compactSnippet: snippetFromRowRange(file.rows, rowStart, rowEnd, 2),
    fullHunkText: comment.anchor.hunkId ? fullHunkText(file.rows, comment.anchor.hunkId) : snippetFromRowRange(file.rows, rowStart, rowEnd, 0),
  };
}

function resolveCommentFile(comment: ReviewComment, files: ParsedFilePatch[] | ParsedFilePatch | undefined): ParsedFilePatch | undefined {
  if (!files) return undefined;
  const list = Array.isArray(files) ? files : [files];
  return list.find((file) => file.fileKey === comment.fileKey)
    ?? list.find((file) => file.newPath && (file.newPath === comment.newPath || file.newPath === comment.editablePath))
    ?? list.find((file) => file.oldPath && (file.oldPath === comment.oldPath || file.oldPath === comment.editablePath))
    ?? list.find((file) => file.displayPath === comment.displayPath);
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

export function formatAnchorLocation(displayPath: string, anchor: CommentAnchor): string {
  if (anchor.kind === "file" || anchor.side === "file") return `${displayPath} (file)`;
  const suffix = anchor.side === "old" ? " (old)" : " (new)";
  const start = anchor.startLine ?? anchor.line;
  const end = anchor.endLine ?? anchor.line;
  if (start == null) return `${displayPath}${suffix}`;
  if (anchor.kind === "range" && end != null && end !== start) return `${displayPath}:${start}-${end}${suffix}`;
  return `${displayPath}:${start}${suffix}`;
}

export function formatCommentLocation(comment: ReviewComment): string {
  return formatAnchorLocation(comment.displayPath, comment.anchor);
}

export function formatOriginalCommentLocation(comment: ReviewComment): string | null {
  const original = (comment as unknown as { originalAnchor?: CommentAnchor }).originalAnchor;
  if (!original) return null;
  if (anchorLocationEqual(original, comment.anchor)) return null;
  return formatAnchorLocation(comment.displayPath, original);
}

export function summarizeCommentStatus(status: CommentStatus): string {
  if (status === "moved") return "moved";
  if (status === "stale_unresolved") return "stale!";
  return "ok";
}

export function mapCommentToRow(file: ParsedFilePatch, comment: ReviewComment): number | null {
  if (comment.anchor.kind === "file") {
    return file.rows.find((row) => isNavigableDiffRow(row))?.rowIndex ?? 0;
  }

  const side = comment.anchor.side;
  const line = comment.anchor.line ?? comment.anchor.startLine;
  if (line == null || side === "file") return null;

  const row = file.rows.find((entry) => {
    if (side === "old") return entry.oldLine === line;
    if (side === "new") return entry.newLine === line;
    return false;
  });

  return row?.rowIndex ?? null;
}

export function commentsForScope(comments: ReviewComment[], scope: DiffScope, includeAllScopes = false): ReviewComment[] {
  return comments.filter((comment) => includeAllScopes || comment.scope === scope);
}

export function commentCoversRow(file: ParsedFilePatch, comment: ReviewComment, row: ParsedDiffRow): boolean {
  if (comment.fileKey !== file.fileKey) return false;
  if (comment.anchor.kind === "file" || comment.anchor.side === "file") return true;
  const rowLine = comment.anchor.side === "old" ? row.oldLine ?? null : row.newLine ?? null;
  if (rowLine == null) return false;
  if (comment.anchor.kind === "line") return rowLine === comment.anchor.line;
  const start = comment.anchor.startLine ?? comment.anchor.line;
  const end = comment.anchor.endLine ?? comment.anchor.startLine ?? comment.anchor.line;
  if (start == null) return false;
  return rowLine >= start && rowLine <= (end ?? start);
}

export function commentsAtLocation({
  comments,
  file,
  row,
  scope,
}: {
  comments: ReviewComment[];
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  scope: DiffScope;
}): ReviewComment[] {
  return comments
    .filter((comment) => comment.scope === scope && commentCoversRow(file, comment, row))
    .sort(compareCommentsByLocation);
}

export function compareCommentsByLocation(a: ReviewComment, b: ReviewComment): number {
  const aPath = a.editablePath ?? a.newPath ?? a.oldPath ?? a.displayPath;
  const bPath = b.editablePath ?? b.newPath ?? b.oldPath ?? b.displayPath;
  if (aPath !== bPath) return aPath.localeCompare(bPath);

  const aApply = a.anchor.applyStartLine ?? a.anchor.applyLine ?? Number.MAX_SAFE_INTEGER;
  const bApply = b.anchor.applyStartLine ?? b.anchor.applyLine ?? Number.MAX_SAFE_INTEGER;
  if (aApply !== bApply) return aApply - bApply;

  const aAnchor = a.anchor.startLine ?? a.anchor.line ?? Number.MAX_SAFE_INTEGER;
  const bAnchor = b.anchor.startLine ?? b.anchor.line ?? Number.MAX_SAFE_INTEGER;
  if (aAnchor !== bAnchor) return aAnchor - bAnchor;

  const kindRank = (kind: CommentKind) => kind === "line" ? 0 : kind === "range" ? 1 : 2;
  if (a.anchor.kind !== b.anchor.kind) return kindRank(a.anchor.kind) - kindRank(b.anchor.kind);
  return a.ordinal - b.ordinal;
}

export function renumberComments(comments: ReviewComment[]): ReviewComment[] {
  const counters: Record<DiffScope, number> = { u: 0, s: 0, a: 0 };
  return comments.map((comment) => ({
    ...comment,
    ordinal: ++counters[comment.scope],
  }));
}

export function revalidateComment(comment: ReviewComment, files: ParsedFilePatch[] | ParsedFilePatch | undefined): ReviewComment {
  const file = resolveCommentFile(comment, files);
  if (!file) {
    return {
      ...comment,
      status: "stale_unresolved",
      candidateRemaps: [],
      remapNotes: [...comment.remapNotes],
    };
  }

  let updated = updateCommentFileMetadata(comment, file);

  if (updated.anchor.kind === "file") {
    return {
      ...updated,
      status: okOrMovedStatus(updated),
      candidateRemaps: [],
    };
  }

  const side: Exclude<CommentSide, "file"> = updated.anchor.side === "old" ? "old" : "new";
  if (updated.anchor.kind === "range" && updated.anchor.origin === "auto_chunk") {
    const matchingRange = findMatchingRange(file, updated);
    if (matchingRange) {
      const apply = rangeApplyTarget(file, matchingRange);
      updated = refreshAnchorContext({
        ...updated,
        anchor: {
          ...updated.anchor,
          hunkId: matchingRange.id,
          hunkHeader: matchingRange.header,
          startLine: side === "old" ? matchingRange.oldStart : matchingRange.newStart,
          endLine: side === "old" ? matchingRange.oldEnd : matchingRange.newEnd,
          applyLine: apply.line,
          applyStartLine: apply.startLine,
          applyEndLine: apply.endLine,
        },
        candidateRemaps: [],
      }, file);
      return { ...updated, status: okOrMovedStatus(updated), candidateRemaps: [] };
    }
  }

  if (updated.anchor.kind === "line") {
    const exact = sideRows(file, side).find((row) => {
      const line = lineForRow(row, side);
      return line === updated.anchor.line && normalizedAnchorHash(rowTargetText(row)) === updated.anchor.normalizedTargetHash;
    });
    if (exact) {
      const refreshed = refreshAnchorContext({
        ...updated,
        candidateRemaps: [],
      }, file);
      return { ...refreshed, status: okOrMovedStatus(refreshed), candidateRemaps: [] };
    }

    const candidates = buildLineCandidates(file, updated, side);
    const auto = autoRemapCandidate(candidates);
    if (auto) {
      const refreshed = refreshAnchorContext({
        ...updated,
        anchor: remappedAnchorForCandidate(updated, auto),
        candidateRemaps: [],
        remapNotes: [...updated.remapNotes, `Auto-remapped to ${file.displayPath}:${auto.line ?? "?"}`],
      }, file);
      return { ...refreshed, status: okOrMovedStatus(refreshed), candidateRemaps: [] };
    }

    return {
      ...updated,
      status: "stale_unresolved",
      candidateRemaps: candidates,
    };
  }

  const rangeCandidates = buildRangeCandidates(file, updated, side);
  const autoRange = autoRemapCandidate(rangeCandidates);
  if (autoRange) {
    const refreshed = refreshAnchorContext({
      ...updated,
      anchor: remappedAnchorForCandidate(updated, autoRange),
      candidateRemaps: [],
      remapNotes: [...updated.remapNotes, `Auto-remapped to ${file.displayPath}:${autoRange.startLine ?? autoRange.line ?? "?"}`],
    }, file);
    return { ...refreshed, status: okOrMovedStatus(refreshed), candidateRemaps: [] };
  }

  return {
    ...updated,
    status: "stale_unresolved",
    candidateRemaps: rangeCandidates,
  };
}
