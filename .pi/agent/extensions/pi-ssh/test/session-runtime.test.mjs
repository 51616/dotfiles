import test from "node:test";
import assert from "node:assert/strict";

import {
  __publishActivePiSshSessionForTests,
  __resetPiSshSessionForTests,
  clearPublishedPiSshSession,
  createPiSshSession,
  getActivePiSshSession,
} from "../lib/pi-ssh-session-runtime.ts";

function makeConnection() {
  return {
    remote: "user@example.com",
    port: 2222,
    remoteCwd: "/remote/worktree",
    remoteHome: "/remote/home",
    localCwd: "/local/worktree",
    localHome: "/local/home",
  };
}

function makeTransport() {
  return {
    exec: async () => ({ exitCode: 0 }),
    readFile: async () => Buffer.alloc(0),
    ensureReadable: async () => {},
    ensureReadableWritable: async () => {},
    detectImageMimeType: async () => null,
    mkdir: async () => {},
    writeFile: async () => {},
  };
}

function makeSession(execCapture) {
  return createPiSshSession({
    connection: makeConnection(),
    transport: makeTransport(),
    execCapture,
  });
}

test("active pi-ssh session singleton keeps only the last published session", () => {
  __resetPiSshSessionForTests();
  const one = makeSession(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  }));
  const two = makeSession(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  }));

  __publishActivePiSshSessionForTests(one);
  assert.equal(getActivePiSshSession(), one);

  __publishActivePiSshSessionForTests(two);
  assert.equal(getActivePiSshSession(), two);

  clearPublishedPiSshSession();
  assert.equal(getActivePiSshSession(), null);
});

test("PiSshSession maps local cwd and home paths onto the remote workspace", () => {
  __resetPiSshSessionForTests();
  const session = makeSession(async () => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  }));

  assert.equal(session.mapLocalPathToRemote("/local/worktree"), "/remote/worktree");
  assert.equal(session.mapLocalPathToRemote("/local/worktree/src/app.ts"), "/remote/worktree/src/app.ts");
  assert.equal(session.mapLocalPathToRemote("/local/home/.config/pi/config.json"), "/remote/home/.config/pi/config.json");
  assert.equal(session.mapLocalPathToRemote("/already/remote/path.txt"), "/already/remote/path.txt");
});

test("PiSshSession execCapture preserves exact stdout/stderr/exit details and repoRoot uses one-shot probes", async () => {
  __resetPiSshSessionForTests();
  const calls = [];
  const session = makeSession(async (command, options = {}) => {
    calls.push({ command, options });
    if (command.includes("git --no-optional-locks rev-parse --show-toplevel")) {
      return {
        stdout: Buffer.from("/remote/repo\n", "utf-8"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    return {
      stdout: Buffer.from("stdout-bytes", "utf-8"),
      stderr: Buffer.from("stderr-bytes", "utf-8"),
      exitCode: 7,
      timedOut: false,
      aborted: false,
    };
  });

  const capture = await session.execCapture("printf test", { timeoutSeconds: 3 });
  assert.equal(capture.stdout.toString("utf-8"), "stdout-bytes");
  assert.equal(capture.stderr.toString("utf-8"), "stderr-bytes");
  assert.equal(capture.exitCode, 7);
  assert.equal(calls[0].options.timeoutSeconds, 3);

  const repoRoot = await session.repoRoot("/remote/repo/subdir");
  assert.equal(repoRoot, "/remote/repo");
  assert.match(calls[1].command, /git --no-optional-locks rev-parse --show-toplevel/);
  assert.match(calls[1].command, /\/remote\/repo\/subdir/);
  assert.equal(calls[1].options.timeoutSeconds, 15);
});

test("PiSshSession exists/stat helpers distinguish present and missing remote paths", async () => {
  __resetPiSshSessionForTests();
  const calls = [];
  const session = makeSession(async (command, options = {}) => {
    calls.push({ command, options });
    if (command.startsWith("test -e")) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: command.includes("missing.txt") ? 1 : 0,
        timedOut: false,
        aborted: false,
      };
    }

    const payload = command.includes("missing.txt")
      ? { exists: false, kind: null, mtimeMs: null, size: null }
      : { exists: true, kind: "file", mtimeMs: 1710000000123, size: 42 };
    return {
      stdout: Buffer.from(JSON.stringify(payload), "utf-8"),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    };
  });

  assert.equal(await session.exists("/remote/worktree/out.txt"), true);
  assert.equal(await session.exists("/remote/worktree/missing.txt"), false);
  assert.deepEqual(await session.stat("/remote/worktree/out.txt"), {
    exists: true,
    kind: "file",
    mtimeMs: 1710000000123,
    size: 42,
  });
  assert.deepEqual(await session.stat("/remote/worktree/missing.txt"), {
    exists: false,
    kind: null,
    mtimeMs: null,
    size: null,
  });
  assert.equal(calls.filter(({ command }) => command.startsWith("test -e")).length, 2);
  assert.equal(calls.filter(({ command }) => command.includes("pi-ssh session stat requires python3 or python on the remote host")).length, 2);
});
