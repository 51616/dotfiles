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

test("turn-tracker: ssh mode uses the shared pi-ssh session mapping and writes a reviewable patch", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-turn-ssh-test-"));
  const localRoot = "/local/demo-repo";

  try {
    sh(tmp, ["git", "init", "-q"]);
    sh(tmp, ["git", "config", "user.email", "pi@example.com"]);
    sh(tmp, ["git", "config", "user.name", "pi"]);

    const filePath = path.join(tmp, "file.txt");
    fs.writeFileSync(filePath, "hello\n", "utf8");
    sh(tmp, ["git", "add", "file.txt"]);
    sh(tmp, ["git", "commit", "-m", "init", "-q"]);

    const session = makeLocalPiSshSession({ localRoot, remoteRoot: tmp });
    const connection = session.getConnectionInfo();
    const repoRoot = await session.repoRoot(tmp);
    const scopeKey = makeSshScopeKey(connection, repoRoot);

    const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
    tracker.startTurn({ sessionId: "s1", turnId: "t1", cwd: localRoot, ssh: { session, repoRoot, scopeKey } });

    await tracker.touchPath(path.join(localRoot, "file.txt"), localRoot);
    fs.writeFileSync(filePath, "hello world\n", "utf8");
    await tracker.finalize(localRoot);

    const candidates = resolveTurnLatestCandidates({
      repoRoot,
      scopeKey,
      allowRepoRoot: false,
      sessionId: "s1",
    });
    const found = firstExistingCandidate(candidates);
    assert.ok(found, `expected at least one turn artifact to exist; tried: ${candidates.map((c) => c.patchPath).join(", ")}`);

    const patchText = fs.readFileSync(found.patchPath, "utf8");
    assert.ok(patchText.includes("diff --git a/file.txt b/file.txt"));
    assert.ok(patchText.includes("-hello") || patchText.includes("-hello\n"));
    assert.ok(patchText.includes("+hello world"));

    const metadata = JSON.parse(fs.readFileSync(found.jsonPath, "utf8"));
    assert.equal(metadata.session_id, "s1");
    assert.equal(metadata.turn_id, "t1");
    assert.equal(metadata.repo_root, repoRoot);
    assert.ok(Array.isArray(metadata.touched_paths));
    assert.deepEqual(metadata.touched_paths, ["file.txt"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
