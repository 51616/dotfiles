import { compactSnippetFromRows, fileSnippetFromRows, snippetFromRowRange } from "./diff-parser.ts";
import { buildRangeSelection, getCommentHunkRange } from "./comments.ts";
import type { CommentKind, ParsedDiffRow, ParsedFilePatch, RangeSelection, ReviewComment } from "./types.ts";

function splitSnippet(text: string): string[] {
  return text ? text.split("\n") : [];
}

export function editorSnippetForDraft({
  file,
  row,
  kind,
  selection,
}: {
  file: ParsedFilePatch;
  row: ParsedDiffRow;
  kind: CommentKind;
  selection?: RangeSelection | null;
}): string[] {
  if (kind === "file") return splitSnippet(fileSnippetFromRows(file.rows, 8));
  if (kind === "line") return splitSnippet(compactSnippetFromRows(file.rows, row.rowIndex, 3));

  if (selection) {
    const range = buildRangeSelection({
      file,
      side: selection.side,
      startRowIndex: selection.startRowIndex,
      endRowIndex: selection.endRowIndex,
    });
    if (range) return splitSnippet(snippetFromRowRange(file.rows, range.startRowIndex, range.endRowIndex, 2));
  }

  const autoRange = getCommentHunkRange(file, row.rowIndex);
  if (autoRange) return splitSnippet(snippetFromRowRange(file.rows, autoRange.rowStart, autoRange.rowEnd, 1));
  return splitSnippet(compactSnippetFromRows(file.rows, row.rowIndex, 3));
}

export function editorSnippetForExisting(comment: ReviewComment): string[] {
  return splitSnippet(comment.compactSnippet || comment.fullHunkText || "");
}
