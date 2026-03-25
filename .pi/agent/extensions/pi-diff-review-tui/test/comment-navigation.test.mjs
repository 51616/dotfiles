import test from "node:test";
import assert from "node:assert/strict";

import { createComment } from "../lib/comments.ts";
import { commentsAtCursor, commentsSortedForNavigation, nextFileIndexMatching } from "../lib/comment-navigation.ts";
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

test("commentsAtCursor includes line, range, and file comments covering the current row", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const lineRow = file.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const secondRow = file.rows.find((entry) => entry.kind === "added" && entry.text === "line3.5");
  const fileRow = file.rows.find((entry) => entry.kind === "context" && entry.text === "line1");

  const lineComment = createComment({ comments: [], file, row: lineRow, kind: "line", scope: "u", body: "line" });
  const rangeComment = createComment({ comments: [lineComment], file, row: lineRow, kind: "range", scope: "u", body: "range" });
  const fileComment = createComment({ comments: [lineComment, rangeComment], file, row: fileRow, kind: "file", scope: "u", body: "file" });

  const found = commentsAtCursor({ comments: [lineComment, rangeComment, fileComment], scope: "u", file, row: secondRow });
  assert.deepEqual(found.map((comment) => comment.body).sort(), ["file", "range"]);
});

test("commentsSortedForNavigation uses PR-like file/apply ordering", () => {
  const foo = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const bar = parseSingleFilePatch({
    rawPatch: PATCH.replaceAll("src/foo.ts", "src/bar.ts"),
    status: "M",
    oldPath: "src/bar.ts",
    newPath: "src/bar.ts",
  });
  const fooRow = foo.rows.find((entry) => entry.kind === "added" && entry.text === "line3.5");
  const barRow = bar.rows.find((entry) => entry.kind === "added" && entry.text === "line2 changed");
  const comments = [
    createComment({ comments: [], file: foo, row: fooRow, kind: "line", scope: "u", body: "foo" }),
    createComment({ comments: [], file: bar, row: barRow, kind: "line", scope: "u", body: "bar" }),
  ];

  const sorted = commentsSortedForNavigation(comments, "u");
  assert.equal(sorted[0].displayPath, "src/bar.ts");
  assert.equal(sorted[1].displayPath, "src/foo.ts");
});

test("nextFileIndexMatching wraps to the next file with matching comments", () => {
  const files = [
    { fileKey: "a" },
    { fileKey: "b" },
    { fileKey: "c" },
  ];
  assert.equal(nextFileIndexMatching({ files, selectedFileIndex: 0, predicate: (fileKey) => fileKey === "c" }), 2);
  assert.equal(nextFileIndexMatching({ files, selectedFileIndex: 2, predicate: (fileKey) => fileKey === "b" }), 1);
});
