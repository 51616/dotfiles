import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { getDiffBundle } from "../lib/git.ts";
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
