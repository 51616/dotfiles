import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DiffBundle, ParsedChangeBlock, ParsedDiffRow, ParsedFilePatch } from "./types.ts";

export type GitApplyStrategy = "direct" | "3way";

export type ReverseApplyPatchResult =
  | { ok: true; strategy: GitApplyStrategy }
  | {
      ok: false;
      error: string;
      directCheckError: string;
      threeWayCheckError: string;
    };

type SelectedBlockSegment = {
  block: ParsedChangeBlock;
  leadingContextRows: ParsedDiffRow[];
  trailingContextRows: ParsedDiffRow[];
};

function rejectedHunksForFile(file: ParsedFilePatch, rejectedHunksByFile: Map<string, ReadonlySet<string>>): string[] {
  const rejected = rejectedHunksByFile.get(file.fileKey);
  if (!rejected?.size) return [];
  return file.changeBlocks.filter((block) => rejected.has(block.id)).map((block) => block.id);
}

function blockEndWithNoNewline(file: ParsedFilePatch, block: ParsedChangeBlock): number {
  let end = block.rowEnd;
  while (file.rows[end + 1]?.kind === "no_newline") end += 1;
  return end;
}

function contextRowsBetween(file: ParsedFilePatch, start: number, end: number): ParsedDiffRow[] {
  if (end < start) return [];
  return file.rows.slice(start, end + 1).filter((row) => row.kind === "context");
}

function segmentHasContext(segment: SelectedBlockSegment): boolean {
  return segment.leadingContextRows.length > 0 || segment.trailingContextRows.length > 0;
}

function splitContextGap({
  rows,
  leftHasContext,
  rightHasContext,
}: {
  rows: ParsedDiffRow[];
  leftHasContext: boolean;
  rightHasContext: boolean;
}): { left: ParsedDiffRow[]; right: ParsedDiffRow[] } {
  if (!rows.length) return { left: [], right: [] };
  if (rows.length === 1) {
    if (!leftHasContext && rightHasContext) return { left: rows, right: [] };
    return { left: [], right: rows };
  }

  let leftCount = Math.floor(rows.length / 2);
  let rightCount = rows.length - leftCount;

  if (!leftHasContext && leftCount === 0) {
    leftCount = 1;
    rightCount = rows.length - leftCount;
  }
  if (!rightHasContext && rightCount === 0) {
    rightCount = 1;
    leftCount = rows.length - rightCount;
  }
  if (!leftHasContext && leftCount === 0 && rows.length > 0) {
    leftCount = 1;
    rightCount = rows.length - leftCount;
  }
  if (!rightHasContext && rightCount === 0 && rows.length > 0) {
    rightCount = 1;
    leftCount = rows.length - rightCount;
  }

  return {
    left: rows.slice(0, leftCount),
    right: rows.slice(leftCount),
  };
}

