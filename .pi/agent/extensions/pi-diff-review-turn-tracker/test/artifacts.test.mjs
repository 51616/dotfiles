import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DiffReviewTurnTracker } from "../lib/tracker.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-turn-"));
  git(dir, "init");
  git(dir, "config", "user.email", "pi@example.com");
  git(dir, "config", "user.name", "pi");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "tracked.ts"), "export const value = 1;\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

test("tracker writes latest turn patch for edit/write touches", () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();
  tracker.startTurn({ sessionId: "session-1", turnId: "turn-1", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  tracker.touchPath("src/new.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = 1;\n", "utf8");
  tracker.finalize(repo);

  const turnsRoot = path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
  const latestPatch = fs.readFileSync(path.join(turnsRoot, "latest.patch"), "utf8");
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  assert.match(latestPatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.match(latestPatch, /diff --git a\/src\/new.ts b\/src\/new.ts/);
  assert.equal(latestJson.session_id, "session-1");
  assert.equal(latestJson.turn_id, "turn-1");
  assert.deepEqual(latestJson.touched_paths, ["src/new.ts", "src/tracked.ts"]);
});

test("tracker writes empty latest artifact when the turn touched no repo paths", () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();
  tracker.startTurn({ sessionId: "session-2", turnId: "turn-2", cwd: repo });
  tracker.finalize(repo);

  const turnsRoot = path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
  const latestPatch = fs.readFileSync(path.join(turnsRoot, "latest.patch"), "utf8");
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  assert.equal(latestPatch, "");
  assert.deepEqual(latestJson.touched_paths, []);
  assert.match(latestJson.note, /No agent-touched repo paths/);
});
