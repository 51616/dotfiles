import test from "node:test";
import assert from "node:assert/strict";

import { firstNavigableRowIndex, isNavigableDiffRow, nextNavigableHunkRowIndex, nextNavigableRowIndex } from "../lib/navigation.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";

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

const MULTI_HUNK_PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..3333333 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,4 +1,4 @@",
  " keep1",
  "-old1",
  "+new1",
  " keep2",
  "@@ -10,4 +10,4 @@",
  " keep10",
  "-old10",
  "+new10",
  " keep11",
].join("\n");

test("navigation skips meta rows and starts at first diff row", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(firstNavigableRowIndex(file.rows), 5);
  assert.equal(isNavigableDiffRow(file.rows[0]), false);
  assert.equal(isNavigableDiffRow(file.rows[5]), true);
});

test("nextNavigableRowIndex walks only real diff rows", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(nextNavigableRowIndex(file.rows, 0, 1), 5);
  assert.equal(nextNavigableRowIndex(file.rows, 5, 1), 6);
  assert.equal(nextNavigableRowIndex(file.rows, 9, -1), 8);
});

test("nextNavigableHunkRowIndex jumps to the first added row of the next or previous hunk", () => {
  const file = parseSingleFilePatch({ rawPatch: MULTI_HUNK_PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(nextNavigableHunkRowIndex(file, 5, 1), 12);
  assert.equal(nextNavigableHunkRowIndex(file, 10, -1), 7);
  assert.equal(nextNavigableHunkRowIndex(file, 5, -1), 5);
  assert.equal(nextNavigableHunkRowIndex(file, 10, 1), 10);
});
