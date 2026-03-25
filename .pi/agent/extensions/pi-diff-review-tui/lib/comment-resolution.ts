import type { Theme } from "@mariozechner/pi-coding-agent";
import { anchorLocationEqual, buildRangeSelection, commentAnchorForTarget, getCommentHunkRange, renumberComments } from "./comments.ts";
import { scopeHotkey } from "./scope.ts";
import type { CommentKind, CommentSide, DiffScope, ParsedDiffRow, ParsedFilePatch, RangeSelection, ReviewComment } from "./types.ts";

export function printableChar(data: string): string | null {
  if (!data || data.length !== 1) return null;
  const code = data.charCodeAt(0);
  if (code < 32 || code === 127) return null;
  return data;
}

export function formatScopeBadge(theme: Theme, scope: DiffScope): string {
  return theme.fg("muted", `[${scopeHotkey(scope)}]`);
}

export function lineForRowAndSide(row: ParsedDiffRow, side: CommentSide): number | null {
  if (side === "old") return row.oldLine ?? null;
  if (side === "new") return row.newLine ?? null;
  return null;
}

export function hunkSideForRow(row: ParsedDiffRow, range: { oldStart: number | null; newStart: number | null }): CommentSide {
  if (row.kind === "removed") return "old";
  if (row.kind === "added") return "new";
  return range.newStart != null ? "new" : "old";
}

export function describeRangeSelection(selection: RangeSelection | null): string | null {
  if (!selection) return null;
  const start = selection.startLine;
  const end = selection.endLine;
  const anchor = selection.side === "old" ? "a" : "b";
  if (start == null) return `${selection.displayPath} (${anchor})`;
  if (end != null && end !== start) return `${selection.displayPath}:${anchor}${start}-${end}`;
  return `${selection.displayPath}:${anchor}${start}`;
}

export function describeCommentTarget(
  file: ParsedFilePatch,
  row: ParsedDiffRow,
  kind: CommentKind,
  selection?: RangeSelection | null,
): string {
  if (kind === "file") return `${file.displayPath} (file)`;
  if (kind === "range" && selection) {
    const description = describeRangeSelection(selection);
    return description ?? `${file.displayPath} (range)`;
  }

  const anchor = commentAnchorForTarget(file, row, kind);
  if (!anchor) return `${file.displayPath} (${kind})`;
  if (anchor.kind === "line") {
    const line = anchor.line;
    return line == null ? file.displayPath : `${file.displayPath}:${line} (${anchor.side})`;
  }
  if (anchor.kind === "range") {
    const start = anchor.startLine;
    const end = anchor.endLine;
    if (start == null) return `${file.displayPath} (range)`;
    return end != null && end > start ? `${file.displayPath}:${start}-${end} (${anchor.side})` : `${file.displayPath}:${start} (${anchor.side})`;
  }
  return `${file.displayPath} (file)`;
}

export function unresolvedCommentsForScope(comments: ReviewComment[], scope: DiffScope): ReviewComment[] {
  return comments.filter((comment) => comment.scope === scope && comment.status === "stale_unresolved");
}

export function removeCommentById(comments: ReviewComment[], commentId: string): ReviewComment[] {
  return renumberComments(comments.filter((comment) => comment.id !== commentId));
}

export function updateCommentBody(comments: ReviewComment[], commentId: string, body: string): ReviewComment[] {
  const trimmed = body.trim();
  if (!trimmed) return removeCommentById(comments, commentId);
  return comments.map((comment) => comment.id === commentId ? { ...comment, body: trimmed } : comment);
}

