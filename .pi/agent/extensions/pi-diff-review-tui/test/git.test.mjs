// @lat: [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]]

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { getDiffBundle } from "../lib/review-bundles.ts";
import { buildRejectedHunksPatch, reverseApplyPatch } from "../lib/rejected-hunks.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(prefix = "pi-diff-review-git-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function makeUnbornRepo(prefix = "pi-diff-review-unborn-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init");
  git(dir, "config", "user.email", "pi@example.com");
  git(dir, "config", "user.name", "pi");
  return dir;
}

function turnsDirFor(repo) {
  return path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repo), "diff-review", "turns");
}

function writeTurnArtifact({ repoRoot, sessionId, stem = "latest", patchText, metadata, rootDir = turnsDirFor(repoRoot) }) {
  const baseDir = sessionId ? path.join(rootDir, "sessions", sessionId) : rootDir;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, `${stem}.patch`), patchText, "utf8");
  fs.writeFileSync(path.join(baseDir, `${stem}.json`), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function baseMetadata(repoRoot, overrides = {}) {
  return {
    saved_at: new Date().toISOString(),
    session_id: "session-1",
    turn_id: "turn-1",
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repoRoot,
    repo_key: "repo-demo",
    touched_paths: ["src/tracked.ts"],
    observed_changed_paths: ["src/tracked.ts"],
    has_bash_calls: false,
    workspace: false,
    ...overrides,
  };
}

test("getDiffBundle loads workspace vs HEAD as one combined review mode", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "staged.ts"), "export const staged = 2;\n", "utf8");
  git(repo, "add", "src/staged.ts");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = 1;\n", "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "a");

  assert.equal(bundle.files.some((file) => file.displayPath.includes("staged.ts")), true);
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
  assert.equal(bundle.files.some((file) => file.displayPath.includes("new.ts")), true);
});

test("getDiffBundle keeps staged-only changes visible when the worktree matches HEAD", async () => {
  const repo = makeRepo();
  const filePath = path.join(repo, "src", "staged.ts");

  fs.writeFileSync(filePath, "export const staged = 2;\n", "utf8");
  git(repo, "add", "src/staged.ts");
  fs.writeFileSync(filePath, "export const staged = 1;\n", "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "a");
  const stagedOnly = bundle.files.find((file) => file.displayPath === "src/staged.ts");

  assert.ok(stagedOnly, "staged-only file should remain reviewable in workspace vs HEAD mode");
  assert.match(stagedOnly?.rawPatch ?? "", /\+export const staged = 2;/);
});

test("getDiffBundle keeps unborn-HEAD additions as one final file view", async () => {
  const repo = makeUnbornRepo();
  const filePath = path.join(repo, "src.ts");

  fs.writeFileSync(filePath, "export const staged = 1;\n", "utf8");
  git(repo, "add", "src.ts");
  fs.writeFileSync(filePath, "export const staged = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "note.txt"), "note\n", "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "a");
  const srcEntries = bundle.files.filter((file) => file.displayPath === "src.ts");

  assert.equal(srcEntries.length, 1);
  assert.equal(srcEntries[0]?.status, "A");
  assert.match(srcEntries[0]?.rawPatch ?? "", /\+export const staged = 2;/);
  assert.equal(bundle.files.some((file) => file.displayPath === "note.txt"), true);
});

test("getDiffBundle hides duplicate empty added files from the file pane", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "test.txt"), "", "utf8");

  const bundle = await getDiffBundle(makePiStub(), repo, "a");

  assert.equal(bundle.files.some((file) => file.displayPath === "test.txt"), false);
});

test("getDiffBundle loads the latest last-turn artifact for the active session", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
  assert.equal(bundle.files[0]?.reviewProvenance, "observed");
});

test("getDiffBundle tolerates older or malformed turn metadata by normalizing missing advisory fields", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-legacy",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-legacy",
      turn_id: "turn-legacy",
      source: "last_turn_agent_touched",
      review_source: "last turn (agent-touched)",
      repo_root: repo,
      repo_key: "repo-demo",
      touched_paths: ["src/tracked.ts"],
      has_bash_calls: false,
      agent_change_report: { files: "bad-shape" },
    },
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-legacy" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-legacy");
  assert.deepEqual(bundle.turnMetadata?.observed_changed_paths, ["src/tracked.ts"]);
  assert.equal(bundle.turnMetadata?.agent_change_report?.files.length, 0);
  assert.equal(bundle.files.some((file) => file.displayPath === "src/tracked.ts"), true);
});

