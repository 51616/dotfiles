import type { InlineEmphasisRange, ParsedDiffRow, ParsedFilePatch } from "./types.ts";

interface Token {
  text: string;
  start: number;
  end: number;
  whitespace: boolean;
}

interface ChangedSpan {
  start: number;
  end: number;
  text: string;
}

interface AnnotatedLinePair {
  distance: number;
  removedRanges: InlineEmphasisRange[];
  addedRanges: InlineEmphasisRange[];
}

interface AlignmentCell {
  parent: number;
  operation: AlignmentOperation;
  cost: number;
}

interface AlignmentResult {
  removed: Token[];
  added: Token[];
  coalescedOperations: Array<[AlignmentOperation, number]>;
}

type AlignmentOperation = "noop" | "deletion" | "insertion";
type PreviousOperation = "noop" | "deletion" | "insertion";

export interface ChangedCluster {
  hunkId: string | null;
  removed: ParsedDiffRow[];
  added: ParsedDiffRow[];
}

export interface InlineRowPairing {
  removedRowIndex: number;
  addedRowIndex: number;
  score: number;
}

const TOKENIZATION_REGEX = /\w+/gu;
const MAX_LINE_DISTANCE = 0.6;
const MAX_LINE_DISTANCE_FOR_NAIVELY_PAIRED_LINES = 0.0;
const DELETION_COST = 2;
const INSERTION_COST = 2;
const INITIAL_MISMATCH_PENALTY = 1;
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function renderableDiffText(text: string): string {
  return text.replace(/\t/g, "   ");
}

function graphemes(text: string): string[] {
  if (!text.length) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}

function createToken(text: string, start: number, end: number): Token {
  return {
    text,
    start,
    end,
    whitespace: text.trim().length === 0,
  };
}

function tokenize(text: string): Token[] {
  const rendered = renderableDiffText(text);
  const tokens: Token[] = [createToken("", 0, 0)];
  let offset = 0;

  for (const match of rendered.matchAll(TOKENIZATION_REGEX)) {
    const matched = match[0] ?? "";
    const start = match.index ?? 0;

    if (offset === 0 && start > 0) {
      tokens.push(createToken("", 0, 0));
    }

    let separatorOffset = offset;
    for (const segment of graphemes(rendered.slice(offset, start))) {
      tokens.push(createToken(segment, separatorOffset, separatorOffset + segment.length));
      separatorOffset += segment.length;
    }

    tokens.push(createToken(matched, start, start + matched.length));
    offset = start + matched.length;
  }

  if (offset < rendered.length) {
    if (offset === 0) {
      tokens.push(createToken("", 0, 0));
    }

    let trailingOffset = offset;
    for (const segment of graphemes(rendered.slice(offset))) {
      tokens.push(createToken(segment, trailingOffset, trailingOffset + segment.length));
      trailingOffset += segment.length;
    }
  }

  return tokens;
}

function mismatchCost(table: AlignmentCell[], parent: number, basicCost: number): number {
  const previous = table[parent];
  return previous.cost + basicCost + (previous.operation === "noop" ? INITIAL_MISMATCH_PENALTY : 0);
}

function coalesceOperations(operations: AlignmentOperation[]): Array<[AlignmentOperation, number]> {
  const coalesced: Array<[AlignmentOperation, number]> = [];
  for (const operation of operations) {
    const previous = coalesced[coalesced.length - 1];
    if (previous?.[0] === operation) {
      previous[1] += 1;
      continue;
    }
    coalesced.push([operation, 1]);
  }
  return coalesced;
}

function buildAlignment(removed: Token[], added: Token[]): AlignmentResult {
  const width = removed.length + 1;
  const height = added.length + 1;
  const table: AlignmentCell[] = Array.from({ length: width * height }, () => ({
    parent: 0,
    operation: "noop",
    cost: 0,
  }));
  const index = (x: number, y: number) => y * width + x;

  for (let x = 1; x < width; x += 1) {
    table[x] = {
      parent: 0,
      operation: "deletion",
      cost: x * DELETION_COST + INITIAL_MISMATCH_PENALTY,
    };
  }

  for (let y = 1; y < height; y += 1) {
    table[index(0, y)] = {
      parent: 0,
      operation: "insertion",
      cost: y * INSERTION_COST + INITIAL_MISMATCH_PENALTY,
    };
  }

  for (let removedIndex = 0; removedIndex < removed.length; removedIndex += 1) {
    for (let addedIndex = 0; addedIndex < added.length; addedIndex += 1) {
      const left = index(removedIndex, addedIndex + 1);
      const diagonal = index(removedIndex, addedIndex);
      const up = index(removedIndex + 1, addedIndex);
      const candidates: AlignmentCell[] = [
        {
          parent: up,
          operation: "insertion",
          cost: mismatchCost(table, up, INSERTION_COST),
        },
        {
          parent: left,
          operation: "deletion",
          cost: mismatchCost(table, left, DELETION_COST),
        },
        {
          parent: diagonal,
          operation: "noop",
          cost: removed[removedIndex]?.text === added[addedIndex]?.text ? table[diagonal]!.cost : Number.MAX_SAFE_INTEGER,
        },
      ];

      table[index(removedIndex + 1, addedIndex + 1)] = candidates.reduce((best, candidate) => {
        return candidate.cost < best.cost ? candidate : best;
      });
    }
  }

  const operations: AlignmentOperation[] = [];
  let cell = table[index(removed.length, added.length)]!;
  while (true) {
    operations.unshift(cell.operation);
    if (cell.parent === 0) break;
    cell = table[cell.parent]!;
  }

  return {
    removed,
    added,
    coalescedOperations: coalesceOperations(operations),
  };
}

