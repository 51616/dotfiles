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
import { buildDiffReviewDebugReport, getWorkspaceBundle, resolveRepoIdentity } from "../lib/backend.ts";

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

function makeLocalPiSshSession({ localRoot, remoteRoot }) {
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
    execCapture: async (command, options = {}) => {
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

  __publishActivePiSshSessionForTests(makeLocalPiSshSession({ localRoot, remoteRoot: repo }));
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
