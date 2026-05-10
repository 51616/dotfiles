import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveGoalAuditTarget } from "../goal/lib/goal-audit-target.ts";
import { __publishActivePiSshSessionForTests } from "../pi-ssh/lib/pi-ssh-session-runtime.ts";

afterEach(() => {
  __publishActivePiSshSessionForTests(null);
});

function createCtx(sessionFile) {
  return {
    cwd: "/local/worktree",
    signal: undefined,
    sessionManager: {
      getCwd: () => "/local/worktree/subdir",
      getSessionId: () => "session:abc/123",
      getSessionFile: () => sessionFile,
    },
  };
}

function createSshSession({ writes, commands, existingPaths }) {
  const connection = {
    kind: "ssh",
    remote: "gpu-box",
    port: 2222,
    remoteCwd: "/remote/worktree",
  };
  return {
    getConnectionInfo: () => connection,
    getRemoteContext: () => ({
      remoteHome: "/home/tan",
      transport: {
        async readFile() {
          throw new Error("not needed");
        },
        async writeFile(path, content) {
          writes.push({ path, content: Buffer.from(content).toString("utf-8") });
        },
      },
    }),
    createReadOps: () => { throw new Error("not needed"); },
    createWriteOps: () => { throw new Error("not needed"); },
    createEditOps: () => { throw new Error("not needed"); },
    createBashOps: () => { throw new Error("not needed"); },
    mapLocalPathToRemote(localPath) {
      if (localPath === "/local/worktree") return "/remote/worktree";
      if (localPath.startsWith("/local/worktree/")) return `/remote/worktree${localPath.slice("/local/worktree".length)}`;
      return localPath;
    },
    async execCapture(command) {
      commands.push(command);
      return { stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0, timedOut: false, aborted: false };
    },
    async execText(command) {
      commands.push(command);
      return { output: "", exitCode: 0, timedOut: false, aborted: false };
    },
    async exists(remotePath) {
      return existingPaths.has(remotePath);
    },
    async stat() {
      throw new Error("not needed");
    },
    async repoRoot() {
      return "/remote/worktree";
    },
  };
}

test("resolveGoalAuditTarget syncs the current session file and returns the matching pi-ssh target", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "goal-audit-target-"));
  try {
    const sessionFile = join(tmp, "session.jsonl");
    writeFileSync(sessionFile, '{"type":"message","message":{"role":"user","content":"work"}}\n');
    const writes = [];
    const commands = [];
    const existingPaths = new Set(["/tmp/pi-work/checkpoints", "/remote/worktree/subdir/conductor/tracks"]);
    __publishActivePiSshSessionForTests(createSshSession({ writes, commands, existingPaths }));

    const target = await resolveGoalAuditTarget(createCtx(sessionFile));

    assert.deepEqual(target.ssh, { remote: "gpu-box", port: 2222, remoteCwd: "/remote/worktree/subdir" });
    assert.equal(target.promptCwd, "/remote/worktree/subdir");
    assert.equal(target.promptCheckpointDir, "/tmp/pi-work/checkpoints");
    assert.equal(target.promptConductorDir, "/remote/worktree/subdir/conductor/tracks");
    assert.equal(target.promptSessionFile, "/home/tan/.cache/pi/goal/session-snapshots/session-abc-123.jsonl");
    assert.deepEqual(writes, [
      {
        path: "/home/tan/.cache/pi/goal/session-snapshots/session-abc-123.jsonl",
        content: '{"type":"message","message":{"role":"user","content":"work"}}\n',
      },
    ]);
    assert.match(commands[0], /mkdir -p --/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveGoalAuditTarget falls back to the connection remote cwd when local cwd cannot be mapped", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "goal-audit-target-unmapped-"));
  try {
    const sessionFile = join(tmp, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const writes = [];
    const commands = [];
    __publishActivePiSshSessionForTests(createSshSession({ writes, commands, existingPaths: new Set() }));

    const target = await resolveGoalAuditTarget({
      ...createCtx(sessionFile),
      cwd: "/outside/local",
      sessionManager: {
        getCwd: () => "/outside/local",
        getSessionId: () => "session-outside",
        getSessionFile: () => sessionFile,
      },
    });

    assert.deepEqual(target.ssh, { remote: "gpu-box", port: 2222, remoteCwd: "/remote/worktree" });
    assert.equal(target.promptCwd, "/remote/worktree");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
