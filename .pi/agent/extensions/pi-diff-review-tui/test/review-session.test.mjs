import test from "node:test";
import assert from "node:assert/strict";

import { createComment } from "../lib/comments.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { commentsForSubmission, editorLineForRow, savedReviewMessage } from "../lib/review-session.ts";

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

test("editorLineForRow returns the targeted line only when requested", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  assert.equal(editorLineForRow(file.rows[6], true), 2);
  assert.equal(editorLineForRow(file.rows[7], true), 2);
  assert.equal(editorLineForRow(file.rows[5], false), undefined);
  assert.equal(editorLineForRow(null, true), undefined);
});

test("commentsForSubmission renumbers all comments and returns sorted scoped comments", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const u1 = createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "u1" });
  const s1 = createComment({ comments: [u1], file, row: file.rows[7], kind: "line", scope: "s", body: "s1" });
  const u2 = { ...createComment({ comments: [u1, s1], file, row: file.rows[7], kind: "line", scope: "u", body: "u2" }), ordinal: 9 };

  const next = commentsForSubmission([u1, s1, u2], "u");
  assert.deepEqual(next.scopedComments.map((comment) => comment.body), ["u1", "u2"]);
  assert.deepEqual(next.scopedComments.map((comment) => comment.ordinal), [1, 2]);
  assert.equal(next.allComments.find((comment) => comment.body === "s1")?.ordinal, 1);
});

test("savedReviewMessage reflects output-location priority clearly", () => {
  assert.deepEqual(savedReviewMessage({ outputPath: "/tmp/review.md", content: "", compactPrompt: "", outputLocation: "tmp" }), {
    message: "Saved review to /tmp/review.md",
    type: "info",
  });
  assert.deepEqual(savedReviewMessage({ outputPath: "/home/tan/.pi/diff-review/review.md", content: "", compactPrompt: "", outputLocation: "home" }), {
    message: "Saved review to home session fallback path /home/tan/.pi/diff-review/review.md (/tmp was not writable).",
    type: "warning",
  });
  assert.deepEqual(savedReviewMessage({ outputPath: "/repo/.pi/diff-review/review.md", content: "", compactPrompt: "", outputLocation: "repo" }), {
    message: "Saved review to repo fallback path /repo/.pi/diff-review/review.md (/tmp and ~/.pi/agent/sessions were not writable).",
    type: "warning",
  });
});
