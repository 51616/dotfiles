// @lat: [[tests#Diff-review tracker workspace-tree capture stays SSH-safe and dirty-state-safe]]

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  captureLocalWorkspaceTree,
  diffLocalWorkspaceTrees,
  parseTouchedPathsFromNameStatus,
} from "../lib/workspace-tree.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-workspace-tree-"));
  git(dir, "init");
  git(dir, "config", "user.email", "pi@example.com");
  git(dir, "config", "user.name", "pi");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "tracked.ts"), "export const value = 1;\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

test("workspace-tree diff isolates changes made after the start snapshot", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, "src", "preexisting.ts"), "export const dirty = true;\n", "utf8");
    const startTree = captureLocalWorkspaceTree(repo);

    fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
    const endTree = captureLocalWorkspaceTree(repo);
    const diff = diffLocalWorkspaceTrees(repo, startTree, endTree);

    assert.match(diff.patchText, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
    assert.doesNotMatch(diff.patchText, /preexisting.ts/);
    assert.deepEqual(diff.touchedPaths, ["src/tracked.ts"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace-tree capture excludes ignored files because it stages through a temporary index", () => {
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n", "utf8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "ignore-logs");

    const startTree = captureLocalWorkspaceTree(repo);
    fs.writeFileSync(path.join(repo, "ignored.log"), "should stay ignored\n", "utf8");
    fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 3;\n", "utf8");
    const endTree = captureLocalWorkspaceTree(repo);
    const diff = diffLocalWorkspaceTrees(repo, startTree, endTree);

    assert.match(diff.patchText, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
    assert.doesNotMatch(diff.patchText, /ignored.log/);
    assert.deepEqual(diff.touchedPaths, ["src/tracked.ts"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("parseTouchedPathsFromNameStatus prefers rename destinations and deduplicates results", () => {
  const touchedPaths = parseTouchedPathsFromNameStatus([
    "R100\tsrc/old.ts\tsrc/new.ts",
    "M\tsrc/new.ts",
    "A\tsrc/added.ts",
    "D\tsrc/deleted.ts",
  ].join("\n"));

  assert.deepEqual(touchedPaths, ["src/added.ts", "src/deleted.ts", "src/new.ts"]);
});