function displayWidth(text: string): number {
  return graphemes(text.trim()).length;
}

function takeSpan(tokens: Token[], offset: { value: number }, count: number): ChangedSpan {
  const startToken = tokens[offset.value];
  if (!startToken || count <= 0) {
    const start = startToken?.start ?? 0;
    return { start, end: start, text: "" };
  }

  const endToken = tokens[offset.value + count - 1] ?? startToken;
  const start = startToken.start;
  const end = endToken.end;
  offset.value += count;
  return {
    start,
    end,
    text: startToken.start <= end ? renderableDiffText(tokens.slice(offset.value - count, offset.value).map((token) => token.text).join("")) : "",
  };
}

function rangesFromChangedTokens(tokens: Token[], changed: boolean[]): InlineEmphasisRange[] {
  const ranges: InlineEmphasisRange[] = [];
  let startIndex = -1;
  let endIndex = -1;

  const flush = () => {
    if (startIndex < 0 || endIndex <= startIndex) {
      startIndex = -1;
      endIndex = -1;
      return;
    }

    let trimmedStart = startIndex;
    let trimmedEnd = endIndex;
    while (trimmedStart < trimmedEnd) {
      const token = tokens[trimmedStart];
      if (!token || (!token.whitespace && token.end > token.start)) break;
      trimmedStart += 1;
    }
    while (trimmedEnd > trimmedStart) {
      const token = tokens[trimmedEnd - 1];
      if (!token || (!token.whitespace && token.end > token.start)) break;
      trimmedEnd -= 1;
    }

    const first = tokens[trimmedStart];
    const last = tokens[trimmedEnd - 1];
    if (first && last && last.end > first.start) {
      ranges.push({ start: first.start, end: last.end });
    }

    startIndex = -1;
    endIndex = -1;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (changed[index]) {
      if (startIndex < 0) startIndex = index;
      endIndex = index + 1;
      continue;
    }
    flush();
  }
  flush();

  return ranges;
}

function annotateLinePair(removedText: string, addedText: string): AnnotatedLinePair {
  const removedTokens = tokenize(removedText);
  const addedTokens = tokenize(addedText);
  const alignment = buildAlignment(removedTokens, addedTokens);

  const removedChanged = Array.from({ length: removedTokens.length }, () => false);
  const addedChanged = Array.from({ length: addedTokens.length }, () => false);
  const removedOffset = { value: 0 };
  const addedOffset = { value: 0 };
  let distanceNumerator = 0;
  let distanceDenominator = 0;
  let previousRemovedOp: PreviousOperation = "noop";
  let previousAddedOp: PreviousOperation = "noop";

  for (const [operation, count] of alignment.coalescedOperations) {
    if (operation === "deletion") {
      const span = takeSpan(removedTokens, removedOffset, count);
      const width = displayWidth(span.text);
      distanceDenominator += width;
      distanceNumerator += width;
      for (let index = removedOffset.value - count; index < removedOffset.value; index += 1) {
        removedChanged[index] = true;
      }
      previousRemovedOp = "deletion";
      continue;
    }

    if (operation === "insertion") {
      const span = takeSpan(addedTokens, addedOffset, count);
      const width = displayWidth(span.text);
      distanceDenominator += width;
      distanceNumerator += width;
      for (let index = addedOffset.value - count; index < addedOffset.value; index += 1) {
        addedChanged[index] = true;
      }
      previousAddedOp = "insertion";
      continue;
    }

    const removedSpan = takeSpan(removedTokens, removedOffset, count);
    const width = displayWidth(removedSpan.text);
    distanceDenominator += 2 * width;

    const whitespaceOnly = removedSpan.text.trim().length === 0;
    const coalesceSpaceWithPrevious = whitespaceOnly && (
      (
        previousRemovedOp === "deletion"
        && previousAddedOp === "insertion"
        && (removedOffset.value < removedTokens.length - 1 || addedOffset.value < addedTokens.length - 1)
      )
      || (previousRemovedOp === "noop" && previousAddedOp === "noop")
    );

    if (coalesceSpaceWithPrevious && previousRemovedOp === "deletion") {
      for (let index = removedOffset.value - count; index < removedOffset.value; index += 1) {
        removedChanged[index] = true;
      }
    }

    takeSpan(addedTokens, addedOffset, count);
    if (coalesceSpaceWithPrevious && previousAddedOp === "insertion") {
      for (let index = addedOffset.value - count; index < addedOffset.value; index += 1) {
        addedChanged[index] = true;
      }
    }

    previousRemovedOp = "noop";
    previousAddedOp = "noop";
  }

  return {
    distance: distanceDenominator > 0 ? distanceNumerator / distanceDenominator : 0,
    removedRanges: rangesFromChangedTokens(removedTokens, removedChanged),
    addedRanges: rangesFromChangedTokens(addedTokens, addedChanged),
  };
}

