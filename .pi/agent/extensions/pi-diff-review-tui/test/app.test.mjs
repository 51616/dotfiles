// @lat: [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]]

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DiffReviewApp } from "../lib/app.ts";
import { __setSshEditorPrestageDelayMsForTests } from "../lib/app-workflows.ts";
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

test("deferred reported-only SSH hydration warns and keeps the placeholder when the remote patch lookup fails", async () => {
  const notices = [];
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
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async () => {},
    },
    execText: async () => { throw new Error("remote boom"); },
    execCapture: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    }),
  });
  const file = {
    fileKey: "M:src/reported.ts",
    status: "M",
    oldPath: "src/reported.ts",
    newPath: "src/reported.ts",
    displayPath: "src/reported.ts",
    editablePath: "src/reported.ts",
    rawPatch: "",
    rows: [{ kind: "meta", text: "placeholder", rawText: "placeholder", fileKey: "M:src/reported.ts", rowIndex: 0 }],
    hunks: [],
    changeBlocks: [],
    isBinary: false,
    reviewProvenance: "reported_only",
    agentMismatch: "missing_from_observed",
    agentSummary: "reported summary",
    observedChangedPath: "src/reported.ts",
    reportedOnlyDiffState: "deferred_current_repo_diff",
    resolvedRepoRoot: "/remote/repo",
    resolvedEditablePath: "src/reported.ts",
  };
  const bundle = {
    ...makeBundle(file),
    turnMetadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-1",
      turn_id: "turn-1",
      source: "last_turn_repo_snapshot",
      review_source: "last turn (repo snapshot)",
      repo_root: "/remote/repo",
      repo_key: "repo",
      touched_paths: ["src/reported.ts"],
      observed_changed_paths: [],
      has_bash_calls: false,
      workspace: false,
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "test",
        files: [{ path: "src/reported.ts", summary: "reported summary" }],
        missing_from_observed: ["src/reported.ts"],
        missing_from_agent_report: [],
      },
    },
  };
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
  app.scope = "t";
  app.scopeStates = new Map([[
    "t",
    {
      scope: "t",
      bundle,
      startHead: null,
      startFingerprint: bundle.fingerprint,
      startFileHashes: new Map(bundle.fileHashes),
      lastReloadFingerprint: bundle.fingerprint,
      previousFileHashes: new Map(bundle.fileHashes),
      loadedAt: new Date().toISOString(),
      lastReloadAt: new Date().toISOString(),
      view: {
        selectedPath: file.displayPath,
        selectedFileIndex: 0,
        diffCursorRow: 0,
        diffCursorSide: null,
        diffCursorKind: "meta",
        diffCursorLine: null,
        diffScroll: 0,
        fileScroll: 0,
      },
    },
  ]]);
  app.selectedFileIndex = 0;

  app.maybeHydrateCurrentReportedOnlyFile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(app.scopeStates.get("t")?.bundle.files[0]?.reportedOnlyDiffState, "deferred_current_repo_diff");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.type, "warning");
  assert.match(notices[0]?.message ?? "", /Could not load the advisory repo diff for src\/reported\.ts/);
});

test("loading diff-review can be cancelled with q", () => {
  const doneCalls = [];
  const app = new DiffReviewApp({
    pi: {},
    repoRoot: "/repo",
    repoLabel: "/repo",
    scopeKey: "/repo",
    allowRepoRootWrites: true,
    backendKind: "local",
    sessionId: "session-1",
    tui: { terminal: { rows: 40 }, requestRender() {}, showOverlay() { return { hide() {} }; } },
    theme: makeTheme(),
    keybindings: {},
    callbacks: {
      notify() {},
      done(result) { doneCalls.push(result); },
      setEditorText() {},
    },
  });

  app.loadingMessage = "Loading diff…";
  app.handleInput("q");

  assert.deepEqual(doneCalls, [{ submitted: false }]);
});

test("diff-focus dwell pre-stages the selected SSH file before the editor opens", async () => {
  const originalEditor = process.env.EDITOR;
  const originalVisual = process.env.VISUAL;
  process.env.EDITOR = "true";
  process.env.VISUAL = "true";
  __setSshEditorPrestageDelayMsForTests(5);

  try {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-prestage-"));
    fs.mkdirSync(path.join(remoteRoot, "src"), { recursive: true });
    const targetPath = path.join(remoteRoot, "src", "example.ts");
    let readCount = 0;
    const session = createPiSshSession({
      connection: {
        remote: "user@example.com",
        port: 2222,
        remoteCwd: remoteRoot,
        remoteHome: path.dirname(remoteRoot),
        localCwd: "/repo",
        localHome: "/home/pi",
      },
      transport: {
        exec: async () => ({ exitCode: 0 }),
        readFile: async (remotePath) => {
          readCount += 1;
          return fs.promises.readFile(remotePath);
        },
        writeFile: async (remotePath, content) => {
          await fs.promises.writeFile(remotePath, content);
        },
        ensureReadable: async () => {},
        ensureReadableWritable: async () => {},
        detectImageMimeType: async () => null,
        mkdir: async (remoteDir) => { await fs.promises.mkdir(remoteDir, { recursive: true }); },
      },
      execCapture: async (command, options = {}) => {
        const stdout = execFileSync("bash", ["-lc", command], {
          cwd: remoteRoot,
          encoding: "buffer",
          input: options.stdin,
        });
        return {
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          timedOut: false,
          aborted: false,
        };
      },
    });
    const file = parseSingleFilePatch({
      rawPatch: PATCH,
      status: "M",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
    });
    fs.writeFileSync(path.join(remoteRoot, "src", "example.ts"), "const before = 1;\n", "utf8");

    const app = new DiffReviewApp({
      pi: {},
      repoRoot: remoteRoot,
      repoLabel: `SSH user@example.com:2222 ${remoteRoot}`,
      scopeKey: `ssh:user@example.com:2222:${remoteRoot}`,
      allowRepoRootWrites: false,
      backendKind: "ssh",
      sshIdentity: {
        session,
        connection: { kind: "ssh", remote: "user@example.com", port: 2222, remoteCwd: remoteRoot },
        remoteCwd: remoteRoot,
        repoRoot: remoteRoot,
        scopeKey: `ssh:user@example.com:2222:${remoteRoot}`,
        repoLabel: `SSH user@example.com:2222 ${remoteRoot}`,
      },
      sessionId: "session-1",
      tui: {
        terminal: { rows: 40 },
        requestRender() {},
        showOverlay() { return { hide() {} }; },
        stop() {},
        start() {},
      },
      theme: makeTheme(),
      keybindings: {},
      callbacks: {
        notify() {},
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
          repoRoot: remoteRoot,
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
    app.focusMode = "diff";

    app.handleSelectionChanged();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(readCount, 1);

    await app.workflows.openEditor(false);
    assert.equal(readCount, 1);
    assert.equal(fs.readFileSync(targetPath, "utf8"), "const before = 1;\n");
  } finally {
    __setSshEditorPrestageDelayMsForTests(2000);
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
  }
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
