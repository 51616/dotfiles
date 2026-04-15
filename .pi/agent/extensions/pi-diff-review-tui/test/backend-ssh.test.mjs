import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  __publishActivePiSshSessionForTests,
  __resetPiSshSessionForTests,
  createPiSshSession,
} from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";
import { buildDiffReviewDebugReport, getTurnBundleWithAgentReport, getWorkspaceBundle, hydrateReportedOnlyTurnBundleFile, resolveRepoIdentity } from "../lib/backend.ts";
import { buildBundleFromPatchText } from "../lib/git.ts";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(prefix = "pi-diff-review-ssh-backend-") {
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

function makeLocalPiSshSession({ localRoot, remoteRoot, counters }) {
  return createPiSshSession({
    connection: {
      remote: "user@example.com",
      port: 2222,
      remoteCwd: remoteRoot,
      remoteHome: path.dirname(remoteRoot),
      localCwd: localRoot,
      localHome: path.dirname(localRoot),
    },
    transport: {
      exec: async () => ({ exitCode: 0 }),
      readFile: async (remotePath) => fs.promises.readFile(remotePath),
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async () => {},
      writeFile: async () => {},
    },
    execText: async (command, options = {}) => {
      if (counters) {
        counters.execText += 1;
        counters.execTextCommands = counters.execTextCommands ?? [];
        counters.execTextCommands.push(command);
      }
      const res = spawnSync("bash", ["-lc", command], {
        encoding: "utf8",
        timeout: (options.timeoutSeconds ?? 30) * 1000,
      });
      return {
        output: typeof res.stdout === "string" ? res.stdout : String(res.stdout ?? ""),
        exitCode: typeof res.status === "number" ? res.status : null,
        timedOut: res.signal === "SIGTERM",
        aborted: false,
      };
    },
    execCapture: async (command, options = {}) => {
      counters && (counters.execCapture += 1);
      const res = spawnSync("bash", ["-lc", command], {
        encoding: "buffer",
        input: options.stdin,
        timeout: (options.timeoutSeconds ?? 30) * 1000,
      });
      return {
        stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? ""),
        stderr: Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.from(res.stderr ?? ""),
        exitCode: typeof res.status === "number" ? res.status : null,
        timedOut: res.signal === "SIGTERM",
        aborted: false,
      };
    },
  });
}

test("resolveRepoIdentity and getWorkspaceBundle use the active pi-ssh session", async () => {
  __resetPiSshSessionForTests();
  const repo = makeRepo();
  const localRoot = "/local/demo-repo";
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "new.ts"), "export const newer = 1;\n", "utf8");

  const counters = { execText: 0, execCapture: 0, execTextCommands: [] };
  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo, counters }));
  const pi = makePiStub();

  const identity = await resolveRepoIdentity(pi, localRoot);
  assert.equal(identity.backend, "ssh");
  assert.equal(identity.repoRoot, repo);
  assert.equal(identity.allowRepoRootWrites, false);
  assert.match(identity.repoLabel, /SSH user@example.com:2222/);

  const bundle = await getWorkspaceBundle(pi, identity);
  assert.equal(bundle.scope, "a");
  assert.equal(bundle.files.some((file) => file.displayPath === "src/tracked.ts"), true);
  assert.equal(bundle.files.some((file) => file.displayPath === "src/new.ts"), true);
  assert.equal(bundle.repoRoot, repo);
  assert.ok(counters.execText >= 2, `expected persistent execText calls, got ${counters.execText}`);
  assert.equal(counters.execCapture, 0);
  assert.equal(counters.execTextCommands.some((command) => command.includes("__PI_DIFF_REVIEW_REMOTE_WORKTREE_PATCH_START_7f4d0d6d__")), true);
});

test("remote workspace bundle does not duplicate staged tracked hunks", async () => {
  __resetPiSshSessionForTests();
  const repo = makeRepo("pi-diff-review-ssh-staged-");
  const localRoot = "/local/staged-demo";
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");
  git(repo, "add", "src/tracked.ts");

  const counters = { execText: 0, execCapture: 0, execTextCommands: [] };
  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo, counters }));
  const identity = await resolveRepoIdentity(makePiStub(), localRoot);
  const bundle = await getWorkspaceBundle(makePiStub(), identity);
  const tracked = bundle.files.find((file) => file.displayPath === "src/tracked.ts");

  assert.ok(tracked);
  assert.equal((tracked.rawPatch.match(/^@@ /gm) ?? []).length, 1);
  assert.equal(tracked.rows.filter((row) => row.kind === "added").length, 1);
  assert.equal(tracked.rows.filter((row) => row.kind === "removed").length, 1);
});