function isHomologousPair(distance: number, cluster: ChangedCluster): boolean {
  if (cluster.removed.length === cluster.added.length && distance <= MAX_LINE_DISTANCE_FOR_NAIVELY_PAIRED_LINES) {
    return true;
  }
  return distance <= MAX_LINE_DISTANCE;
}

function inferClusterLinePairs(cluster: ChangedCluster): Array<{ pairing: InlineRowPairing; removedRanges: InlineEmphasisRange[]; addedRanges: InlineEmphasisRange[] }> {
  const pairings: Array<{ pairing: InlineRowPairing; removedRanges: InlineEmphasisRange[]; addedRanges: InlineEmphasisRange[] }> = [];
  let nextAddedIndex = 0;

  for (const removedRow of cluster.removed) {
    for (let addedIndex = nextAddedIndex; addedIndex < cluster.added.length; addedIndex += 1) {
      const addedRow = cluster.added[addedIndex]!;
      const annotated = annotateLinePair(removedRow.text, addedRow.text);
      if (!isHomologousPair(annotated.distance, cluster)) continue;

      pairings.push({
        pairing: {
          removedRowIndex: removedRow.rowIndex,
          addedRowIndex: addedRow.rowIndex,
          score: 1 - annotated.distance,
        },
        removedRanges: annotated.removedRanges,
        addedRanges: annotated.addedRanges,
      });
      nextAddedIndex = addedIndex + 1;
      break;
    }
  }

  return pairings;
}

export function collectChangedClusters(file: ParsedFilePatch): ChangedCluster[] {
  const clusters: ChangedCluster[] = [];
  let removed: ParsedDiffRow[] = [];
  let added: ParsedDiffRow[] = [];
  let hunkId: string | null = null;

  const flush = () => {
    if (!removed.length && !added.length) return;
    clusters.push({ hunkId, removed, added });
    removed = [];
    added = [];
    hunkId = null;
  };

  for (const row of file.rows) {
    if (row.kind === "removed" || row.kind === "added") {
      if (hunkId != null && row.hunkId !== hunkId) flush();
      hunkId = row.hunkId ?? null;
      if (row.kind === "removed") removed.push(row);
      if (row.kind === "added") added.push(row);
      continue;
    }

    flush();
  }

  flush();
  return clusters;
}

export function pairChangedClusterRows(cluster: ChangedCluster): InlineRowPairing[] {
  return inferClusterLinePairs(cluster).map(({ pairing }) => pairing);
}

export function diffTokenRanges(removedText: string, addedText: string): { removed: InlineEmphasisRange[]; added: InlineEmphasisRange[] } {
  const annotated = annotateLinePair(removedText, addedText);
  return {
    removed: annotated.removedRanges,
    added: annotated.addedRanges,
  };
}

export function buildInlineEmphasisMap(file: ParsedFilePatch): Map<number, InlineEmphasisRange[]> {
  const inlineEmphasis = new Map<number, InlineEmphasisRange[]>();

  for (const cluster of collectChangedClusters(file)) {
    for (const { pairing, removedRanges, addedRanges } of inferClusterLinePairs(cluster)) {
      const removedRow = file.rows[pairing.removedRowIndex];
      const addedRow = file.rows[pairing.addedRowIndex];
      if (!removedRow || !addedRow) continue;
      if (!removedRanges.length || !addedRanges.length) continue;
      inlineEmphasis.set(removedRow.rowIndex, removedRanges);
      inlineEmphasis.set(addedRow.rowIndex, addedRanges);
    }
  }

  return inlineEmphasis;
}
