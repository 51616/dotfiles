import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGitStateSignature,
  formatGitStateLabel,
  parseNumstat,
  parsePorcelainFileCount,
  parsePorcelainUntrackedFileCount,
  parseUntrackedLineStats,
} from "../lib/git-state.ts";

const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}

test("parsePorcelainFileCount counts status lines", () => {
  assert.equal(parsePorcelainFileCount(" M a.ts\n?? b.ts\nR  old.ts -> new.ts\n"), 3);
});

test("parsePorcelainUntrackedFileCount counts untracked status lines", () => {
  assert.equal(parsePorcelainUntrackedFileCount(" M a.ts\n?? b.ts\n?? dir/c.ts\nR  old.ts -> new.ts\n"), 2);
});

test("parseNumstat sums text file additions and deletions and ignores binary markers", () => {
  assert.deepEqual(parseNumstat("10\t2\ta.ts\n-\t-\timage.png\n4\t0\tb.ts\n"), {
    additions: 14,
    deletions: 2,
  });
});

test("parseUntrackedLineStats parses the capped counter contract", () => {
  assert.deepEqual(parseUntrackedLineStats('{"additions":7,"capped":false}\n'), {
    additions: 7,
    capped: false,
  });
  assert.deepEqual(parseUntrackedLineStats('{"additions":2,"capped":true}'), {
    additions: 2,
    capped: true,
  });
  assert.equal(parseUntrackedLineStats("not json"), null);
});

test("formatGitStateLabel keeps a compact plain-text contract with colored numbers", () => {
  const label = formatGitStateLabel({ repoRoot: "/repo", branchName: "main", files: 3, additions: 120, deletions: 8, additionsUnknown: false });
  assert.equal(stripAnsi(label), " main 3 +120 -8");
  assert.ok(!label.startsWith("\x1b[2m"));
  assert.match(label, /\x1b\[1;36m3\x1b\[0m/);
  assert.match(label, /\x1b\[1;32m120\x1b\[0m/);
  assert.match(label, /\x1b\[1;31m8\x1b\[0m/);
});

test("formatGitStateLabel shows CLEAN! instead of zero counts", () => {
  const label = formatGitStateLabel({ repoRoot: "/repo", branchName: "main", files: 0, additions: 0, deletions: 0, additionsUnknown: false });
  assert.equal(stripAnsi(label), " main CLEAN!");
  assert.ok(!label.startsWith("\x1b[2m"));
  assert.match(label, /\x1b\[1;32mCLEAN!\x1b\[0m/);
});

test("formatGitStateLabel marks additions as partially unknown when untracked files exceed the cap", () => {
  const label = formatGitStateLabel({ repoRoot: "/repo", branchName: "main", files: 3, additions: 120, deletions: 8, additionsUnknown: true });
  assert.equal(stripAnsi(label), " main 3 +120+? -8");
});

test("formatGitStateLabel can show completely unknown additions", () => {
  const label = formatGitStateLabel({ repoRoot: "/repo", branchName: "main", files: 1, additions: 0, deletions: 0, additionsUnknown: true });
  assert.equal(stripAnsi(label), " main 1 +? -0");
});

test("buildGitStateSignature is stable and explicit", () => {
  assert.equal(buildGitStateSignature(null), "none");
  assert.equal(
    buildGitStateSignature({ repoRoot: "/repo", branchName: "main", files: 1, additions: 2, deletions: 3, additionsUnknown: false }),
    "/repo\tmain\t1\t2\t3\tfalse",
  );
});
