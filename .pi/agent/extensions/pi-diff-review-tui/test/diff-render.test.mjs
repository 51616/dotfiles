import test from "node:test";
import assert from "node:assert/strict";

import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { renderDiffRows } from "../lib/diff-render.ts";
import { highlightFileRows } from "../lib/syntax-highlight.ts";

const BG = {
  selectedBg: "\x1b[48;2;120;120;120m",
  toolSuccessBg: "\x1b[48;2;0;120;0m",
  toolErrorBg: "\x1b[48;2;120;0;0m",
};

const FG = {
  accent: "\x1b[38;5;33m",
  border: "\x1b[38;5;244m",
  muted: "\x1b[38;5;245m",
  dim: "\x1b[38;5;240m",
  toolDiffAdded: "\x1b[38;5;40m",
  toolDiffRemoved: "\x1b[38;5;160m",
  toolDiffContext: "\x1b[38;5;252m",
  syntaxKeyword: "\x1b[38;5;99m",
  syntaxString: "\x1b[38;5;114m",
  syntaxComment: "\x1b[38;5;244m",
  syntaxFunction: "\x1b[38;5;81m",
  syntaxVariable: "\x1b[38;5;220m",
  syntaxNumber: "\x1b[38;5;141m",
  syntaxType: "\x1b[38;5;75m",
  syntaxOperator: "\x1b[38;5;203m",
  syntaxPunctuation: "\x1b[38;5;250m",
};

