import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DiffReviewTurnTracker } from "../lib/tracker.ts";
import { makeSshScopeKey } from "../../lib/pi-diff-review-ssh.ts";
import { resolveTurnLatestCandidates } from "../../pi-diff-review-tui/lib/diff-review-paths.ts";
import { createPiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

function sh(cwd, argv, options = {}) {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    input: options.input,
    timeout: options.timeout,
  });
  if (res.status !== 0) {
    throw new Error(`command failed: ${argv.join(" ")}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res.stdout;
}

function firstExistingCandidate(candidates) {
  for (const cand of candidates) {
    if (fs.existsSync(cand.patchPath) && fs.existsSync(cand.jsonPath)) return cand;
  }
  return null;
}

function makeLocalPiSshSession({ localRoot, remoteRoot, actualRemoteRoot, onReadFile }) {
  const mapRemotePath = (remotePath) => remotePath.startsWith(remoteRoot) ? `${actualRemoteRoot}${remotePath.slice(remoteRoot.length)}` : remotePath;
  const mapRemoteCommand = (command) => command.split(remoteRoot).join(actualRemoteRoot);

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
      readFile: async (remotePath) => {
        onReadFile?.(remotePath);
        return fs.promises.readFile(mapRemotePath(remotePath));
      },
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async () => {},
      writeFile: async () => {},
    },
    execCapture: async (command, options = {}) => {
      const res = spawnSync("bash", ["-lc", mapRemoteCommand(command)], {
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

test("turn-tracker: ssh mode isolates the per-turn delta without remote file crawling", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-turn-ssh-test-"));
  const localRoot = "/local/demo-repo";
  const remoteRoot = "/remote/demo-repo";
  let readFileCalls = 0;

  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    const filePath = path.join(tmp, "file.txt");
    const otherPath = path.join(tmp, "other.txt");
    fs.writeFileSync(filePath, "hello\n", "utf8");
    fs.writeFileSync(otherPath, "before\n", "utf8");
    sh(tmp, ["git", "add", "."]);
    sh(tmp, ["git", "commit", "-m", "init", "-q"]);

    fs.writeFileSync(otherPath, "dirty before turn\n", "utf8");

    const session = makeLocalPiSshSession({
      localRoot,
      remoteRoot,
      actualRemoteRoot: tmp,
      onReadFile: () => {
        readFileCalls += 1;
      },
    });
    const connection = session.getConnectionInfo();
    const scopeKey = makeSshScopeKey(connection, remoteRoot);

    const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
    await tracker.startTurn({ sessionId: "s1", turnId: "t1", cwd: localRoot, ssh: { session, repoRoot: remoteRoot, scopeKey } });

    fs.writeFileSync(filePath, "hello world\n", "utf8");
    await tracker.finalize(localRoot);

    const candidates = resolveTurnLatestCandidates({
      repoRoot: remoteRoot,
      scopeKey,
      allowRepoRoot: false,
      sessionId: "s1",
    });
    const found = firstExistingCandidate(candidates);
    assert.ok(found, `expected at least one turn artifact to exist; tried: ${candidates.map((c) => c.patchPath).join(", ")}`);

    const patchText = fs.readFileSync(found.patchPath, "utf8");
    const metadata = JSON.parse(fs.readFileSync(found.jsonPath, "utf8"));
    assert.equal(readFileCalls, 0);
    assert.match(patchText, /diff --git a\/file.txt b\/file.txt/);
    assert.doesNotMatch(patchText, /other.txt/);
    assert.deepEqual(metadata.touched_paths, ["file.txt"]);
    assert.deepEqual(metadata.observed_changed_paths, ["file.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("turn-tracker: ssh mode records symlink changes without reading the target file contents", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-turn-ssh-link-test-"));
  const localRoot = "/local/demo-repo";
  const remoteRoot = "/remote/demo-repo";

  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    fs.writeFileSync(path.join(tmp, "tracked.txt"), "tracked\n", "utf8");
    sh(tmp, ["git", "add", "tracked.txt"]);
    sh(tmp, ["git", "commit", "-m", "init", "-q"]);

    const outside = path.join(path.dirname(tmp), "ssh-tree-outside.txt");
    fs.writeFileSync(outside, "outside-secret\n", "utf8");

    const session = makeLocalPiSshSession({ localRoot, remoteRoot, actualRemoteRoot: tmp });
    const connection = session.getConnectionInfo();
    const scopeKey = makeSshScopeKey(connection, remoteRoot);

    const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
    await tracker.startTurn({ sessionId: "s-link", turnId: "t-link", cwd: localRoot, ssh: { session, repoRoot: remoteRoot, scopeKey } });

    fs.symlinkSync(outside, path.join(tmp, "escape-link.txt"));
    await tracker.finalize(localRoot);

    const candidates = resolveTurnLatestCandidates({
      repoRoot: remoteRoot,
      scopeKey,
      allowRepoRoot: false,
      sessionId: "s-link",
    });
    const found = firstExistingCandidate(candidates);
    assert.ok(found, `expected at least one turn artifact to exist; tried: ${candidates.map((c) => c.patchPath).join(", ")}`);

    const patchText = fs.readFileSync(found.patchPath, "utf8");
    const metadata = JSON.parse(fs.readFileSync(found.jsonPath, "utf8"));
    assert.match(patchText, /diff --git a\/escape-link.txt b\/escape-link.txt/);
    assert.match(patchText, /new file mode 120000/);
    assert.doesNotMatch(patchText, /outside-secret/);
    assert.deepEqual(metadata.touched_paths, ["escape-link.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("turn-tracker: ssh mode fails closed when remote workspace tree capture fails", async () => {
  const session = createPiSshSession({
    connection: {
      remote: "user@example.com",
      port: 2222,
      remoteCwd: "/remote/demo-repo",
      remoteHome: "/remote",
      localCwd: "/local/demo-repo",
      localHome: "/local",
    },
    transport: {
      exec: async () => ({ exitCode: 0 }),
      readFile: async () => {
        throw new Error("readFile should not be used");
      },
      ensureReadable: async () => {},
      ensureReadableWritable: async () => {},
      detectImageMimeType: async () => null,
      mkdir: async () => {},
      writeFile: async () => {},
    },
    execCapture: async () => ({
      stdout: Buffer.from(""),
      stderr: Buffer.from("git write-tree failed"),
      exitCode: 23,
      timedOut: false,
      aborted: false,
    }),
  });

  const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
  await assert.rejects(
    () => tracker.startTurn({
      sessionId: "s-fail",
      turnId: "t-fail",
      cwd: "/local/demo-repo",
      ssh: { session, repoRoot: "/remote/demo-repo", scopeKey: "ssh:user@example.com:/remote/demo-repo" },
    }),
    /git write-tree failed|remote snapshot failed/i,
  );
});
