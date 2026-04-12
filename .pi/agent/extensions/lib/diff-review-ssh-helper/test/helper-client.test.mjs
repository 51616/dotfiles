import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DiffReviewSshHelperClient } from "../client.ts";

function sh(cwd, argv) {
  const res = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(`command failed: ${argv.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res.stdout;
}

test("DiffReviewSshHelperClient (local test mode): repoRoot/diffWorkspace/applyReverse/patchForPath", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-helper-test-"));

  let helper;
  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    const filePath = path.join(tmp, "file.txt");
    fs.writeFileSync(filePath, "hello\n", "utf8");
    sh(tmp, ["git", "add", "file.txt"]);
    sh(tmp, ["git", "commit", "-m", "init", "-q"]);

    // make a workspace edit
    fs.writeFileSync(filePath, "hello world\n", "utf8");

    helper = await DiffReviewSshHelperClient.startLocalForTest({ cwd: tmp });

    const repoRoot = await helper.repoRoot(tmp);
    assert.equal(repoRoot, tmp);

    const patchForPath = await helper.patchForPath({ repoRoot, repoRelPath: "file.txt" });
    assert.ok(patchForPath.includes("diff --git a/file.txt b/file.txt"));

    const diff = await helper.diffWorkspace({
      repoRoot,
      limits: {
        max_patch_bytes_per_file: 1024 * 1024,
        max_total_patch_bytes: 1024 * 1024,
        max_files: 100,
      },
    });

    assert.ok(diff.head && typeof diff.head === "string");
    assert.ok(diff.patchText.includes("diff --git a/file.txt b/file.txt"));
    assert.ok(diff.nameStatus.includes("file.txt"));
    assert.deepEqual(Object.keys(diff.omittedPaths), []);

    const apply = await helper.applyReverse({ repoRoot, patchText: diff.patchText, strategy: "auto" });
    assert.equal(apply.ok, true);

    const finalText = fs.readFileSync(filePath, "utf8");
    assert.equal(finalText, "hello\n");
  } finally {
    try {
      helper?.dispose();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("DiffReviewSshHelperClient (local test mode): per-file patch trimming produces omittedPaths", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-helper-test-"));

  let helper;
  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    const bigPath = path.join(tmp, "big.txt");
    const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    fs.writeFileSync(bigPath, base, "utf8");
    sh(tmp, ["git", "add", "big.txt"]);
    sh(tmp, ["git", "commit", "-m", "big", "-q"]);

    // modify many lines to create a large patch
    const changed = Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join("\n") + "\n";
    fs.writeFileSync(bigPath, changed, "utf8");

    helper = await DiffReviewSshHelperClient.startLocalForTest({ cwd: tmp });
    const repoRoot = await helper.repoRoot(tmp);

    const diff = await helper.diffWorkspace({
      repoRoot,
      limits: {
        max_patch_bytes_per_file: 200,
        max_total_patch_bytes: 10 * 1024,
        max_files: 100,
      },
    });

    assert.ok(Object.keys(diff.omittedPaths).includes("big.txt"));
    assert.ok(diff.patchText.includes("pi-diff-review: diff omitted"));
  } finally {
    try {
      helper?.dispose();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
