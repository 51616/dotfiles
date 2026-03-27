import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { getDiffBundle } from "../lib/git.ts";
import { buildRejectedHunksPatch, reverseApplyPatch } from "../lib/rejected-hunks.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-git-"));
  git(dir, "init");
  git(dir, "config", "user.email", "pi@example.com");
  git(dir, "config", "user.name", "pi");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "tracked.ts"), "export const tracked = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

function makePiStub() {
  return {
    async exec(command, args, options) {
      try {
        const stdout = execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return {
          code: error.status ?? 1,
          stdout: error.stdout?.toString?.() ?? "",
          stderr: error.stderr?.toString?.() ?? error.message,
        };
      }
    },
  };
}

test("getDiffBundle separates unstaged, staged, and all scopes", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "staged.ts"), "export const staged = 2;\n", "utf8");
  git(repo, "add", "src/staged.ts");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = 1;\n", "utf8");

  const pi = makePiStub();
  const unstaged = await getDiffBundle(pi, repo, "u");
  const staged = await getDiffBundle(pi, repo, "s");
  const all = await getDiffBundle(pi, repo, "a");

  assert.equal(unstaged.files.some((file) => file.displayPath.includes("tracked.ts")), true);
  assert.equal(unstaged.files.some((file) => file.displayPath.includes("new.ts")), true);
  assert.equal(staged.files.some((file) => file.displayPath.includes("staged.ts")), true);
  assert.equal(staged.files.some((file) => file.displayPath.includes("tracked.ts")), false);
  assert.equal(all.files.some((file) => file.displayPath.includes("staged.ts")), true);
  assert.equal(all.files.some((file) => file.displayPath.includes("tracked.ts")), true);
  assert.equal(all.files.some((file) => file.displayPath.includes("new.ts")), true);
});