function createTheme() {
  return {
    fg: (color, text) => `${FG[color] ?? "\x1b[39m"}${text}\x1b[39m`,
    bg: (color, text) => `${BG[color]}${text}\x1b[49m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    getBgAnsi: (color) => BG[color],
    getColorMode: () => "truecolor",
  };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,3 @@",
  " const before = 1;",
  "-const veryLongValue = oldCall(alpha, beta, gamma, delta, epsilon);",
  "+const veryLongValue = newCall(alpha, beta, gamma, delta, epsilon);",
  " const after = 2;",
].join("\n");

const MULTI_HUNK_PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..3333333 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,3 @@",
  " const before = 1;",
  "-const firstOld = 1;",
  "+const firstNew = 1;",
  " const between = 2;",
  "@@ -10,3 +10,3 @@",
  " const afterGap = 10;",
  "-const secondOld = 10;",
  "+const secondNew = 10;",
  " const after = 11;",
].join("\n");

const MULTI_BLOCK_PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..3333333 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,6 +1,6 @@",
  " const keep0 = 0;",
  "-const firstOld = 1;",
  "+const firstNew = 1;",
  " const middle1 = 2;",
  " const middle2 = 3;",
  "-const secondOld = 4;",
  "+const secondNew = 4;",
  " const after = 5;",
].join("\n");

const PARTIAL_PAIR_PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..3333333 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,4 +1,4 @@",
  "-const firstValue = oldCall(alpha);",
  "-totallyDifferentRewrite(one, two, three);",
  "+const firstValue = newCall(alpha);",
  "+return fromElsewhere(now);",
].join("\n");

const AMBIGUOUS_REWRITE_PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..3333333 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,4 +1,4 @@",
  "-oldAlpha(one);",
  "-oldBeta(two);",
  "+brandNewGamma(three);",
  "+brandNewDelta(four);",
].join("\n");

test("renderDiffRows hides raw diff metadata rows", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: file.rows.find((row) => row.kind === "context")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const plain = stripAnsi(rendered.lines.join("\n"));
  assert.doesNotMatch(plain, /diff --git|index 1111111|--- a\/src\/example\.ts|\+\+\+ b\/src\/example\.ts|@@ -1,3 \+1,3 @@/);
  assert.match(plain, /const before = 1;/);
  assert.match(plain, /newCall/);
});

test("renderDiffRows keeps early cursor rows at the top until mid-viewport is reachable", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const contextRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const before"));
  assert.ok(contextRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 9,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: contextRow.rowIndex,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const plainLines = rendered.lines.map(stripAnsi);
  const selectedIndex = plainLines.findIndex((line) => line.includes("const before = 1;"));
  assert.equal(selectedIndex, 0);
});

test("renderDiffRows centers the cursor once enough content exists above it", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: MULTI_HUNK_PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const targetRow = file.rows.find((row) => row.kind === "context" && row.text.includes("afterGap"));
  assert.ok(targetRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 7,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: targetRow.rowIndex,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const plainLines = rendered.lines.map(stripAnsi);
  const selectedIndex = plainLines.findIndex((line) => line.includes("afterGap = 10;"));
  assert.equal(selectedIndex, 3);
});

test("renderDiffRows inserts a spacer line between hunks", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: MULTI_HUNK_PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 20,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: file.rows.find((row) => row.kind === "added")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const plainLines = rendered.lines.map(stripAnsi);
  const firstIndex = plainLines.findIndex((line) => line.includes("firstNew"));
  const secondIndex = plainLines.findIndex((line) => line.includes("afterGap"));
  assert.ok(firstIndex >= 0);
  assert.ok(secondIndex >= 0);
  assert.equal(plainLines[secondIndex - 1]?.trim(), "");
});

test("renderDiffRows wraps long diff rows and keeps syntax highlight on wrapped lines", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const addedRow = file.rows.find((row) => row.kind === "added");
  assert.ok(addedRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 50,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: addedRow.rowIndex,
    diffScroll: addedRow.rowIndex - 1,
    rowMarkers: new Map(),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const wrappedAddedLines = rendered.lines.filter((line) => line.includes("veryLongValue") || line.includes("epsilon"));
  assert.ok(wrappedAddedLines.length >= 2, `expected wrapped added row, got ${wrappedAddedLines.length} lines`);
  assert.match(rendered.lines.join("\n"), /\x1b\[38;5;99mconst\x1b\[39m/);
  assert.match(rendered.lines.join("\n"), /\x1b\[48;2;60;120;60m/);
  assert.doesNotMatch(rendered.lines.join("\n"), /…/);
});

test("selected context rows still use selectedBg while changed rows keep diff tint", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const contextRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const before"));
  const addedRow = file.rows.find((row) => row.kind === "added");
  assert.ok(contextRow);
  assert.ok(addedRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: contextRow.rowIndex,
    diffScroll: contextRow.rowIndex - 1,
    rowMarkers: new Map(),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const selectedContextLine = rendered.lines.find((line) => line.includes("before =")) ?? "";
  const unselectedAddedLine = rendered.lines.find((line) => line.includes("newCall")) ?? "";
  assert.match(selectedContextLine, /\x1b\[48;2;120;120;120m/);
  assert.match(unselectedAddedLine, /\x1b\[48;2;0;120;0m/);
});

test("renderDiffRows keeps the join marker compact and left-flushes unmarked diff content", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const contextRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const before"));
  assert.ok(contextRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: contextRow.rowIndex,
    diffScroll: contextRow.rowIndex - 1,
    rowMarkers: new Map(),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const plainContextLine = stripAnsi(rendered.lines.find((line) => line.includes("before =")) ?? "");
  assert.match(plainContextLine, /^\s*1 ⋮ \s*1 ▌\s*│const before = 1;/);
});

test("renderDiffRows shows the current line marker in the gutter across wrapped selected rows", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const addedRow = file.rows.find((row) => row.kind === "added");
  assert.ok(addedRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 42,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: addedRow.rowIndex,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const markerLines = rendered.lines.map(stripAnsi).filter((line) => line.includes("▌"));
  assert.ok(markerLines.length >= 2, `expected wrapped selected row to keep gutter marker, got ${markerLines.length} line(s)`);
});

test("renderDiffRows places comment markers in the gutter instead of the content column", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const contextRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const before"));
  assert.ok(contextRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 60,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: contextRow.rowIndex,
    diffScroll: contextRow.rowIndex - 1,
    rowMarkers: new Map([[contextRow.rowIndex, "◆1 "]]),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const plainContextLine = stripAnsi(rendered.lines.find((line) => line.includes("before =")) ?? "");
  assert.match(plainContextLine, /^\s*1 ⋮ \s*1 ▌\s*◆1\s*│const before = 1;/);
  assert.doesNotMatch(plainContextLine, /│(?:✓|◆1)/);
});

test("renderDiffRows keeps the selected row visible when wrapped rows above consume the viewport", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const removedRow = file.rows.find((row) => row.kind === "removed");
  const afterRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const after"));
  assert.ok(removedRow);
  assert.ok(afterRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 25,
    height: 6,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: afterRow.rowIndex,
    diffScroll: removedRow.rowIndex,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const selectedAfterLines = rendered.lines.filter((line) => /\x1b\[48;2;120;120;120m/.test(line));
  assert.ok(selectedAfterLines.some((line) => line.includes("after") || line.includes("= 2;")));
  assert.ok(rendered.diffScroll >= removedRow.rowIndex);
});

test("renderDiffRows emphasizes changed tokens for confidently paired rows", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 80,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: file.rows.find((row) => row.kind === "added")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const output = rendered.lines.join("\n");
  assert.match(output, /\x1b\[1m/);
  assert.match(output, /\x1b\[48;2;72;128;72m/);
  assert.match(output, /\x1b\[48;2;128;15;15m/);
  assert.doesNotMatch(output, /\x1b\[4m/);
});

test("renderDiffRows keeps brighter token chips on selected changed rows", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const highlightedRows = highlightFileRows({ file, language: "typescript", theme });
  const addedRow = file.rows.find((row) => row.kind === "added");
  assert.ok(addedRow);

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 80,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "typescript",
    diffCursorRow: addedRow.rowIndex,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows,
    rowCache: null,
    viewportCache: null,
  });

  const selectedAddedLine = rendered.lines.find((line) => line.includes("newCall")) ?? "";
  assert.match(selectedAddedLine, /\x1b\[48;2;60;120;60m/);
  assert.match(selectedAddedLine, /\x1b\[48;2;72;128;72m/);
});

test("renderDiffRows falls back cleanly for ambiguous rewrites and unmatched rows", () => {
  const theme = createTheme();
  const ambiguousFile = parseSingleFilePatch({ rawPatch: AMBIGUOUS_REWRITE_PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const partialFile = parseSingleFilePatch({ rawPatch: PARTIAL_PAIR_PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });

  const ambiguousRendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "ambiguous",
    file: ambiguousFile,
    width: 80,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: ambiguousFile.rows.find((row) => row.kind === "added")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });
  assert.doesNotMatch(ambiguousRendered.lines.join("\n"), /\x1b\[48;2;(?:15;128;15|72;128;72|128;15;15)m/);

  const partialRendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "partial",
    file: partialFile,
    width: 80,
    height: 12,
    commentsEpoch: 0,
    highlightKey: "plain",
    diffCursorRow: partialFile.rows.find((row) => row.kind === "added")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const output = partialRendered.lines.join("\n");
  assert.match(output, /\x1b\[48;2;72;128;72m/);
  assert.match(output, /\x1b\[48;2;128;15;15m/);

  const unmatchedAddedLine = partialRendered.lines.find((line) => line.includes("return fromElsewhere")) ?? "";
  assert.doesNotMatch(unmatchedAddedLine, /\x1b\[48;2;(?:15;128;15|72;128;72)m/);
});

test("renderDiffRows shows bold color-coded accepted and rejected markers only on changed rows", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: MULTI_BLOCK_PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });

  const rendered = renderDiffRows({
    theme,
    scope: "u",
    fingerprint: "fingerprint",
    file,
    width: 80,
    height: 20,
    commentsEpoch: 0,
    hunkSelectionEpoch: 1,
    highlightKey: "plain",
    diffCursorRow: file.rows.find((row) => row.kind === "context")?.rowIndex ?? 0,
    diffScroll: 0,
    rowMarkers: new Map(),
    rejectedHunkIds: new Set([file.changeBlocks[1]?.id]),
    highlightedRows: null,
    rowCache: null,
    viewportCache: null,
  });

  const plainLines = rendered.lines.map(stripAnsi);
  const firstChangedIndex = plainLines.findIndex((line) => line.includes("firstNew = 1"));
  const secondChangedIndex = plainLines.findIndex((line) => line.includes("secondNew = 4"));
  const contextIndex = plainLines.findIndex((line) => line.includes("middle1 = 2"));
  const firstChangedLine = firstChangedIndex >= 0 ? rendered.lines[firstChangedIndex] : "";
  const secondChangedLine = secondChangedIndex >= 0 ? rendered.lines[secondChangedIndex] : "";
  const contextLine = contextIndex >= 0 ? rendered.lines[contextIndex] : "";
  const plainContextLine = contextIndex >= 0 ? plainLines[contextIndex] : "";

  assert.match(firstChangedLine, /\x1b\[38;5;40m\x1b\[1m✓\x1b\[22m\x1b\[39m/);
  assert.match(secondChangedLine, /\x1b\[38;5;160m\x1b\[1m×\x1b\[22m\x1b\[39m/);
  assert.match(firstChangedLine, /\x1b\[48;2;0;120;0m/);
  assert.match(secondChangedLine, /\x1b\[48;2;0;78;0m/);
  assert.match(secondChangedLine, /\x1b\[38;5;252mconst/);
  assert.ok(plainLines.some((line) => line.includes("✓") && line.includes("firstNew = 1")));
  assert.ok(plainLines.some((line) => line.includes("×") && line.includes("secondNew = 4")));
  assert.ok(!plainContextLine.includes("✓") && !plainContextLine.includes("×"));
  assert.doesNotMatch(contextLine, /\x1b\[1m[✓×]\x1b\[22m/);
});
