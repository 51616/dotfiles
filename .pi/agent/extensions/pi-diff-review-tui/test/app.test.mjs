// @lat: [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]]

import test from "node:test";
import assert from "node:assert/strict";

import { DiffReviewApp } from "../lib/app.ts";
import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { createPiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

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
    sourceLabel: "last turn (repo snapshot)",
    turnMetadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-1",
      turn_id: "turn-1",
      source: "last_turn_repo_snapshot",
      review_source: "last turn (repo snapshot)",
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

test("open-editor workflow failures surface as notifications instead of unhandled rejections", async () => {
  const notices = [];
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });
  const failingSession = createPiSshSession({
    connection: {
      remote: "user@example.com",
      port: 2222,
      remoteCwd: "/remote/repo",
      remoteHome: "/remote",
      localCwd: "/repo",
      localHome: "/home/pi",
    },
    transport: {
      exec: async () => ({ exitCode: 0 }),
      readFile: async () => { throw new Error("boom"); },
      writeFile: async () => {},
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async () => {},
    },
    execCapture: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    }),
  });
  const app = new DiffReviewApp({
    pi: {},
    repoRoot: "/remote/repo",
    repoLabel: "SSH user@example.com:2222 /remote/repo",
    scopeKey: "ssh:user@example.com:2222:/remote/repo",
    allowRepoRootWrites: false,
    backendKind: "ssh",
    sshIdentity: {
      session: failingSession,
      connection: { kind: "ssh", remote: "user@example.com", port: 2222, remoteCwd: "/remote/repo" },
      remoteCwd: "/remote/repo",
      repoRoot: "/remote/repo",
      scopeKey: "ssh:user@example.com:2222:/remote/repo",
      repoLabel: "SSH user@example.com:2222 /remote/repo",
    },
    sessionId: "session-1",
    tui: {
      terminal: { rows: 40 },
      requestRender() {},
      showOverlay() { return { hide() {} }; },
    },
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

  app.loadingMessage = "";
  app.scope = "a";
  app.scopeStates = new Map([[
    "a",
    {
      scope: "a",
      bundle: {
        ...makeBundle(file),
        scope: "a",
        sourceKind: "workspace",
        sourceLabel: "workspace vs HEAD",
        turnMetadata: null,
      },
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
        diffCursorRow: 0,
        diffCursorSide: "new",
        diffCursorKind: "added",
        diffCursorLine: 1,
        diffScroll: 0,
        fileScroll: 0,
      },
    },
  ]]);
  app.selectedFileIndex = 0;

  await app.workflows.openEditor(true);

  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.type, "error");
  assert.match(notices[0]?.message ?? "", /^Could not complete the editor workflow:/);
});
