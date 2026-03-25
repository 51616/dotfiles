import test from "node:test";
import assert from "node:assert/strict";

import { createComment } from "../lib/comments.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { applyCandidateRemap, removeCommentById, resolveCommentAtCursor, unresolvedCommentsForScope, updateCommentBody } from "../lib/comment-resolution.ts";

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

test("removeCommentById renumbers remaining comments densely", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const first = createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" });
  const second = createComment({ comments: [first], file, row: file.rows[7], kind: "line", scope: "u", body: "two" });

  const next = removeCommentById([first, second], first.id);
  assert.equal(next.length, 1);
  assert.equal(next[0].body, "two");
  assert.equal(next[0].ordinal, 1);
});

test("updateCommentBody trims the edited body", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const comment = createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" });
  const next = updateCommentBody([comment], comment.id, "  changed body  ");
  assert.equal(next[0].body, "changed body");
});

test("updateCommentBody removes the comment when the edited body is empty", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const first = createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" });
  const second = createComment({ comments: [first], file, row: file.rows[7], kind: "line", scope: "u", body: "two" });

  const next = updateCommentBody([first, second], first.id, "   ");
  assert.equal(next.length, 1);
  assert.equal(next[0].body, "two");
  assert.equal(next[0].ordinal, 1);
});

test("resolveCommentAtCursor can downgrade a stale comment to file level", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const comment = {
    ...createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" }),
    status: "stale_unresolved",
  };

  const next = resolveCommentAtCursor({ comments: [comment], comment, file, row: file.rows[5], downgrade: "file" });
  assert.ok(next);
  assert.equal(next[0].anchor.kind, "file");
  assert.equal(next[0].originalAnchor.kind, "line");
  assert.equal(next[0].status, "moved");
  assert.equal(next[0].candidateRemaps.length, 0);
});

test("applyCandidateRemap rewrites location and clears candidate list", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const comment = {
    ...createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" }),
    status: "stale_unresolved",
    candidateRemaps: [{
      kind: "candidate",
      fileKey: file.fileKey,
      displayPath: file.displayPath,
      side: "new",
      line: 3,
      hunkId: file.rows[7].hunkId ?? null,
      rowIndex: 7,
      preview: "+line2 changed",
    }],
  };

  const next = applyCandidateRemap({ comments: [comment], comment, candidateIndex: 0 });
  assert.ok(next);
  assert.equal(next[0].status, "moved");
  assert.equal(next[0].anchor.line, 3);
  assert.equal(next[0].candidateRemaps.length, 0);
});

test("phase 13: applyCandidateRemap preserves originalAnchor", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const base = createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" });
  const originalLine = base.originalAnchor.line;

  const comment = {
    ...base,
    status: "stale_unresolved",
    candidateRemaps: [{
      kind: "candidate",
      fileKey: file.fileKey,
      displayPath: file.displayPath,
      side: "new",
      line: 3,
      hunkId: file.rows[7].hunkId ?? null,
      rowIndex: 7,
      preview: "+line2 changed",
    }],
  };

  const next = applyCandidateRemap({ comments: [comment], comment, candidateIndex: 0 });
  assert.ok(next);
  assert.equal(next[0].originalAnchor.line, originalLine);
  assert.equal(next[0].anchor.line, 3);
});

test("unresolvedCommentsForScope returns only stale comments for the active scope", () => {
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/foo.ts", newPath: "src/foo.ts" });
  const stale = { ...createComment({ comments: [], file, row: file.rows[6], kind: "line", scope: "u", body: "one" }), status: "stale_unresolved" };
  const ok = createComment({ comments: [stale], file, row: file.rows[7], kind: "line", scope: "u", body: "two" });
  const otherScope = createComment({ comments: [stale, ok], file, row: file.rows[7], kind: "line", scope: "s", body: "three" });

  const next = unresolvedCommentsForScope([stale, ok, otherScope], "u");
  assert.deepEqual(next.map((comment) => comment.id), [stale.id]);
});
