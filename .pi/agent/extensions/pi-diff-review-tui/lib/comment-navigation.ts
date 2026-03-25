import { compareCommentsByLocation, commentsAtLocation } from "./comments.ts";
import type { DiffScope, ParsedDiffRow, ParsedFilePatch, ReviewComment } from "./types.ts";

export function commentsSortedForNavigation(comments: ReviewComment[], scope: DiffScope): ReviewComment[] {
  return comments
    .filter((comment) => comment.scope === scope)
    .slice()
    .sort(compareCommentsByLocation);
}

export function commentsAtCursor({
  comments,
  scope,
  file,
  row,
}: {
  comments: ReviewComment[];
  scope: DiffScope;
  file: ParsedFilePatch | null;
  row: ParsedDiffRow | null;
}): ReviewComment[] {
  if (!file || !row) return [];
  return commentsAtLocation({ comments, file, row, scope });
}

export function findAdjacentComment({
  comments,
  currentCommentId,
  direction,
}: {
  comments: ReviewComment[];
  currentCommentId: string | null;
  direction: 1 | -1;
}): ReviewComment | null {
  if (!comments.length) return null;
  if (!currentCommentId) return direction === 1 ? comments[0] : comments[comments.length - 1];
  const index = comments.findIndex((comment) => comment.id === currentCommentId);
  if (index < 0) return direction === 1 ? comments[0] : comments[comments.length - 1];
  const nextIndex = Math.max(0, Math.min(comments.length - 1, index + direction));
  if (nextIndex === index) return null;
  return comments[nextIndex] ?? null;
}

export function nextFileIndexMatching({
  files,
  selectedFileIndex,
  predicate,
}: {
  files: ParsedFilePatch[];
  selectedFileIndex: number;
  predicate: (fileKey: string) => boolean;
}): number | null {
  if (!files.length) return null;
  for (let offset = 1; offset <= files.length; offset += 1) {
    const index = (selectedFileIndex + offset) % files.length;
    if (predicate(files[index].fileKey)) return index;
  }
  return null;
}
