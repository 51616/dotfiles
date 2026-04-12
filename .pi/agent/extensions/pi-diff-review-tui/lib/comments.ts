import { compactSnippetFromRows, fullHunkText, snippetFromRowRange } from "./diff-parser.ts";
import { isNavigableDiffRow } from "./navigation.ts";
import {
  anchorLocationEqual,
  buildCommentHunkRanges,
  buildLineContext,
  buildRangeContext,
  compareNullableLines,
  lineForRow,
  normalizeAnchorText,
  normalizedAnchorHash,
  rangeApplyTarget,
  rowTargetText,
  sideRows,
  trimContext,
  updateCommentFileMetadata,
} from "./comment-anchors.ts";
import type { CommentHunkRange } from "./comment-anchors.ts";
import type {
  CandidateRemap,
  CommentAnchor,
  CommentKind,
  CommentSide,
  CommentStatus,
  DiffScope,
  ParsedDiffRow,
  ParsedFilePatch,
  ReviewComment,
} from "./types.ts";

export {
  anchorLocationEqual,
  buildRangeSelection,
  commentAnchorForTarget,
  createComment,
  findCommentAtTarget,
  getCommentHunkRange,
} from "./comment-anchors.ts";

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

function okOrMovedStatus(comment: ReviewComment): Exclude<CommentStatus, "stale_unresolved"> {
  // Defensive fallback for older test fixtures / ephemeral objects.
  const original = (comment as unknown as { originalAnchor?: CommentAnchor }).originalAnchor ?? comment.anchor;
  return anchorLocationEqual(original, comment.anchor) ? "ok" : "moved";
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
  const counters: Record<DiffScope, number> = { t: 0, a: 0 };
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