function selectedSegmentsForHunk(file: ParsedFilePatch, selectedBlocks: ParsedChangeBlock[]): SelectedBlockSegment[] {
  if (!selectedBlocks.length) return [];
  const hunkId = selectedBlocks[0]?.hunkId ?? null;
  const hunk = hunkId ? file.hunks.find((entry) => entry.id === hunkId) : null;
  if (!hunk) {
    return selectedBlocks.map((block) => ({ block, leadingContextRows: [], trailingContextRows: [] }));
  }

  const allHunkBlocks = file.changeBlocks
    .filter((block) => block.hunkId === hunkId)
    .sort((left, right) => left.rowStart - right.rowStart);
  const allIndexById = new Map(allHunkBlocks.map((block, index) => [block.id, index]));
  const segments = selectedBlocks.map((block) => ({ block, leadingContextRows: [], trailingContextRows: [] }));

  for (const segment of segments) {
    const block = segment.block;
    const allIndex = allIndexById.get(block.id) ?? -1;
    const previousBlock = allIndex > 0 ? allHunkBlocks[allIndex - 1] : null;
    const nextBlock = allIndex >= 0 && allIndex < allHunkBlocks.length - 1 ? allHunkBlocks[allIndex + 1] : null;
    const leadingStart = previousBlock ? blockEndWithNoNewline(file, previousBlock) + 1 : hunk.rowStart + 1;
    const leadingEnd = block.rowStart - 1;
    const trailingStart = blockEndWithNoNewline(file, block) + 1;
    const trailingEnd = nextBlock ? nextBlock.rowStart - 1 : hunk.rowEnd;
    segment.leadingContextRows = contextRowsBetween(file, leadingStart, leadingEnd);
    segment.trailingContextRows = contextRowsBetween(file, trailingStart, trailingEnd);
  }

  for (let index = 0; index < selectedBlocks.length - 1; index += 1) {
    const left = selectedBlocks[index]!;
    const right = selectedBlocks[index + 1]!;
    const leftAllIndex = allIndexById.get(left.id) ?? -1;
    const rightAllIndex = allIndexById.get(right.id) ?? -1;
    if (leftAllIndex < 0 || rightAllIndex !== leftAllIndex + 1) continue;

    const gap = contextRowsBetween(file, blockEndWithNoNewline(file, left) + 1, right.rowStart - 1);
    const split = splitContextGap({
      rows: gap,
      leftHasContext: segmentHasContext(segments[index]!),
      rightHasContext: segmentHasContext(segments[index + 1]!),
    });
    segments[index]!.trailingContextRows = split.left;
    segments[index + 1]!.leadingContextRows = split.right;
  }

  return segments;
}

function selectedBlockRows(file: ParsedFilePatch, rejectedHunkIds: ReadonlySet<string>): ParsedDiffRow[][] {
  const selectedBlocks = file.changeBlocks
    .filter((block) => rejectedHunkIds.has(block.id))
    .sort((left, right) => left.rowStart - right.rowStart);
  if (!selectedBlocks.length) return [];

  const slices: ParsedDiffRow[][] = [];
  let currentHunkId = selectedBlocks[0]?.hunkId ?? null;
  let currentBlocks: ParsedChangeBlock[] = [];

  const flush = () => {
    if (!currentBlocks.length) return;
    for (const segment of selectedSegmentsForHunk(file, currentBlocks)) {
      const start = segment.leadingContextRows[0]?.rowIndex ?? segment.block.rowStart;
      const end = segment.trailingContextRows.at(-1)?.rowIndex ?? blockEndWithNoNewline(file, segment.block);
      slices.push(file.rows.slice(start, end + 1));
    }
    currentBlocks = [];
  };

  for (const block of selectedBlocks) {
    if (currentBlocks.length && block.hunkId !== currentHunkId) flush();
    currentHunkId = block.hunkId ?? null;
    currentBlocks.push(block);
  }
  flush();
  return slices;
}

function formatHunkRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function buildSplitHunk(rows: ParsedDiffRow[]): string {
  const body = rows.filter((row) => row.kind !== "meta" && row.kind !== "hunk_header");
  if (!body.length) return "";

  const oldCount = body.filter((row) => row.kind === "context" || row.kind === "removed").length;
  const newCount = body.filter((row) => row.kind === "context" || row.kind === "added").length;
  const firstOld = body.find((row) => row.oldLine != null)?.oldLine;
  const firstNew = body.find((row) => row.newLine != null)?.newLine;
  const oldStart = firstOld ?? Math.max(0, (firstNew ?? 1) - 1);
  const newStart = firstNew ?? Math.max(0, (firstOld ?? 1) - 1);

  return [
    `@@ -${formatHunkRange(oldStart, oldCount)} +${formatHunkRange(newStart, newCount)} @@`,
    ...body.map((row) => row.rawText),
  ].join("\n");
}

function buildRejectedFilePatch(file: ParsedFilePatch, rejectedHunkIds: ReadonlySet<string>): string {
  if (!file.changeBlocks.length || !rejectedHunkIds.size) return "";

  const headerRows = file.rows
    .slice(0, file.hunks[0]?.rowStart ?? 0)
    .map((row) => row.rawText);

  const bodyRows = selectedBlockRows(file, rejectedHunkIds)
    .map((rows) => buildSplitHunk(rows))
    .filter(Boolean);

  if (!bodyRows.length) return "";
  return [...headerRows, ...bodyRows].join("\n").trimEnd();
}

