import test from "node:test";
import assert from "node:assert/strict";

import { encodeFindCursor, decodeFindCursor, encodeGrepCursor, decodeGrepCursor } from "../lib/cursors.ts";
import { formatFindOutput, formatGrepOutput } from "../lib/format.ts";
import { buildQuery } from "../lib/query.ts";

const roots = ["/local/worktree", "/remote/worktree"];

test("buildQuery accepts local and remote absolute constraints inside the workspace", () => {
  assert.equal(buildQuery("/local/worktree/src", "alpha", undefined, roots), "src/ alpha");
  assert.equal(buildQuery("/remote/worktree/pkg/mod.ts", "alpha", "!/remote/worktree/vendor", roots), "pkg/mod.ts !vendor/ alpha");
});

test("buildQuery rejects absolute constraints outside local and remote workspace roots", () => {
  assert.throws(() => buildQuery("/tmp/outside", "alpha", undefined, roots), /relative to the workspace/);
});

test("formatFindOutput preserves native order and annotates actionable paths", () => {
  const formatted = formatFindOutput({
    items: [
      { relativePath: "src/dirty.ts", gitStatus: "modified", totalFrecencyScore: 0 },
      { relativePath: "src/hot.ts", gitStatus: "clean", totalFrecencyScore: 30 },
    ],
    scores: [{ total: 100 }, { total: 90 }],
    totalMatched: 2,
    totalFiles: 10,
  }, 30, "src");

  assert.equal(formatted.output, "src/dirty.ts  [modified in git]\nsrc/hot.ts  [VERY often touched file]");
  assert.equal(formatted.weak, false);
});

test("formatGrepOutput groups consecutive matches by file with context", () => {
  const output = formatGrepOutput({
    items: [
      {
        relativePath: "README.md",
        gitStatus: "clean",
        lineNumber: 3,
        lineContent: "alpha beta",
        contextBefore: ["before"],
        contextAfter: ["after"],
      },
      {
        relativePath: "src/app.ts",
        gitStatus: "untracked",
        lineNumber: 10,
        lineContent: "const alpha = 1;",
      },
    ],
    totalMatched: 2,
    totalFiles: 2,
  });

  assert.equal(output, "README.md\n 2- before\n 3: alpha beta\n 4- after\n\nsrc/app.ts  [untracked in git]\n 10: const alpha = 1;");
});

test("remote cursor tokens round-trip all fields without an in-memory cursor map", () => {
  const find = {
    kind: "find",
    basePath: "/remote/worktree",
    query: "src/ alpha",
    pattern: "alpha",
    pageSize: 30,
    nextPageIndex: 2,
  };
  assert.deepEqual(decodeFindCursor(encodeFindCursor(find)), find);

  const grep = {
    kind: "grep",
    basePath: "/remote/worktree",
    query: "src/ alpha",
    pattern: "alpha",
    mode: "plain",
    smartCase: true,
    maxMatchesPerFile: 20,
    beforeContext: 1,
    afterContext: 1,
    cursorOffset: 42,
  };
  assert.deepEqual(decodeGrepCursor(encodeGrepCursor(grep)), grep);
});
