// @lat: [[tests#Diff-review tracker artifacts include canonical observed paths and advisory agent reports]]

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

function turnsRootFor(repo) {
  return path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
}

test("tracker writes latest and latest-reviewable turn patches for edit/write touches", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();
  tracker.startTurn({ sessionId: "session-1", turnId: "turn-1", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  tracker.touchPath("src/new.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = 1;\n", "utf8");
  await tracker.finalize(repo);

  const turnsRoot = turnsRootFor(repo);
  const sessionRoot = path.join(turnsRoot, "sessions", "session-1");
  const latestPatch = fs.readFileSync(path.join(turnsRoot, "latest.patch"), "utf8");
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  const latestReviewablePatch = fs.readFileSync(path.join(turnsRoot, "latest-reviewable.patch"), "utf8");
  const latestReviewableJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest-reviewable.json"), "utf8"));
  const sessionPatch = fs.readFileSync(path.join(sessionRoot, "latest.patch"), "utf8");
  const sessionJson = JSON.parse(fs.readFileSync(path.join(sessionRoot, "latest.json"), "utf8"));
  const sessionReviewablePatch = fs.readFileSync(path.join(sessionRoot, "latest-reviewable.patch"), "utf8");
  const sessionReviewableJson = JSON.parse(fs.readFileSync(path.join(sessionRoot, "latest-reviewable.json"), "utf8"));
  assert.match(latestPatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.match(latestPatch, /diff --git a\/src\/new.ts b\/src\/new.ts/);
  assert.match(latestReviewablePatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.match(sessionPatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.match(sessionReviewablePatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.equal(latestJson.session_id, "session-1");
  assert.equal(latestJson.turn_id, "turn-1");
  assert.deepEqual(latestJson.touched_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.deepEqual(latestJson.observed_changed_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.equal(latestReviewableJson.turn_id, "turn-1");
  assert.deepEqual(latestReviewableJson.touched_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.deepEqual(latestReviewableJson.observed_changed_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.equal(sessionJson.session_id, "session-1");
  assert.equal(sessionJson.turn_id, "turn-1");
  assert.deepEqual(sessionJson.touched_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.deepEqual(sessionJson.observed_changed_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.equal(sessionReviewableJson.turn_id, "turn-1");
  assert.deepEqual(sessionReviewableJson.touched_paths, ["src/new.ts", "src/tracked.ts"]);
  assert.deepEqual(sessionReviewableJson.observed_changed_paths, ["src/new.ts", "src/tracked.ts"]);
});

test("tracker counts empty added files in observed_changed_paths even when the patch body is header-only", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();
  tracker.startTurn({ sessionId: "session-empty-add", turnId: "turn-empty-add", cwd: repo });
  tracker.touchPath("src/empty.txt", repo);
  fs.writeFileSync(path.join(repo, "src", "empty.txt"), "", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/empty.txt"]);
});

test("tracker can disable advisory agent change reports even when a summarizer is provided", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({
    enableAgentChangeReport: false,
    summarizeArtifact: async () => ({
      generated_at: "2026-03-31T00:00:00.000Z",
      generator: "mock-codex",
      files: [{ path: "src/tracked.ts", summary: "Should stay disabled." }],
      missing_from_observed: [],
      missing_from_agent_report: [],
    }),
  });
  tracker.startTurn({ sessionId: "session-disabled", turnId: "turn-disabled", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.equal("agent_change_report" in latestJson, false);
});

test("tracker attaches validated advisory agent change reports and computes exact mismatches", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({
    summarizeArtifact: async ({ metadata }) => ({
      generated_at: "2026-03-31T00:00:00.000Z",
      generator: "mock-codex",
      files: [
        { path: "src/tracked.ts", summary: "Updated the exported value." },
        { path: "docs/notes.md", summary: "Mentioned the change in docs." },
      ],
      missing_from_observed: ["ignored-by-runtime"],
      missing_from_agent_report: ["ignored-by-runtime"],
    }),
  });
  tracker.startTurn({ sessionId: "session-report", turnId: "turn-report", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  tracker.touchPath("docs/notes.md", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.deepEqual(latestJson.agent_change_report.files, [
    { path: "src/tracked.ts", summary: "Updated the exported value." },
    { path: "docs/notes.md", summary: "Mentioned the change in docs." },
  ]);
  assert.deepEqual(latestJson.agent_change_report.missing_from_observed, ["docs/notes.md"]);
  assert.deepEqual(latestJson.agent_change_report.missing_from_agent_report, []);
});

test("empty later turns do not clobber the last reviewable artifact", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();

  tracker.startTurn({ sessionId: "session-2", turnId: "turn-1", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  tracker.startTurn({ sessionId: "session-2", turnId: "turn-2", cwd: repo });
  tracker.recordBash("pwd", repo);
  await tracker.finalize(repo);

  const turnsRoot = turnsRootFor(repo);
  const sessionRoot = path.join(turnsRoot, "sessions", "session-2");
  const latestPatch = fs.readFileSync(path.join(turnsRoot, "latest.patch"), "utf8");
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  const latestReviewablePatch = fs.readFileSync(path.join(turnsRoot, "latest-reviewable.patch"), "utf8");
  const latestReviewableJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest-reviewable.json"), "utf8"));
  const sessionPatch = fs.readFileSync(path.join(sessionRoot, "latest.patch"), "utf8");
  const sessionJson = JSON.parse(fs.readFileSync(path.join(sessionRoot, "latest.json"), "utf8"));
  const sessionReviewablePatch = fs.readFileSync(path.join(sessionRoot, "latest-reviewable.patch"), "utf8");
  const sessionReviewableJson = JSON.parse(fs.readFileSync(path.join(sessionRoot, "latest-reviewable.json"), "utf8"));

  assert.equal(latestPatch, "");
  assert.deepEqual(latestJson.touched_paths, []);
  assert.deepEqual(latestJson.observed_changed_paths, []);
  assert.match(latestJson.note, /No agent-touched repo paths/);
  assert.equal(sessionPatch, "");
  assert.deepEqual(sessionJson.touched_paths, []);
  assert.deepEqual(sessionJson.observed_changed_paths, []);
  assert.match(sessionJson.note, /No agent-touched repo paths/);

  assert.match(latestReviewablePatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.equal(latestReviewableJson.turn_id, "turn-1");
  assert.deepEqual(latestReviewableJson.touched_paths, ["src/tracked.ts"]);
  assert.deepEqual(latestReviewableJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.match(sessionReviewablePatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.equal(sessionReviewableJson.turn_id, "turn-1");
  assert.deepEqual(sessionReviewableJson.touched_paths, ["src/tracked.ts"]);
  assert.deepEqual(sessionReviewableJson.observed_changed_paths, ["src/tracked.ts"]);
});

test("empty observed-diff turns discard invalid non-empty agent reports", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({
    summarizeArtifact: async () => ({
      generated_at: "2026-03-31T00:00:00.000Z",
      generator: "mock-codex",
      files: [{ path: "src/tracked.ts", summary: "Should be discarded." }],
      missing_from_observed: [],
      missing_from_agent_report: [],
    }),
  });
  tracker.startTurn({ sessionId: "session-empty", turnId: "turn-empty", cwd: repo });
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, []);
  assert.equal("agent_change_report" in latestJson, false);
});

test("tracker fails open when the advisory report step throws", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({
    summarizeArtifact: async () => {
      throw new Error("codex exploded");
    },
  });
  tracker.startTurn({ sessionId: "session-fail-open", turnId: "turn-fail-open", cwd: repo });
  tracker.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");

  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  const latestPatch = fs.readFileSync(path.join(turnsRootFor(repo), "latest.patch"), "utf8");
  assert.equal(latestJson.turn_id, "turn-fail-open");
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.equal("agent_change_report" in latestJson, false);
  assert.match(latestPatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
});

test("tracker finalizes artifacts only after the advisory report step finishes", async () => {
  const repo = makeRepo();
  const turnsRoot = turnsRootFor(repo);

  const first = new DiffReviewTurnTracker();
  first.startTurn({ sessionId: "session-race", turnId: "turn-1", cwd: repo });
  first.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await first.finalize(repo);

  let observedPreviousTurn = false;
  const second = new DiffReviewTurnTracker({
    summarizeArtifact: async () => {
      const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
      observedPreviousTurn = latestJson.turn_id === "turn-1";
      return {
        generated_at: "2026-03-31T00:00:00.000Z",
        generator: "mock-codex",
        files: [{ path: "src/tracked.ts", summary: "Second turn update." }],
        missing_from_observed: [],
        missing_from_agent_report: [],
      };
    },
  });
  second.startTurn({ sessionId: "session-race", turnId: "turn-2", cwd: repo });
  second.touchPath("src/tracked.ts", repo);
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 3;\n", "utf8");
  await second.finalize(repo);

  assert.equal(observedPreviousTurn, true);
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  assert.equal(latestJson.turn_id, "turn-2");
  assert.equal(latestJson.agent_change_report.files[0].summary, "Second turn update.");
});
