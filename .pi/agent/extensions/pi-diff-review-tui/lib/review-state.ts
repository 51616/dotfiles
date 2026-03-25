import { isNavigableDiffRow } from "./navigation.ts";
import type { CommentSide, DiffBundle, ParsedDiffRow, ParsedFilePatch, ScopeState, ScopeViewState } from "./types.ts";

function boundedRowIndex(rows: ParsedDiffRow[], rowIndex: number): number {
  if (!rows.length) return 0;
  return Math.max(0, Math.min(rows.length - 1, rowIndex));
}

function lineForSide(row: ParsedDiffRow | undefined, side: Exclude<CommentSide, "file"> | null): number | null {
  if (!row || !side) return null;
  return side === "old" ? row.oldLine ?? null : row.newLine ?? null;
}

function rowIndexForLine(file: ParsedFilePatch, side: Exclude<CommentSide, "file">, line: number, preferredKind: ParsedDiffRow["kind"] | null): number | null {
  const exact = file.rows.find((row) => (side === "old" ? row.oldLine : row.newLine) === line && (!preferredKind || row.kind === preferredKind));
  if (exact) return exact.rowIndex;

  const fallbackExact = file.rows.find((row) => (side === "old" ? row.oldLine : row.newLine) === line);
  if (fallbackExact) return fallbackExact.rowIndex;

  let best: ParsedDiffRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of file.rows) {
    const candidate = side === "old" ? row.oldLine : row.newLine;
    if (candidate == null) continue;
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best?.rowIndex ?? null;
}

export function ensureVisibleIndex(index: number, scroll: number, bodyHeight: number): number {
  if (index < scroll) return Math.max(0, index);
  if (index >= scroll + bodyHeight) return Math.max(0, index - bodyHeight + 1);
  return Math.max(0, scroll);
}

export function nearestNavigableRowIndex(rows: ParsedDiffRow[], rowIndex: number): number {
  if (!rows.length) return 0;
  const bounded = boundedRowIndex(rows, rowIndex);
  if (rows[bounded] && isNavigableDiffRow(rows[bounded])) return bounded;
  for (let offset = 0; offset < rows.length; offset += 1) {
    const forward = bounded + offset;
    if (forward < rows.length && isNavigableDiffRow(rows[forward])) return forward;
    const backward = bounded - offset;
    if (backward >= 0 && isNavigableDiffRow(rows[backward])) return backward;
  }
  return 0;
}

export function restoredFileIndex({
  displayPaths,
  selectedPath,
  selectedFileIndex,
}: {
  displayPaths: string[];
  selectedPath: string | null;
  selectedFileIndex: number;
}): number {
  if (!displayPaths.length) return 0;
  if (selectedPath) {
    const found = displayPaths.findIndex((path) => path === selectedPath);
    if (found >= 0) return found;
  }
  return Math.max(0, Math.min(selectedFileIndex, displayPaths.length - 1));
}

export function defaultScopeViewState(): ScopeViewState {
  return {
    selectedPath: null,
    selectedFileIndex: 0,
    diffCursorRow: 0,
    diffCursorSide: null,
    diffCursorKind: null,
    diffCursorLine: null,
    diffScroll: 0,
    fileScroll: 0,
  };
}

export function captureScopeViewState({
  file,
  row,
  selectedFileIndex,
  diffCursorRow,
  diffScroll,
  fileScroll,
}: {
  file: ParsedFilePatch | null;
  row: ParsedDiffRow | null;
  selectedFileIndex: number;
  diffCursorRow: number;
  diffScroll: number;
  fileScroll: number;
}): ScopeViewState {
  const side: Exclude<CommentSide, "file"> | null = row?.kind === "removed"
    ? "old"
    : row?.kind === "added" || row?.kind === "context"
      ? "new"
      : null;

  return {
    selectedPath: file?.displayPath ?? null,
    selectedFileIndex,
    diffCursorRow,
    diffCursorSide: side,
    diffCursorKind: row?.kind ?? null,
    diffCursorLine: lineForSide(row ?? undefined, side),
    diffScroll,
    fileScroll,
  };
}

export function restoredCursorRow({
  file,
  view,
}: {
  file: ParsedFilePatch;
  view: ScopeViewState;
}): number {
  if (view.diffCursorSide && view.diffCursorLine != null) {
    const byLine = rowIndexForLine(file, view.diffCursorSide, view.diffCursorLine, view.diffCursorKind);
    if (byLine != null) return nearestNavigableRowIndex(file.rows, byLine);
  }
  return nearestNavigableRowIndex(file.rows, view.diffCursorRow);
}

export function restoredDiffScroll({
  view,
  restoredRow,
}: {
  view: ScopeViewState;
  restoredRow: number;
}): number {
  const rowOffset = Math.max(0, view.diffCursorRow - view.diffScroll);
  return Math.max(0, restoredRow - rowOffset);
}

export function nextScopeState({
  scope,
  bundle,
  previous,
  loadedAt,
}: {
  scope: ScopeState["scope"];
  bundle: DiffBundle;
  previous: ScopeState | undefined;
  loadedAt: string;
}): ScopeState {
  if (!previous) {
    return {
      scope,
      bundle,
      startHead: bundle.head,
      startFingerprint: bundle.fingerprint,
      startFileHashes: new Map(bundle.fileHashes),
      lastReloadFingerprint: bundle.fingerprint,
      previousFileHashes: new Map(bundle.fileHashes),
      loadedAt,
      lastReloadAt: loadedAt,
      view: defaultScopeViewState(),
    };
  }

  return {
    ...previous,
    bundle,
    previousFileHashes: new Map(previous.bundle.fileHashes),
    lastReloadFingerprint: bundle.fingerprint,
    lastReloadAt: loadedAt,
    view: previous.view,
  };
}
