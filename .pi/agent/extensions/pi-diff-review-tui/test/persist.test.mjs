import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveReviewOutputDir, saveReviewToFile } from "../lib/persist.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-persist-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function sampleInput(repoRoot) {
  return {
    repoRoot,
    sessionId: "session-1",
    headAtStart: "abc1234",
    scope: "u",
    overallComment: "Please tighten this patch.",
    comments: [
      {
        id: "c1",
        ordinal: 2,
        fileKey: "M:src/a.ts->src/a.ts",
        fileStatus: "M",
        oldPath: "src/a.ts",
        newPath: "src/a.ts",
        editablePath: "src/a.ts",
        displayPath: "src/a.ts",
        scope: "u",
        originalAnchor: {
          kind: "line",
          origin: null,
          side: "new",
          line: 12,
          startLine: 12,
          endLine: 12,
          applyLine: 12,
          applyStartLine: 12,
          applyEndLine: 12,
          hunkId: "h1",
          hunkHeader: "@@ -1,2 +1,3 @@",
          targetText: "const x = 1;",
          contextBefore: [],
          contextAfter: [],
          normalizedTargetHash: "abc",
          searchText: "const x = 1;",
        },
        anchor: {
          kind: "line",
          origin: null,
          side: "new",
          line: 12,
          startLine: 12,
          endLine: 12,
          applyLine: 12,
          applyStartLine: 12,
          applyEndLine: 12,
          hunkId: "h1",
          hunkHeader: "@@ -1,2 +1,3 @@",
          targetText: "const x = 1;",
          contextBefore: [],
          contextAfter: [],
          normalizedTargetHash: "abc",
          searchText: "const x = 1;",
        },
        body: "Use a named helper.",
        compactSnippet: "@@ -1,2 +1,3 @@\n+const x = 1;",
        fullHunkText: "@@ -1,2 +1,3 @@\n+const x = 1;",
        status: "ok",
        remapNotes: [],
        candidateRemaps: [],
      },
    ],
    changesSinceStart: { changed: ["src/a.ts"], added: [], removed: [], unchanged: [] },
    changesSinceLastReload: { changed: [], added: [], removed: [], unchanged: ["src/a.ts"] },
  };
}

test("saveReviewToFile writes markdown and compact prompt", () => {
  const repoRoot = tmpRepo();
  const result = saveReviewToFile(sampleInput(repoRoot));

  assert.equal(fs.existsSync(result.outputPath), true);
  const saved = fs.readFileSync(result.outputPath, "utf8");
  assert.match(saved, /# π Diff Review/);
  assert.match(saved, /Use a named helper/);
  assert.match(result.compactPrompt, /Saved full review:/);
  assert.match(result.compactPrompt, /Reviewed scope: unstaged \[u\]/);
  assert.match(result.compactPrompt, /Legend: a\/ = pre-change context, b\/ = current code; make edits in b\//);
  assert.match(result.compactPrompt, /1\. b\/src\/a\.ts @ b:L12 \(anchor b:L12\)/);
  assert.doesNotMatch(result.compactPrompt, /2\. b\/src\/a\.ts @ b:L12 \(anchor b:L12\)/);
  assert.match(saved, /### b\/src\/a\.ts/);
  assert.match(saved, /#### 1\. b:L12/);
  assert.match(saved, /- file_status: modified/);
  assert.match(saved, /- apply_to: b:L12/);
  assert.equal(result.outputLocation, "tmp");
  assert.equal(result.outputPath.startsWith(path.join(os.tmpdir(), "pi", "sessions", safeSessionDirName(repoRoot), "diff-review")), true);
});

test("phase 13: saveReviewToFile includes original_anchor when comment is moved", () => {
  const repoRoot = tmpRepo();
  const input = sampleInput(repoRoot);
  input.comments[0].status = "moved";
  input.comments[0].originalAnchor.line = 10;
  input.comments[0].originalAnchor.startLine = 10;
  input.comments[0].originalAnchor.endLine = 10;
  input.comments[0].originalAnchor.applyLine = 10;
  input.comments[0].originalAnchor.applyStartLine = 10;
  input.comments[0].originalAnchor.applyEndLine = 10;

  const result = saveReviewToFile(input);
  const saved = fs.readFileSync(result.outputPath, "utf8");
  assert.match(saved, /- original_anchor: b:L10/);
  assert.match(saved, /- original_apply_to: b:L10/);
  assert.match(result.compactPrompt, /\(original b:L10\)/);
});

test("phase 14: saveReviewToFile records last-turn source metadata", () => {
  const repoRoot = tmpRepo();
  const result = saveReviewToFile({
    ...sampleInput(repoRoot),
    scope: "t",
    sourceKind: "turn",
    sourceLabel: "last turn (agent-touched)",
    turnMetadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-1",
      turn_id: "turn-14",
      source: "last_turn_agent_touched",
      review_source: "last turn (agent-touched)",
      repo_root: repoRoot,
      repo_key: "repo-demo",
      touched_paths: ["src/a.ts", "src/b.ts"],
      has_bash_calls: true,
      note: "bash calls occurred; non-edit/write file changes may not be fully attributed.",
      workspace: false,
    },
  });
  const saved = fs.readFileSync(result.outputPath, "utf8");
  assert.match(saved, /- review_source: last turn \(agent-touched\)/);
  assert.match(saved, /- source_turn_id: turn-14/);
  assert.match(saved, /- touched_paths: src\/a.ts, src\/b.ts/);
  assert.match(result.compactPrompt, /Review source: last turn \(agent-touched\)/);
  assert.match(result.compactPrompt, /Touched paths: src\/a.ts, src\/b.ts/);
});

test("resolveReviewOutputDir prefers /tmp before home or repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-output-order-"));
  const repoRoot = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const result = resolveReviewOutputDir({ repoRoot, sessionId: "session-1", agentDir: homeDir, tmpRoot });
  assert.equal(result.outputLocation, "tmp");
  assert.equal(result.dir, path.join(tmpRoot, "pi", "sessions", safeSessionDirName(repoRoot), "diff-review", "reviews", "sessions", "session-1"));
});

test("resolveReviewOutputDir falls back to ~/.pi/agent/sessions when /tmp is not writable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-output-home-"));
  const repoRoot = path.join(root, "repo");
  const homeDir = path.join(root, "home");
  const tmpBlocker = path.join(root, "tmp-blocker");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(tmpBlocker, "not a directory", "utf8");

  const result = resolveReviewOutputDir({ repoRoot, sessionId: "session-1", agentDir: homeDir, tmpRoot: tmpBlocker });
  assert.equal(result.outputLocation, "home");
  assert.equal(result.dir, path.join(homeDir, "sessions", safeSessionDirName(repoRoot), "diff-review", "reviews", "sessions", "session-1"));
});

test("resolveReviewOutputDir falls back to repo-local .pi when /tmp and ~/.pi/agent/sessions are not writable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-output-repo-"));
  const repoRoot = path.join(root, "repo");
  const tmpBlocker = path.join(root, "tmp-blocker");
  const homeBlocker = path.join(root, "home-blocker");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(tmpBlocker, "not a directory", "utf8");
  fs.writeFileSync(homeBlocker, "not a directory", "utf8");

  const result = resolveReviewOutputDir({ repoRoot, sessionId: "session-1", agentDir: homeBlocker, tmpRoot: tmpBlocker });
  assert.equal(result.outputLocation, "repo");
  assert.equal(result.dir, path.join(repoRoot, ".pi", "diff-review", "reviews", "sessions", "session-1"));
});
