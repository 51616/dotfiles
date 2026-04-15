import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import piDiffReviewTui from "../index.ts";
import { resolveInitialBundleSelection } from "../lib/review-bundles.ts";
import { safeSessionDirName } from "../lib/diff-review-paths.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(prefix = "pi-diff-review-entrypoint-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init");
  git(dir, "config", "user.email", "pi@example.com");
  git(dir, "config", "user.name", "pi");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "tracked.ts"), "export const tracked = 1;\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

function makePiStub() {
  const commands = new Map();
  return {
    commands,
    registerCommand(name, spec) {
      commands.set(name, spec);
    },
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
    source: "last_turn_repo_snapshot",
    review_source: "last turn (repo snapshot)",
    repo_root: repoRoot,
    repo_key: "repo-demo",
    touched_paths: ["src/tracked.ts"],
    observed_changed_paths: ["src/tracked.ts"],
    has_bash_calls: false,
    workspace: false,
    ...overrides,
  };
}

async function mountDiffReviewOverlay(factory) {
  const doneCalls = [];
  const app = await factory(
    {
      terminal: { rows: 40 },
      requestRender() {},
      showOverlay() { return { hide() {} }; },
    },
    {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => text,
      dim: (text) => text,
    },
    {},
    (result) => doneCalls.push(result),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { app, doneCalls };
}

test("entrypoint declares /diff-review command", () => {
  const filePath = new URL("../index.ts", import.meta.url);
  const source = fs.readFileSync(filePath, "utf8");
  assert.match(source, /registerCommand\("diff-review"/);
  assert.match(source, /TUI diff review/i);
});

test("resolveInitialBundleSelection prefers the session last-turn bundle when reviewable", async () => {
  const repo = makeRepo();
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
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 9;\n", "utf8");

  const selection = await resolveInitialBundleSelection(makePiStub(), repo, "session-1");

  assert.equal(selection.initialMode, "t");
  assert.equal(selection.initialBundle.sourceKind, "turn");
  assert.equal(selection.notification, undefined);
});

test("entrypoint falls back to workspace vs HEAD with an explicit notification", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");

  const pi = makePiStub();
  piDiffReviewTui(pi);
  const handler = pi.commands.get("diff-review")?.handler;
  assert.ok(handler, "diff-review handler should be registered");

  const notices = [];
  const customCalls = [];
  await handler([], {
    hasUI: true,
    cwd: repo,
    sessionManager: { getSessionId: () => "session-missing-turn" },
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      async custom(factory, options) {
        customCalls.push({ options, ...(await mountDiffReviewOverlay(factory)) });
      },
      setEditorText() {},
    },
  });

  assert.equal(customCalls.length, 1, "workspace fallback should still open the review overlay");
  assert.match(notices[0]?.message ?? "", /falling back to workspace vs HEAD/i);
  assert.equal(customCalls[0]?.doneCalls.length ?? 0, 0);
});

test("entrypoint runs debug mode without opening the overlay", async () => {
  const repo = makeRepo();

  const pi = makePiStub();
  piDiffReviewTui(pi);
  const handler = pi.commands.get("diff-review")?.handler;
  assert.ok(handler, "diff-review handler should be registered");

  const notices = [];
  let customCalled = false;
  const logged = [];
  const originalError = console.error;
  console.error = (message) => logged.push(String(message));
  try {
    await handler(["debug"], {
      hasUI: true,
      cwd: repo,
      sessionManager: { getSessionId: () => "session-debug" },
      ui: {
        notify(message, type) {
          notices.push({ message, type });
        },
        async custom() {
          customCalled = true;
        },
        setEditorText() {},
      },
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(customCalled, false);
  assert.match(logged[0] ?? "", /\[pi-diff-review debug\]/);
  assert.match(notices[0]?.message ?? "", /Printed diff-review debug report to stderr/i);
});

test("entrypoint does not open the overlay when neither last-turn nor workspace diffs are reviewable", async () => {
  const repo = makeRepo();

  const pi = makePiStub();
  piDiffReviewTui(pi);
  const handler = pi.commands.get("diff-review")?.handler;
  assert.ok(handler, "diff-review handler should be registered");

  const notices = [];
  const customCalls = [];
  await handler([], {
    hasUI: true,
    cwd: repo,
    sessionManager: { getSessionId: () => "session-clean" },
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      async custom(factory, options) {
        customCalls.push({ options, ...(await mountDiffReviewOverlay(factory)) });
      },
      setEditorText() {},
    },
  });

  assert.equal(customCalls.length, 1);
  assert.equal(customCalls[0]?.doneCalls.length, 1);
  assert.deepEqual(customCalls[0]?.doneCalls[0], { submitted: false });
  assert.match(notices[0]?.message ?? "", /No diff to review in last turn or workspace vs HEAD/i);
});