test("getDiffBundle loads the latest last-turn artifact for the active session", async () => {
  const repo = makeRepo();
  const turnsDir = path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
  fs.mkdirSync(turnsDir, { recursive: true });
  fs.writeFileSync(path.join(turnsDir, "latest.patch"), [
    "diff --git a/src/tracked.ts b/src/tracked.ts",
    "index 1111111..2222222 100644",
    "--- a/src/tracked.ts",
    "+++ b/src/tracked.ts",
    "@@ -1 +1 @@",
    "-export const tracked = 1;",
    "+export const tracked = 2;",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(turnsDir, "latest.json"), JSON.stringify({
    saved_at: new Date().toISOString(),
    session_id: "session-1",
    turn_id: "turn-1",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repo,
    repo_key: "repo-demo",
    touched_paths: ["src/tracked.ts"],
    has_bash_calls: false,
  }, null, 2), "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
});

test("getDiffBundle prefers the session-scoped turn artifact over the shared latest artifact", async () => {
  const repo = makeRepo();
  const turnsDir = path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
  const sessionDir = path.join(turnsDir, "sessions", "session-1");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "latest.patch"), [
    "diff --git a/src/tracked.ts b/src/tracked.ts",
    "index 1111111..2222222 100644",
    "--- a/src/tracked.ts",
    "+++ b/src/tracked.ts",
    "@@ -1 +1 @@",
    "-export const tracked = 1;",
    "+export const tracked = 2;",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(sessionDir, "latest.json"), JSON.stringify({
    saved_at: new Date().toISOString(),
    session_id: "session-1",
    turn_id: "turn-1",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repo,
    repo_key: "repo-demo",
    touched_paths: ["src/tracked.ts"],
    has_bash_calls: false,
  }, null, 2), "utf8");
  fs.mkdirSync(turnsDir, { recursive: true });
  fs.writeFileSync(path.join(turnsDir, "latest.patch"), "", "utf8");
  fs.writeFileSync(path.join(turnsDir, "latest.json"), JSON.stringify({
    saved_at: new Date().toISOString(),
    session_id: "session-2",
    turn_id: "turn-2",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repo,
    repo_key: "repo-demo",
    touched_paths: [],
    has_bash_calls: true,
    note: "No agent-touched repo paths were recorded for the last turn.",
  }, null, 2), "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
});

test("getDiffBundle falls back to latest-reviewable when the latest session turn is empty", async () => {
  const repo = makeRepo();
  const turnsDir = path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
  const sessionDir = path.join(turnsDir, "sessions", "session-1");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "latest.patch"), "", "utf8");
  fs.writeFileSync(path.join(sessionDir, "latest.json"), JSON.stringify({
    saved_at: new Date().toISOString(),
    session_id: "session-1",
    turn_id: "turn-2",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repo,
    repo_key: "repo-demo",
    touched_paths: [],
    has_bash_calls: true,
    note: "No agent-touched repo paths were recorded for the last turn.",
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(sessionDir, "latest-reviewable.patch"), [
    "diff --git a/src/tracked.ts b/src/tracked.ts",
    "index 1111111..2222222 100644",
    "--- a/src/tracked.ts",
    "+++ b/src/tracked.ts",
    "@@ -1 +1 @@",
    "-export const tracked = 1;",
    "+export const tracked = 2;",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(sessionDir, "latest-reviewable.json"), JSON.stringify({
    saved_at: new Date().toISOString(),
    session_id: "session-1",
    turn_id: "turn-1",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repo,
    repo_key: "repo-demo",
    touched_paths: ["src/tracked.ts"],
    has_bash_calls: false,
  }, null, 2), "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
});

test("buildRejectedHunksPatch keeps file headers and only the rejected changed block", async () => {
  const repo = makeRepo();
  const filePath = path.join(repo, "src", "tracked.ts");
  fs.writeFileSync(filePath, [
    "export const tracked = 1;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 4;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");
  git(repo, "add", "src/tracked.ts");
  git(repo, "commit", "-m", "expand tracked fixture");

  fs.writeFileSync(filePath, [
    "export const tracked = 2;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 40;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "u");
  const file = bundle.files.find((entry) => entry.displayPath.includes("tracked.ts"));
  assert.ok(file);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.changeBlocks.length, 2);

  const patch = buildRejectedHunksPatch({
    bundle,
    rejectedHunksByFile: new Map([[file.fileKey, new Set([file.changeBlocks[1].id])]]),
  });

  assert.match(patch, /^diff --git a\/src\/tracked\.ts b\/src\/tracked\.ts/m);
  assert.match(patch, /second = 40/);
  assert.doesNotMatch(patch, /tracked = 2/);
  assert.match(patch, /^@@ -2,4 \+2,4 @@/m);
});

test("reverseApplyPatch reverts only the rejected changed block in the working tree", async () => {
  const repo = makeRepo();
  const filePath = path.join(repo, "src", "tracked.ts");
  fs.writeFileSync(filePath, [
    "export const tracked = 1;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 4;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");
  git(repo, "add", "src/tracked.ts");
  git(repo, "commit", "-m", "expand tracked fixture");

  fs.writeFileSync(filePath, [
    "export const tracked = 2;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 40;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");

  const pi = makePiStub();
  const bundle = await getDiffBundle(pi, repo, "u");
  const file = bundle.files.find((entry) => entry.displayPath.includes("tracked.ts"));
  assert.ok(file);
  assert.equal(file.hunks.length, 1);
  assert.equal(file.changeBlocks.length, 2);

  const patch = buildRejectedHunksPatch({
    bundle,
    rejectedHunksByFile: new Map([[file.fileKey, new Set([file.changeBlocks[1].id])]]),
  });

  const result = await reverseApplyPatch({ pi, repoRoot: repo, patchText: patch });
  assert.equal(result.ok, true);

  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /tracked = 2/);
  assert.match(updated, /second = 4/);
});

test("reverseApplyPatch leaves the working tree alone when checks fail", async () => {
  const repo = makeRepo();
  const filePath = path.join(repo, "src", "tracked.ts");
  fs.writeFileSync(filePath, [
    "export const tracked = 1;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 4;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");
  git(repo, "add", "src/tracked.ts");
  git(repo, "commit", "-m", "expand tracked fixture");

  fs.writeFileSync(filePath, [
    "export const tracked = 2;",
    "export const keep1 = 1;",
    "export const keep2 = 2;",
    "export const second = 40;",
    "export const tail = 5;",
    "",
  ].join("\n"), "utf8");

  const pi = makePiStub();
  const bundle = await getDiffBundle(pi, repo, "u");
  const file = bundle.files.find((entry) => entry.displayPath.includes("tracked.ts"));
  assert.ok(file);

  const patch = buildRejectedHunksPatch({
    bundle,
    rejectedHunksByFile: new Map([[file.fileKey, new Set([file.changeBlocks[1].id])]]),
  }).replace("export const second = 40;", "export const second = 999;");

  const result = await reverseApplyPatch({ pi, repoRoot: repo, patchText: patch });
  assert.equal(result.ok, false);

  const updated = fs.readFileSync(filePath, "utf8");
  assert.match(updated, /tracked = 2/);
  assert.match(updated, /second = 40/);
});
