// @lat: [[tests#Diff-review tracker artifacts include canonical observed paths and advisory agent reports]]

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DiffReviewTurnTracker } from "../lib/tracker.ts";
import { buildRepoPatch } from "../lib/artifacts.ts";
import { captureFileImage } from "../lib/files.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";
import { MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO } from "../lib/types.ts";

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

test("captureFileImage uses a stable non_file omission for directories", () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "vendor"), { recursive: true });
  const repoState = { repoRoot: repo, repoKey: "repo-demo", capturedBytes: 0, baselineCapturedBytes: 0, touchedPaths: new Map() };

  const pre = captureFileImage(repoState, path.join(repo, "vendor"), "pre");
  const post = captureFileImage(repoState, path.join(repo, "vendor"), "post");

  assert.equal(pre.kind, "omitted");
  assert.equal(post.kind, "omitted");
  assert.equal(pre.reason, "non_file");
  assert.equal(post.reason, "non_file");
});

test("captureFileImage does not follow symlinks or broken symlinks", () => {
  const repo = makeRepo();
  const outside = path.join(path.dirname(repo), "outside.txt");
  fs.writeFileSync(outside, "outside-secret\n", "utf8");
  fs.symlinkSync(outside, path.join(repo, "src", "escape-link.txt"));
  fs.symlinkSync(path.join(repo, "missing-target.txt"), path.join(repo, "src", "broken-link.txt"));
  const repoState = { repoRoot: repo, repoKey: "repo-demo", capturedBytes: 0, baselineCapturedBytes: 0, touchedPaths: new Map() };

  const escaped = captureFileImage(repoState, path.join(repo, "src", "escape-link.txt"), "pre");
  const broken = captureFileImage(repoState, path.join(repo, "src", "broken-link.txt"), "pre");

  assert.equal(escaped.kind, "omitted");
  assert.equal(escaped.reason, "non_file");
  assert.equal(broken.kind, "omitted");
  assert.equal(broken.reason, "non_file");
});

test("captureFileImage enforces the total repo snapshot cap", () => {
  const repo = makeRepo();
  const smallPath = path.join(repo, "src", "small.txt");
  fs.writeFileSync(smallPath, "small\n", "utf8");
  const repoState = {
    repoRoot: repo,
    repoKey: "repo-demo",
    capturedBytes: MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO,
    baselineCapturedBytes: 0,
    touchedPaths: new Map(),
  };

  const image = captureFileImage(repoState, smallPath, "pre");
  assert.equal(image.kind, "omitted");
  assert.equal(image.reason, "total_cap_exceeded");
});

test("buildRepoPatch does not fabricate add/delete diffs when one snapshot side is omitted", () => {
  const repo = {
    repoRoot: "/repo",
    repoKey: "repo-demo",
    capturedBytes: 0,
    baselineCapturedBytes: 0,
    touchedPaths: new Map([
      ["src/large.ts", {
        repoRelPath: "src/large.ts",
        absolutePath: "/repo/src/large.ts",
        baseline: {
          kind: "content",
          exists: true,
          text: "export const value = 1;\n",
          sizeBytes: 24,
          mtimeMs: 1,
          sha256: "pre",
        },
        final: {
          kind: "omitted",
          exists: true,
          reason: "total_cap_exceeded",
          sizeBytes: 24,
          mtimeMs: 2,
        },
      }],
    ]),
  };

  const built = buildRepoPatch(repo);
  assert.match(built.patchText, /--- a\/src\/large.ts/);
  assert.match(built.patchText, /\+\+\+ b\/src\/large.ts/);
  assert.doesNotMatch(built.patchText, /@@/);
  assert.match(built.patchText, /pi-diff-review: diff omitted/);
  assert.deepEqual(built.observedChangedPaths, ["src/large.ts"]);
});