test("getDiffBundle prefers the session-scoped turn artifact over the shared latest artifact", async () => {
  const repo = makeRepo();
  const turnsDir = turnsDirFor(repo);
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-1",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo),
  });
  writeTurnArtifact({
    repoRoot: repo,
    patchText: "",
    metadata: baseMetadata(repo, {
      session_id: "session-2",
      turn_id: "turn-2",
      touched_paths: [],
      observed_changed_paths: [],
      has_bash_calls: true,
      note: "No agent-touched repo paths were recorded for the last turn.",
    }),
    rootDir: turnsDir,
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
});

test("getDiffBundle falls back to latest-reviewable when the latest session turn is empty", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-1",
    stem: "latest",
    patchText: "",
    metadata: baseMetadata(repo, {
      turn_id: "turn-2",
      touched_paths: [],
      observed_changed_paths: [],
      has_bash_calls: true,
      note: "No agent-touched repo paths were recorded for the last turn.",
    }),
  });
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-1",
    stem: "latest-reviewable",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, { turn_id: "turn-1" }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-1" });
  assert.equal(bundle.sourceKind, "turn");
  assert.equal(bundle.turnMetadata?.turn_id, "turn-1");
  assert.equal(bundle.files.some((file) => file.displayPath.includes("tracked.ts")), true);
});

test("getDiffBundle ignores malformed advisory artifact paths before deriving repo diffs", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-invalid-agent-path",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, {
      session_id: "session-invalid-agent-path",
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "codex/gpt-5.3-codex",
        files: [{ path: ":(glob)src/tracked.ts", summary: "bad path" }],
        missing_from_observed: [":(glob)src/tracked.ts"],
        missing_from_agent_report: ["src/tracked.ts"],
      },
    }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-invalid-agent-path" });
  assert.equal(bundle.files.filter((file) => file.reviewProvenance === "reported_only").length, 0);
  const canonical = bundle.files.find((file) => file.displayPath === "src/tracked.ts");
  assert.equal(canonical?.agentMismatch, "missing_from_agent_report");
});

test("getDiffBundle adds reported-only rows and per-file advisory metadata from agent reports", async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "notes.md"), "# Notes\n\nCurrent repo diff\n", "utf8");

  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-agent",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, {
      session_id: "session-agent",
      touched_paths: ["src/tracked.ts", "docs/notes.md"],
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "codex/gpt-5.3-codex",
        files: [
          { path: "src/tracked.ts", summary: "Updated the tracked export." },
          { path: "docs/notes.md", summary: "Mentioned the behavior change in docs." },
        ],
        missing_from_observed: ["docs/notes.md"],
        missing_from_agent_report: [],
      },
    }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-agent" });
  const canonical = bundle.files.find((file) => file.displayPath === "src/tracked.ts");
  const reportedOnly = bundle.files.find((file) => file.displayPath === "docs/notes.md");
  assert.equal(canonical?.reviewProvenance, "observed");
  assert.equal(canonical?.agentSummary, "Updated the tracked export.");
  assert.equal(reportedOnly?.reviewProvenance, "reported_only");
  assert.equal(reportedOnly?.reportedOnlyDiffState, "derived_current_repo_diff");
  assert.equal(reportedOnly?.agentMismatch, "missing_from_observed");
  assert.match(reportedOnly?.rawPatch ?? "", /Current repo diff/);
});

test("getDiffBundle keeps canonical header-only empty-file additions visible in turn scope", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-empty-turn-add",
    patchText: [
      "diff --git a/src/empty.txt b/src/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, {
      session_id: "session-empty-turn-add",
      touched_paths: ["src/empty.txt"],
      observed_changed_paths: ["src/empty.txt"],
    }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-empty-turn-add" });
  const emptyFile = bundle.files.find((file) => file.displayPath === "src/empty.txt");
  assert.ok(emptyFile);
  assert.equal(emptyFile?.reviewProvenance, "observed");
  assert.equal(emptyFile?.status, "A");
  assert.equal(emptyFile?.hunks.length, 0);
  assert.equal(emptyFile?.rows.every((row) => row.kind === "meta"), true);
});

test("getDiffBundle keeps observed files visible when the agent report omits them", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-missing-agent",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, {
      session_id: "session-missing-agent",
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "codex/gpt-5.3-codex",
        files: [],
        missing_from_observed: [],
        missing_from_agent_report: ["src/tracked.ts"],
      },
    }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-missing-agent" });
  const canonical = bundle.files.find((file) => file.displayPath === "src/tracked.ts");
  assert.equal(canonical?.agentMismatch, "missing_from_agent_report");
  assert.equal(canonical?.reviewProvenance, "observed");
});

