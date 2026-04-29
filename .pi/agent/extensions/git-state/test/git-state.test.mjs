import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGitStateSignature,
  formatGitStateLabel,
  parseNumstat,
  parsePorcelainFileCount,
} from "../lib/git-state.ts";

const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}

test("parsePorcelainFileCount counts status lines", () => {
  assert.equal(parsePorcelainFileCount(" M a.ts\n?? b.ts\nR  old.ts -> new.ts\n"), 3);
});

test("parseNumstat sums text file additions and deletions and ignores binary markers", () => {
  assert.deepEqual(parseNumstat("10\t2\ta.ts\n-\t-\timage.png\n4\t0\tb.ts\n"), {
    additions: 14,
    deletions: 2,
  });
});

test("formatGitStateLabel keeps a compact plain-text contract with colored numbers", () => {
  const label = formatGitStateLabel({ repoRoot: "/repo", branchName: "main", files: 3, additions: 120, deletions: 8 });
  assert.equal(stripAnsi(label), " main 3f +120 -8");
  assert.match(label, /\x1b\[1;36m3\x1b\[0m/);
  assert.match(label, /\x1b\[1;32m120\x1b\[0m/);
  assert.match(label, /\x1b\[1;31m8\x1b\[0m/);
});

test("buildGitStateSignature is stable and explicit", () => {
  assert.equal(buildGitStateSignature(null), "none");
  assert.equal(
    buildGitStateSignature({ repoRoot: "/repo", branchName: "main", files: 1, additions: 2, deletions: 3 }),
    "/repo\tmain\t1\t2\t3",
  );
});
