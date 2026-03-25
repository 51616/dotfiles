import test from "node:test";
import assert from "node:assert/strict";

import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { captureScopeViewState, ensureVisibleIndex, nearestNavigableRowIndex, nextScopeState, restoredCursorRow, restoredDiffScroll, restoredFileIndex } from "../lib/review-state.ts";

const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-line2",
  "+line2 changed",
  "+line3.5",
  " line4",
].join("\n");

test("ensureVisibleIndex clamps scroll to keep the active index in view", () => {
  assert.equal(ensureVisibleIndex(2, 5, 4), 2);
  assert.equal(ensureVisibleIndex(9, 3, 4), 6);
  assert.equal(ensureVisibleIndex(4, 3, 4), 3);
});

test("nearestNavigableRowIndex finds the closest diff row", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(nearestNavigableRowIndex(file.rows, 0), 5);
  assert.equal(nearestNavigableRowIndex(file.rows, 5), 5);
  assert.equal(nearestNavigableRowIndex(file.rows, 4), 5);
});

test("restoredFileIndex prefers matching path and otherwise clamps the previous selection", () => {
  assert.equal(restoredFileIndex({ displayPaths: ["a.ts", "b.ts"], selectedPath: "b.ts", selectedFileIndex: 0 }), 1);
  assert.equal(restoredFileIndex({ displayPaths: ["a.ts", "b.ts"], selectedPath: "missing.ts", selectedFileIndex: 7 }), 1);
});

test("captureScopeViewState and restore helpers keep cursor line and relative scroll", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line3.5");
  const view = captureScopeViewState({
    file,
    row,
    selectedFileIndex: 0,
    diffCursorRow: row.rowIndex,
    diffScroll: 4,
    fileScroll: 0,
  });

  const movedPatch = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,5 @@",
    " line1",
    "+line2 changed",
    " line4",
    "+line3.5",
    "+line5",
  ].join("\n");
  const movedFile = parseSingleFilePatch({ rawPatch: movedPatch, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const restoredRow = restoredCursorRow({ file: movedFile, view });

  assert.equal(movedFile.rows[restoredRow]?.newLine, 3);
  assert.equal(restoredDiffScroll({ view, restoredRow }), Math.max(0, restoredRow - (view.diffCursorRow - view.diffScroll)));
});

test("nextScopeState preserves start state and rolls previous hashes on reload", () => {
  const initialBundle = {
    scope: "u",
    repoRoot: "/tmp/repo",
    head: "abc1234",
    files: [],
    patchText: "",
    fingerprint: "fp-1",
    fileHashes: new Map([["a", "1"]]),
    loadedAt: "2026-03-23T00:00:00.000Z",
  };
  const first = nextScopeState({ scope: "u", bundle: initialBundle, previous: undefined, loadedAt: "2026-03-23T00:00:00.000Z" });
  const nextBundle = { ...initialBundle, fingerprint: "fp-2", fileHashes: new Map([["a", "2"]]) };
  const second = nextScopeState({ scope: "u", bundle: nextBundle, previous: first, loadedAt: "2026-03-23T00:05:00.000Z" });

  assert.equal(first.startFingerprint, "fp-1");
  assert.equal(second.startFingerprint, "fp-1");
  assert.equal(second.lastReloadFingerprint, "fp-2");
  assert.equal(second.previousFileHashes.get("a"), "1");
  assert.equal(second.view.selectedFileIndex, 0);
});