test("getDiffBundle shows a no-current-diff placeholder for reported-only files without current repo diffs", async () => {
  const repo = makeRepo();
  writeTurnArtifact({
    repoRoot: repo,
    sessionId: "session-no-current-diff",
    patchText: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: baseMetadata(repo, {
      session_id: "session-no-current-diff",
      touched_paths: ["src/tracked.ts", "docs/notes.md"],
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "codex/gpt-5.3-codex",
        files: [{ path: "docs/notes.md", summary: "Maybe changed notes." }],
        missing_from_observed: ["docs/notes.md"],
        missing_from_agent_report: ["src/tracked.ts"],
      },
    }),
  });

  const bundle = await getDiffBundle(makePiStub(), repo, "t", { sessionId: "session-no-current-diff" });
  const reportedOnly = bundle.files.find((file) => file.displayPath === "docs/notes.md");
  assert.equal(reportedOnly?.reviewProvenance, "reported_only");
  assert.equal(reportedOnly?.reportedOnlyDiffState, "no_current_repo_diff");
  assert.match(reportedOnly?.rows[0]?.text ?? "", /reported-only advisory file/);
});

test("getDiffBundle resolves workspace-prefixed reported-only files to their owning repo", async () => {
  const repoA = makeRepo("pi-diff-review-workspace-a-");
  const repoB = makeRepo("pi-diff-review-workspace-b-");
  fs.writeFileSync(path.join(repoB, "src", "tracked.ts"), "export const tracked = 9;\n", "utf8");

  writeTurnArtifact({
    repoRoot: repoA,
    sessionId: "session-workspace",
    patchText: [
      "diff --git a/repo-a/src/tracked.ts b/repo-a/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/repo-a/src/tracked.ts",
      "+++ b/repo-a/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    metadata: {
      ...baseMetadata(repoA, {
        session_id: "session-workspace",
        repo_root: "workspace",
        repo_key: "workspace",
        touched_paths: ["repo-a/src/tracked.ts", "repo-b/src/tracked.ts"],
        observed_changed_paths: ["repo-a/src/tracked.ts"],
        workspace: true,
        repos: [
          { repo_key: "repo-a", repo_root: repoA, touched_paths: ["src/tracked.ts"], observed_changed_paths: ["src/tracked.ts"] },
          { repo_key: "repo-b", repo_root: repoB, touched_paths: ["src/tracked.ts"], observed_changed_paths: [] },
        ],
        agent_change_report: {
          generated_at: new Date().toISOString(),
          generator: "codex/gpt-5.3-codex",
          files: [{ path: "repo-b/src/tracked.ts", summary: "Agent claimed repo-b changed too." }],
          missing_from_observed: ["repo-b/src/tracked.ts"],
          missing_from_agent_report: ["repo-a/src/tracked.ts"],
        },
      }),
    },
  });

  const bundle = await getDiffBundle(makePiStub(), repoA, "t", { sessionId: "session-workspace" });
  const reportedOnly = bundle.files.find((file) => file.displayPath === "repo-b/src/tracked.ts");
  assert.equal(reportedOnly?.reviewProvenance, "reported_only");
  assert.equal(reportedOnly?.resolvedRepoRoot, repoB);
  assert.equal(reportedOnly?.resolvedEditablePath, "src/tracked.ts");
  assert.equal(reportedOnly?.reportedOnlyDiffState, "derived_current_repo_diff");
  assert.equal(reportedOnly?.fileKey, "M:repo-b/src/tracked.ts->repo-b/src/tracked.ts");
  assert.equal(new Set((reportedOnly?.rows ?? []).map((row) => row.fileKey)).size, 1);
  assert.equal(reportedOnly?.rows[0]?.fileKey, "M:repo-b/src/tracked.ts->repo-b/src/tracked.ts");
  assert.match(reportedOnly?.rawPatch ?? "", /diff --git a\/repo-b\/src\/tracked\.ts b\/repo-b\/src\/tracked\.ts/);
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

  const bundle = await getDiffBundle(makePiStub(), repo, "a");
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
  const bundle = await getDiffBundle(pi, repo, "a");
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
  const bundle = await getDiffBundle(pi, repo, "a");
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
