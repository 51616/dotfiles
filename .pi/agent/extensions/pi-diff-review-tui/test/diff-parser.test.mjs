import test from "node:test";
import assert from "node:assert/strict";

import { compactSnippetFromRows, parseSingleFilePatch, splitPatchIntoFileSections } from "../lib/diff-parser.ts";

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

test("splitPatchIntoFileSections splits multi-file patches", () => {
  const joined = `${PATCH}\n${PATCH.replaceAll("foo", "bar")}`;
  const sections = splitPatchIntoFileSections(joined);
  assert.equal(sections.length, 2);
});

test("parseSingleFilePatch tracks hunk rows and line numbers", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(file.hunks.length, 1);
  const removed = file.rows.find((row) => row.kind === "removed");
  const added = file.rows.find((row) => row.kind === "added");
  assert.equal(removed?.oldLine, 2);
  assert.equal(added?.newLine, 2);
  assert.equal(file.rows.find((row) => row.kind === "hunk_header")?.hunkId, file.hunks[0].id);
});

test("compactSnippetFromRows includes nearby context", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const changedRow = file.rows.find((row) => row.kind === "added" && row.text.includes("line2 changed"));
  assert.ok(changedRow);
  const snippet = compactSnippetFromRows(file.rows, changedRow.rowIndex, 1);
  assert.match(snippet, /@@ -1,3 \+1,4 @@/);
  assert.match(snippet, /line2 changed/);
});
