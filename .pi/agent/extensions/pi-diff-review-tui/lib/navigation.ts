import type { ParsedChangeBlock, ParsedDiffRow, ParsedFilePatch } from "./types.ts";

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

function preferredChangeBlockEntryRowIndex(rows: ParsedDiffRow[], block: ParsedChangeBlock): number {
  for (let index = block.rowStart; index <= block.rowEnd; index += 1) {
    if (rows[index]?.kind === "added") return index;
  }
  return block.rowStart;
}

function changeBlockPositionForRow(
  file: ParsedFilePatch,
  currentIndex: number,
  direction: 1 | -1,
): { index: number | null; exact: boolean } {
  const start = Math.max(0, Math.min(file.rows.length - 1, currentIndex));
  const row = file.rows[start];
  const blockId = row?.changeBlockId;
  if (blockId) {
    const exact = file.changeBlocks.findIndex((block) => block.id === blockId);
    if (exact >= 0) return { index: exact, exact: true };
  }

  if (direction === 1) {
    const next = file.changeBlocks.findIndex((block) => block.rowStart > start);
    return { index: next >= 0 ? next : null, exact: false };
  }

  for (let index = file.changeBlocks.length - 1; index >= 0; index -= 1) {
    if ((file.changeBlocks[index]?.rowEnd ?? -1) < start) return { index, exact: false };
  }
  return { index: null, exact: false };
}

export function nextNavigableChangeBlockRowIndex(file: ParsedFilePatch, currentIndex: number, direction: 1 | -1): number {
  if (!file.changeBlocks.length) return Math.max(0, Math.min(file.rows.length - 1, currentIndex));

  const position = changeBlockPositionForRow(file, currentIndex, direction);
  const nextIndex = position.index == null ? null : (position.exact ? position.index + direction : position.index);

  if (nextIndex == null || nextIndex < 0 || nextIndex >= file.changeBlocks.length) {
    return Math.max(0, Math.min(file.rows.length - 1, currentIndex));
  }

  return preferredChangeBlockEntryRowIndex(file.rows, file.changeBlocks[nextIndex]);
}
