import test from "node:test";
import assert from "node:assert/strict";

import { buildRangeSelection, commentsAtLocation, createComment, findCommentAtTarget, getCommentHunkRange, mapCommentToRow, revalidateComment } from "../lib/comments.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";

function makePatch(newLine = "line2 changed") {
  return [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-line2",
    `+${newLine}`,
    "+line3.5",
    " line4",
  ].join("\n");
}

function makeMultiClusterPatch() {
  return [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,6 +1,6 @@",
    " keep1",
    "-old1",
    "+new1",
    " keep2",
    " keep3",
    "-old2",
    "+new2",
    " keep4",
  ].join("\n");
}

test("revalidateComment keeps exact matches ok", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const comment = createComment({ comments: [], file, row, kind: "line", scope: "u", body: "note" });
  const next = revalidateComment(comment, file);
  assert.equal(next.status, "ok");
  assert.equal(mapCommentToRow(file, next), row.rowIndex);
});

test("phase 13: createComment stores originalAnchor equal to initial anchor", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const comment = createComment({ comments: [], file, row, kind: "line", scope: "u", body: "note" });
  assert.deepEqual(comment.originalAnchor, comment.anchor);
});

test("revalidateComment marks unresolved when text disappears", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const comment = createComment({ comments: [], file, row, kind: "line", scope: "u", body: "note" });
  const updatedFile = parseSingleFilePatch({ rawPatch: makePatch("totally different"), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const next = revalidateComment(comment, updatedFile);
  assert.equal(next.status, "stale_unresolved");
  assert.equal(Array.isArray(next.candidateRemaps), true);
});

test("revalidateComment keeps hunk comments ok across no-op reload", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const comment = createComment({ comments: [], file, row, kind: "hunk", scope: "u", body: "hunk note" });
  const reloaded = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const next = revalidateComment(comment, reloaded);
  assert.equal(next.status, "ok");
  assert.equal(next.anchor.hunkHeader, "@@ -1,3 +1,4 @@");
});

test("hunk comments use contiguous changed rows instead of full git hunks", () => {
  const file = parseSingleFilePatch({ rawPatch: makeMultiClusterPatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "new1");
  const range = getCommentHunkRange(file, row.rowIndex);
  const comment = createComment({ comments: [], file, row, kind: "hunk", scope: "u", body: "first cluster" });

  assert.equal(range.oldStart, 2);
  assert.equal(range.oldEnd, 2);
  assert.equal(range.newStart, 2);
  assert.equal(range.newEnd, 2);
  assert.equal(comment.anchor.startLine, 2);
  assert.equal(comment.anchor.endLine, 2);
  assert.equal(comment.anchor.hunkHeader, "@@ -1,6 +1,6 @@");
});

test("file comments map to the first visible diff row", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const fileRow = file.rows.find((entry) => entry.kind === "context" && entry.text === "line1");
  const fileComment = createComment({ comments: [], file, row: fileRow, kind: "file", scope: "u", body: "file note" });

  assert.equal(mapCommentToRow(file, fileComment), fileRow.rowIndex);
});

test("findCommentAtTarget matches existing comments for the same location", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const lineRow = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const fileRow = file.rows.find((entry) => entry.kind === "context" && entry.text === "line1");
  const lineComment = createComment({ comments: [], file, row: lineRow, kind: "line", scope: "u", body: "note" });
  const rangeComment = createComment({ comments: [lineComment], file, row: lineRow, kind: "range", scope: "u", body: "range note" });
  const fileComment = createComment({ comments: [lineComment, rangeComment], file, row: fileRow, kind: "file", scope: "u", body: "file note" });
  const comments = [lineComment, rangeComment, fileComment];

  assert.equal(findCommentAtTarget({ comments, file, row: lineRow, kind: "line", scope: "u" })?.id, lineComment.id);
  assert.equal(findCommentAtTarget({ comments, file, row: lineRow, kind: "range", scope: "u" })?.id, rangeComment.id);
  assert.equal(findCommentAtTarget({ comments, file, row: fileRow, kind: "file", scope: "u" })?.id, fileComment.id);
});