test("tracker writes latest and latest-reviewable turn patches from repo snapshots", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();
  await tracker.startTurn({ sessionId: "session-1", turnId: "turn-1", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
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
  assert.equal(latestJson.source, "last_turn_repo_snapshot");
  assert.equal(latestJson.review_source, "last turn (repo snapshot)");
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
  await tracker.startTurn({ sessionId: "session-empty-add", turnId: "turn-empty-add", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "empty.txt"), "", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/empty.txt"]);
});

test("tracker isolates per-turn diffs from pre-existing dirty workspace state", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });

  fs.writeFileSync(path.join(repo, "src", "preexisting.ts"), "export const dirty = true;\n", "utf8");
  await tracker.startTurn({ sessionId: "session-dirty", turnId: "turn-dirty", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  const latestPatch = fs.readFileSync(path.join(turnsRootFor(repo), "latest.patch"), "utf8");
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.match(latestPatch, /diff --git a\/src\/tracked.ts b\/src\/tracked.ts/);
  assert.doesNotMatch(latestPatch, /preexisting.ts/);
  assert.deepEqual(latestJson.touched_paths, ["src/tracked.ts"]);
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
});

test("tracker keeps baseline total-cap omissions stable across later snapshots", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
  const blob = `${"a".repeat(1023)}\n`.repeat(256);
  const fileCount = Math.floor(MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO / Buffer.byteLength(blob, "utf8")) + 1;
  const overflowPath = `src/large-${String(fileCount - 1).padStart(3, "0")}.txt`;

  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(repo, "src", `large-${String(index).padStart(3, "0")}.txt`), blob, "utf8");
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", "large-fixtures");

  await tracker.startTurn({ sessionId: "session-cap", turnId: "turn-cap", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "large-000.txt"), `${"b".repeat(1023)}\n`.repeat(256), "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/large-000.txt"]);
  assert.equal(latestJson.omitted_paths?.[overflowPath], undefined);
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
  await tracker.startTurn({ sessionId: "session-disabled", turnId: "turn-disabled", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.equal("agent_change_report" in latestJson, false);
});

test("tracker attaches validated advisory agent change reports for snapshot-observed files", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker({
    summarizeArtifact: async () => ({
      generated_at: "2026-03-31T00:00:00.000Z",
      generator: "mock-codex",
      files: [
        { path: "src/tracked.ts", summary: "Updated the exported value." },
      ],
      missing_from_observed: ["ignored-by-runtime"],
      missing_from_agent_report: ["ignored-by-runtime"],
    }),
  });
  await tracker.startTurn({ sessionId: "session-report", turnId: "turn-report", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRootFor(repo), "latest.json"), "utf8"));
  assert.deepEqual(latestJson.observed_changed_paths, ["src/tracked.ts"]);
  assert.deepEqual(latestJson.agent_change_report.files, [
    { path: "src/tracked.ts", summary: "Updated the exported value." },
  ]);
  assert.deepEqual(latestJson.agent_change_report.missing_from_observed, []);
  assert.deepEqual(latestJson.agent_change_report.missing_from_agent_report, []);
});

test("empty later turns do not clobber the last reviewable artifact", async () => {
  const repo = makeRepo();
  const tracker = new DiffReviewTurnTracker();

  await tracker.startTurn({ sessionId: "session-2", turnId: "turn-1", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 2;\n", "utf8");
  await tracker.finalize(repo);

  await tracker.startTurn({ sessionId: "session-2", turnId: "turn-2", cwd: repo });
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
  assert.match(latestJson.note, /No repo changes were observed/);
  assert.equal(sessionPatch, "");
  assert.deepEqual(sessionJson.touched_paths, []);
  assert.deepEqual(sessionJson.observed_changed_paths, []);
  assert.match(sessionJson.note, /No repo changes were observed/);

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
  await tracker.startTurn({ sessionId: "session-empty", turnId: "turn-empty", cwd: repo });
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
  await tracker.startTurn({ sessionId: "session-fail-open", turnId: "turn-fail-open", cwd: repo });
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
  await first.startTurn({ sessionId: "session-race", turnId: "turn-1", cwd: repo });
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
  await second.startTurn({ sessionId: "session-race", turnId: "turn-2", cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const value = 3;\n", "utf8");
  await second.finalize(repo);

  assert.equal(observedPreviousTurn, true);
  const latestJson = JSON.parse(fs.readFileSync(path.join(turnsRoot, "latest.json"), "utf8"));
  assert.equal(latestJson.turn_id, "turn-2");
  assert.equal(latestJson.agent_change_report.files[0].summary, "Second turn update.");
});