test("remote workspace bundle keeps the final worktree state for unborn HEAD repos", async () => {
  __resetPiSshSessionForTests();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-ssh-unborn-"));
  git(repo, "init");
  git(repo, "config", "user.email", "pi@example.com");
  git(repo, "config", "user.name", "pi");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 1;\n", "utf8");
  git(repo, "add", "src/tracked.ts");
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");

  const localRoot = "/local/unborn-demo";
  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo, counters: { execText: 0, execCapture: 0, execTextCommands: [] } }));
  const identity = await resolveRepoIdentity(makePiStub(), localRoot);
  const bundle = await getWorkspaceBundle(makePiStub(), identity);
  const tracked = bundle.files.find((file) => file.displayPath === "src/tracked.ts");

  assert.ok(tracked);
  assert.match(tracked.rawPatch, /\+export const tracked = 2;/);
  assert.doesNotMatch(tracked.rawPatch, /\+export const tracked = 1;/);
});

test("resolveRepoIdentity falls back to the session remote cwd when the mapped cwd is invalid", async () => {
  __resetPiSshSessionForTests();
  const repo = makeRepo("pi-diff-review-ssh-fallback-");
  const localRoot = "/local/fallback-repo";
  const pi = makePiStub();

  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo }));
  const identity = await resolveRepoIdentity(pi, path.join(localRoot, "nested", "missing"));

  assert.equal(identity.backend, "ssh");
  assert.equal(identity.repoRoot, repo);
});

test("SSH turn bundles defer reported-only repo diffs until a file is selected", async () => {
  __resetPiSshSessionForTests();
  const repo = makeRepo("pi-diff-review-turn-bundle-ssh-");
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "reported.ts"), "export const reported = 1;\n", "utf8");

  const counters = { execText: 0, execCapture: 0, execTextCommands: [] };
  const session = makeLocalPiSshSession({ localRoot: "/local/demo-repo", remoteRoot: repo, counters });
  const identity = {
    backend: "ssh",
    repoRoot: repo,
    scopeKey: `ssh:user@example.com:2222:${repo}`,
    allowRepoRootWrites: false,
    repoLabel: `SSH user@example.com:2222 ${repo}`,
    ssh: {
      session,
      connection: { kind: "ssh", remote: "user@example.com", port: 2222, remoteCwd: repo },
      remoteCwd: repo,
      repoRoot: repo,
      scopeKey: `ssh:user@example.com:2222:${repo}`,
      repoLabel: `SSH user@example.com:2222 ${repo}`,
    },
  };
  const bundle = buildBundleFromPatchText({
    scope: "t",
    repoRoot: repo,
    head: null,
    patchTextRaw: [
      "diff --git a/src/tracked.ts b/src/tracked.ts",
      "index 1111111..2222222 100644",
      "--- a/src/tracked.ts",
      "+++ b/src/tracked.ts",
      "@@ -1 +1 @@",
      "-export const tracked = 1;",
      "+export const tracked = 2;",
      "",
    ].join("\n"),
    sourceKind: "turn",
    turnMetadata: {
      saved_at: new Date().toISOString(),
      session_id: "session-1",
      turn_id: "turn-1",
      source: "last_turn_repo_snapshot",
      review_source: "last turn (repo snapshot)",
      repo_root: repo,
      repo_key: "repo-demo",
      touched_paths: ["src/tracked.ts", "src/reported.ts"],
      observed_changed_paths: ["src/tracked.ts"],
      has_bash_calls: false,
      workspace: false,
      agent_change_report: {
        generated_at: new Date().toISOString(),
        generator: "test",
        files: [
          { path: "src/tracked.ts", summary: "tracked summary" },
          { path: "src/reported.ts", summary: "reported summary" },
        ],
        missing_from_observed: ["src/reported.ts"],
        missing_from_agent_report: [],
      },
    },
  });

  const enriched = await getTurnBundleWithAgentReport(makePiStub(), identity, bundle);
  const reportedOnly = enriched.files.find((file) => file.displayPath === "src/reported.ts");
  assert.ok(reportedOnly);
  assert.equal(reportedOnly.reportedOnlyDiffState, "deferred_current_repo_diff");
  assert.equal(counters.execText, 0);

  const hydrated = await hydrateReportedOnlyTurnBundleFile(makePiStub(), identity, enriched, reportedOnly.fileKey);
  const hydratedFile = hydrated.files.find((file) => file.displayPath === "src/reported.ts");
  assert.ok(hydratedFile);
  assert.equal(hydratedFile.reportedOnlyDiffState, "derived_current_repo_diff");
  assert.match(hydratedFile.rawPatch, /src\/reported\.ts/);
  assert.ok(counters.execText >= 1);
});

test("buildDiffReviewDebugReport prints both local and remote behavior summaries", async () => {
  __resetPiSshSessionForTests();
  const repo = makeRepo("pi-diff-review-debug-");
  const localRoot = repo;
  fs.writeFileSync(path.join(repo, "src", "tracked.ts"), "export const tracked = 3;\n", "utf8");

  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo }));
  const report = await buildDiffReviewDebugReport(makePiStub(), localRoot);

  assert.match(report, /\[pi-diff-review debug\]/);
  assert.match(report, /local behavior: git:1 file/);
  assert.match(report, /remote target: user@example.com:2222/);
  assert.match(report, new RegExp(`remote repo root: ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(report, /remote behavior: git:1 file/);
});