export function resolveCommentAtCursor({
  comments,
  comment,
  file,
  row,
  downgrade,
  selection,
}: {
  comments: ReviewComment[];
  comment: ReviewComment;
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  downgrade: "line" | "range" | "file";
  selection?: RangeSelection | null;
}): ReviewComment[] | null {
  if (downgrade === "file") {
    return comments.map((entry) => {
      if (entry.id !== comment.id) return entry;
      const nextAnchor = {
        ...entry.anchor,
        kind: "file" as const,
        origin: null,
        side: "file" as const,
        line: null,
        startLine: null,
        endLine: null,
        applyLine: file.editablePath ? 1 : null,
        applyStartLine: file.editablePath ? 1 : null,
        applyEndLine: file.editablePath ? 1 : null,
        hunkId: null,
        hunkHeader: null,
      };
      const original = (entry as unknown as { originalAnchor?: unknown }).originalAnchor as any ?? entry.anchor;
      const status = anchorLocationEqual(original, nextAnchor) ? "ok" : "moved";
      return {
        ...entry,
        fileKey: file.fileKey,
        fileStatus: file.status,
        oldPath: file.oldPath,
        newPath: file.newPath,
        editablePath: file.editablePath,
        displayPath: file.displayPath,
        anchor: nextAnchor,
        status,
        candidateRemaps: [],
        remapNotes: [...entry.remapNotes, `Downgraded to file-level at ${file.displayPath}`],
      };
    });
  }

  const anchor = downgrade === "range" && selection
    ? commentAnchorForTarget(file, row, "range", selection)
    : commentAnchorForTarget(file, row, downgrade);
  if (!anchor) return null;

  return comments.map((entry) => {
    if (entry.id !== comment.id) return entry;
    const original = (entry as unknown as { originalAnchor?: unknown }).originalAnchor as any ?? entry.anchor;
    const status = anchorLocationEqual(original, anchor) ? "ok" : "moved";
    return {
      ...entry,
      fileKey: file.fileKey,
      fileStatus: file.status,
      oldPath: file.oldPath,
      newPath: file.newPath,
      editablePath: file.editablePath,
      displayPath: file.displayPath,
      anchor,
      status,
      candidateRemaps: [],
      remapNotes: [...entry.remapNotes, downgrade === "line"
        ? `Attached at cursor ${file.displayPath}:${anchor.line ?? anchor.startLine ?? "?"}`
        : downgrade === "range"
          ? `Downgraded to range at ${file.displayPath}`
          : `Downgraded to ${downgrade} at ${file.displayPath}`],
    };
  });
}

export function applyCandidateRemap({
  comments,
  comment,
  candidateIndex,
}: {
  comments: ReviewComment[];
  comment: ReviewComment;
  candidateIndex: number;
}): ReviewComment[] | null {
  const candidate = comment.candidateRemaps[candidateIndex];
  if (!candidate) return null;
  return comments.map((entry) => {
    if (entry.id !== comment.id) return entry;
    const nextAnchor = {
      ...entry.anchor,
      side: candidate.side,
      kind: entry.anchor.kind === "line" ? "line" as const : "range" as const,
      origin: entry.anchor.kind === "line" ? null : entry.anchor.origin,
      line: entry.anchor.kind === "line" ? candidate.line : null,
      startLine: entry.anchor.kind === "line" ? candidate.line : candidate.startLine,
      endLine: entry.anchor.kind === "line" ? candidate.line : candidate.endLine,
      applyLine: candidate.side === "new" ? candidate.line : entry.anchor.applyLine,
      applyStartLine: candidate.side === "new" ? candidate.startLine : entry.anchor.applyStartLine,
      applyEndLine: candidate.side === "new" ? candidate.endLine : entry.anchor.applyEndLine,
      hunkId: candidate.hunkId,
    };
    const original = (entry as unknown as { originalAnchor?: unknown }).originalAnchor as any ?? entry.anchor;
    const status = anchorLocationEqual(original, nextAnchor) ? "ok" : "moved";
    return {
      ...entry,
      fileKey: candidate.fileKey,
      displayPath: candidate.displayPath,
      anchor: nextAnchor,
      status,
      candidateRemaps: [],
      remapNotes: [...entry.remapNotes, `Resolved via candidate: ${candidate.displayPath}:${candidate.startLine ?? candidate.line ?? "?"}`],
    };
  });
}

export function autoChunkSelection(file: ParsedFilePatch, rowIndex: number): RangeSelection | null {
  const range = getCommentHunkRange(file, rowIndex);
  if (!range) return null;
  const side: Exclude<CommentSide, "file"> = range.newStart != null ? "new" : "old";
  return buildRangeSelection({ file, side, startRowIndex: range.rowStart, endRowIndex: range.rowEnd });
}