test("user-selected range comments keep explicit range anchors and cover rows inside the range", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch(), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const firstAdded = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const secondAdded = file.rows.find((entry) => entry.kind === "added" && entry.text === "line3.5");
  const selection = buildRangeSelection({ file, side: "new", startRowIndex: firstAdded.rowIndex, endRowIndex: secondAdded.rowIndex });
  const comment = createComment({ comments: [], file, row: firstAdded, kind: "range", scope: "u", body: "multi-line note", selection });

  assert.equal(comment.anchor.kind, "range");
  assert.equal(comment.anchor.origin, "user_range");
  assert.equal(comment.anchor.startLine, 2);
  assert.equal(comment.anchor.endLine, 3);
  assert.equal(comment.anchor.applyStartLine, 2);
  assert.equal(comment.anchor.applyEndLine, 3);
  assert.equal(commentsAtLocation({ comments: [comment], file, row: secondAdded, scope: "u" })[0]?.id, comment.id);
});

test("revalidateComment survives whitespace-only edits using normalized anchor hashes", () => {
  const file = parseSingleFilePatch({ rawPatch: makePatch("line2   changed"), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const row = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2   changed");
  const comment = createComment({ comments: [], file, row, kind: "line", scope: "u", body: "note" });
  const updatedFile = parseSingleFilePatch({ rawPatch: makePatch("line2 changed"), status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const next = revalidateComment(comment, updatedFile);

  assert.notEqual(next.status, "stale_unresolved");
  assert.equal(next.anchor.line, 2);
});

test("revalidateComment auto-remaps moved lines when the best candidate is clear", () => {
  const original = parseSingleFilePatch({
    rawPatch: [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,5 @@",
      " line1",
      "+const moved = helper();",
      " line2",
      " line3",
      " line4",
    ].join("\n"),
    status: "M",
    oldPath: "src/foo.ts",
    newPath: "src/foo.ts",
  });
  const row = original.rows.find((entry) => entry.kind === "added" && entry.text === "const moved = helper();");
  const comment = createComment({ comments: [], file: original, row, kind: "line", scope: "u", body: "move-safe" });

  const moved = parseSingleFilePatch({
    rawPatch: [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,5 +1,5 @@",
      " line1",
      " line2",
      " line3",
      "+const moved = helper();",
      " line4",
    ].join("\n"),
    status: "M",
    oldPath: "src/foo.ts",
    newPath: "src/foo.ts",
  });

  const next = revalidateComment(comment, moved);
  assert.equal(next.status, "moved");
  assert.equal(next.anchor.line, 4);
});

test("phase 13: revalidateComment preserves original anchor and keeps moved status", () => {
  const original = parseSingleFilePatch({
    rawPatch: [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,5 @@",
      " line1",
      "+const moved = helper();",
      " line2",
      " line3",
      " line4",
    ].join("\n"),
    status: "M",
    oldPath: "src/foo.ts",
    newPath: "src/foo.ts",
  });
  const row = original.rows.find((entry) => entry.kind === "added" && entry.text === "const moved = helper();");
  const comment = createComment({ comments: [], file: original, row, kind: "line", scope: "u", body: "move-safe" });

  const moved = parseSingleFilePatch({
    rawPatch: [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,5 +1,5 @@",
      " line1",
      " line2",
      " line3",
      "+const moved = helper();",
      " line4",
    ].join("\n"),
    status: "M",
    oldPath: "src/foo.ts",
    newPath: "src/foo.ts",
  });

  const first = revalidateComment(comment, moved);
  assert.equal(first.status, "moved");
  assert.equal(first.originalAnchor.line, 2);
  assert.equal(first.anchor.line, 4);

  const second = revalidateComment(first, moved);
  assert.equal(second.status, "moved");
  assert.equal(second.originalAnchor.line, 2);
  assert.equal(second.anchor.line, 4);
});
