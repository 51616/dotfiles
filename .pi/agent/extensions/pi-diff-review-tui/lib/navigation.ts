import type { ParsedDiffRow, ParsedFilePatch, ParsedHunk } from "./types.ts";

export function isNavigableDiffRow(row: ParsedDiffRow): boolean {
  return row.kind === "context" || row.kind === "added" || row.kind === "removed";
}

export function firstNavigableRowIndex(rows: ParsedDiffRow[]): number {
  const index = rows.findIndex(isNavigableDiffRow);
  return index >= 0 ? index : 0;
}

export function nextNavigableRowIndex(rows: ParsedDiffRow[], currentIndex: number, direction: 1 | -1): number {
  if (!rows.length) return 0;
  const start = Math.max(0, Math.min(rows.length - 1, currentIndex));
  for (let index = start + direction; index >= 0 && index < rows.length; index += direction) {
    if (isNavigableDiffRow(rows[index])) return index;
  }
  return start;
}

function preferredHunkEntryRowIndex(rows: ParsedDiffRow[], hunk: ParsedHunk): number {
  for (let index = hunk.rowStart; index <= hunk.rowEnd; index += 1) {
    if (rows[index]?.kind === "added") return index;
  }
  for (let index = hunk.rowStart; index <= hunk.rowEnd; index += 1) {
    if (isNavigableDiffRow(rows[index])) return index;
  }
  return hunk.rowStart;
}

function currentHunkIndex(file: ParsedFilePatch, currentIndex: number): number {
  const start = Math.max(0, Math.min(file.rows.length - 1, currentIndex));
  const row = file.rows[start];
  const hunkId = row?.hunkId;
  if (hunkId) {
    const exact = file.hunks.findIndex((hunk) => hunk.id === hunkId);
    if (exact >= 0) return exact;
  }

  const containing = file.hunks.findIndex((hunk) => start >= hunk.rowStart && start <= hunk.rowEnd);
  if (containing >= 0) return containing;

  return -1;
}

export function nextNavigableHunkRowIndex(file: ParsedFilePatch, currentIndex: number, direction: 1 | -1): number {
  if (!file.hunks.length) return Math.max(0, Math.min(file.rows.length - 1, currentIndex));

  const current = currentHunkIndex(file, currentIndex);
  const nextIndex = current < 0
    ? (direction === 1 ? 0 : file.hunks.length - 1)
    : current + direction;

  if (nextIndex < 0 || nextIndex >= file.hunks.length) {
    return Math.max(0, Math.min(file.rows.length - 1, currentIndex));
  }

  return preferredHunkEntryRowIndex(file.rows, file.hunks[nextIndex]);
}
