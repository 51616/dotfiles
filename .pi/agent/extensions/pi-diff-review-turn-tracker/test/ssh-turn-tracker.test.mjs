import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DiffReviewTurnTracker } from "../lib/tracker.ts";
import { DiffReviewSshHelperClient, makeSshScopeKey } from "../../lib/diff-review-ssh-helper/client.ts";
import { resolveTurnLatestCandidates } from "../../pi-diff-review-tui/lib/diff-review-paths.ts";

function sh(cwd, argv) {
  const res = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(`command failed: ${argv.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res.stdout;
}

function firstExistingCandidate(candidates) {
  for (const cand of candidates) {
    if (fs.existsSync(cand.patchPath) && fs.existsSync(cand.jsonPath)) return cand;
  }
  return null;
}

test("turn-tracker: ssh mode writes artifacts into local scopeKey root and produces a reviewable patch", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-turn-ssh-test-"));

  let helper;
  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    const filePath = path.join(tmp, "file.txt");
    fs.writeFileSync(filePath, "hello\n", "utf8");
    sh(tmp, ["git", "add", "file.txt"]);
    sh(tmp, ["git", "commit", "-m", "init", "-q"]);

    helper = await DiffReviewSshHelperClient.startLocalForTest({ cwd: tmp });
    const repoRoot = await helper.repoRoot(tmp);
    const scopeKey = makeSshScopeKey(helper.target, repoRoot);

    const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
    tracker.startTurn({ sessionId: "s1", turnId: "t1", cwd: repoRoot, ssh: { helper, repoRoot, scopeKey } });

    // Baseline capture.
    await tracker.touchPath("file.txt", repoRoot);

    // Mutate file after baseline.
    fs.writeFileSync(filePath, "hello world\n", "utf8");

    await tracker.finalize(repoRoot);

    const candidates = resolveTurnLatestCandidates({
      repoRoot,
      scopeKey,
      allowRepoRoot: false,
      sessionId: "s1",
    });
    const found = firstExistingCandidate(candidates);
    assert.ok(found, `expected at least one turn artifact to exist; tried: ${candidates.map((c) => c.patchPath).join(", ")}`);

    const patchText = fs.readFileSync(found.patchPath, "utf8");
    assert.ok(patchText.includes("diff --git a/file.txt b/file.txt"));
    assert.ok(patchText.includes("-hello") || patchText.includes("-hello\n"));
    assert.ok(patchText.includes("+hello world"));

    const metadata = JSON.parse(fs.readFileSync(found.jsonPath, "utf8"));
    assert.equal(metadata.session_id, "s1");
    assert.equal(metadata.turn_id, "t1");
    assert.equal(metadata.repo_root, repoRoot);
    assert.ok(Array.isArray(metadata.touched_paths));
    assert.deepEqual(metadata.touched_paths, ["file.txt"]);
  } finally {
    try {
      helper?.dispose();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