export function buildRejectedHunksPatch({
  bundle,
  rejectedHunksByFile,
}: {
  bundle: DiffBundle;
  rejectedHunksByFile: Map<string, ReadonlySet<string>>;
}): string {
  if (!rejectedHunksByFile.size) return "";

  const sections = bundle.files
    .map((file) => {
      const rejectedIds = rejectedHunksForFile(file, rejectedHunksByFile);
      if (!rejectedIds.length) return "";
      return buildRejectedFilePatch(file, new Set(rejectedIds));
    })
    .filter(Boolean);

  return sections.join("\n").trim();
}

export function countRejectedHunks(rejectedHunksByFile: Map<string, ReadonlySet<string>>): number {
  let count = 0;
  for (const hunkIds of rejectedHunksByFile.values()) count += hunkIds.size;
  return count;
}

function truncateApplyOutput(output: string): string {
  const normalized = output.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "(no git diagnostics)";
  const lines = normalized.split("\n");
  const maxLines = 14;
  const clippedLines = lines.slice(0, maxLines);
  let clipped = clippedLines.join("\n");
  if (lines.length > maxLines) clipped += "\n…";
  if (clipped.length > 1800) clipped = `${clipped.slice(0, 1799)}…`;
  return clipped;
}

async function runGitApply(
  pi: Pick<ExtensionAPI, "exec">,
  repoRoot: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  const output = truncateApplyOutput([result.stderr, result.stdout].filter(Boolean).join("\n"));
  return { ok: result.code === 0, output };
}

function summarizeApplyFailure(directCheckError: string, threeWayCheckError: string): string {
  return [
    "git apply -R could not safely revert the rejected changed blocks.",
    "",
    "direct check:",
    directCheckError,
    "",
    "3-way fallback:",
    threeWayCheckError,
  ].join("\n").trim();
}

export async function reverseApplyPatch({
  pi,
  repoRoot,
  patchText,
}: {
  pi: Pick<ExtensionAPI, "exec">;
  repoRoot: string;
  patchText: string;
}): Promise<ReverseApplyPatchResult> {
  const patch = patchText.replace(/\r\n/g, "\n").trim();
  if (!patch) return { ok: true, strategy: "direct" };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-diff-review-apply-"));
  const patchPath = path.join(tempDir, "rejected.patch");

  try {
    await fs.writeFile(patchPath, `${patch}\n`, "utf8");

    const directCheck = await runGitApply(pi, repoRoot, ["apply", "-R", "--check", patchPath]);
    if (directCheck.ok) {
      const directApply = await runGitApply(pi, repoRoot, ["apply", "-R", patchPath]);
      if (directApply.ok) return { ok: true, strategy: "direct" };
      return {
        ok: false,
        error: summarizeApplyFailure("check passed but apply failed:\n" + directApply.output, "(not attempted)"),
        directCheckError: directApply.output,
        threeWayCheckError: "(not attempted)",
      };
    }

    const threeWayCheck = await runGitApply(pi, repoRoot, ["apply", "-R", "-3", "--check", patchPath]);
    if (threeWayCheck.ok) {
      const threeWayApply = await runGitApply(pi, repoRoot, ["apply", "-R", "-3", patchPath]);
      if (threeWayApply.ok) return { ok: true, strategy: "3way" };
      return {
        ok: false,
        error: summarizeApplyFailure(directCheck.output, "check passed but apply failed:\n" + threeWayApply.output),
        directCheckError: directCheck.output,
        threeWayCheckError: threeWayApply.output,
      };
    }

    return {
      ok: false,
      error: summarizeApplyFailure(directCheck.output, threeWayCheck.output),
      directCheckError: directCheck.output,
      threeWayCheckError: threeWayCheck.output,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
