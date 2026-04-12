// @lat: [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]]

import test from "node:test";
import assert from "node:assert/strict";

import { DiffReviewApp } from "../lib/app.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";

const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-const before = 1;",
  "+const after = 2;",
].join("\n");

function makeTheme() {
  return {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    dim: (text) => text,
  };
}

function makeBundle(file) {
  return {
    scope: "t",
    repoRoot: "/repo",
    head: null,
    files: [file],
    patchText: file.rawPatch,
    fingerprint: "fingerprint",
    fileHashes: new Map([[file.fileKey, "hash"]]),
    loadedAt: new Date().toISOString(),
    sourceKind: "turn",
    sourceLabel: "last turn (agent-touched)",
    turnMetadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-1",
      turn_id: "turn-1",
      source: "last_turn_agent_touched",
      review_source: "last turn (agent-touched)",
      repo_root: "/repo",
      repo_key: "repo",
      touched_paths: ["src/example.ts"],
      observed_changed_paths: ["src/example.ts"],
      has_bash_calls: false,
      workspace: false,
    },
  };
}

test("reported-only rows stay inspect-only for rejected-hunk toggles", () => {
  const notices = [];
  const file = {
    ...parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" }),
    reviewProvenance: "reported_only",
    reportedOnlyDiffState: "derived_current_repo_diff",
  };
  const addedRowIndex = file.rows.findIndex((row) => row.kind === "added");
  assert.ok(addedRowIndex >= 0);

  const app = new DiffReviewApp({
    pi: {},
    repoRoot: "/repo",
    sessionId: "session-1",
    tui: { requestRender() {}, showOverlay() { return { hide() {} }; } },
    theme: makeTheme(),
    keybindings: {},
    callbacks: {
      notify(message, type) {
        notices.push({ message, type });
      },
      done() {},
      setEditorText() {},
    },
  });

  app.scope = "t";
  app.scopeStates = new Map([[
    "t",
    {
      scope: "t",
      bundle: makeBundle(file),
      startHead: null,
      startFingerprint: "fingerprint",
      startFileHashes: new Map([[file.fileKey, "hash"]]),
      lastReloadFingerprint: "fingerprint",
      previousFileHashes: new Map([[file.fileKey, "hash"]]),
      loadedAt: new Date().toISOString(),
      lastReloadAt: new Date().toISOString(),
      view: {
        selectedPath: file.displayPath,
        selectedFileIndex: 0,
        diffCursorRow: addedRowIndex,
        diffCursorSide: "new",
        diffCursorKind: "added",
        diffCursorLine: 1,
        diffScroll: 0,
        fileScroll: 0,
      },
    },
  ]]);
  app.selectedFileIndex = 0;
  app.diffCursorRow = addedRowIndex;
  app.rejectedHunks = new Map();

  app.toggleCurrentHunkRejected();

  assert.equal(app.rejectedHunks.size, 0);
  assert.match(notices[0]?.message ?? "", /inspect-only in v1/);
});
