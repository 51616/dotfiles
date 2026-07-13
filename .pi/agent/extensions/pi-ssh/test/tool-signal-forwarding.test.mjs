import test from "node:test";
import assert from "node:assert/strict";

import { __testInternals } from "../index.ts";
import { createPiSshSession } from "../lib/pi-ssh-session-runtime.ts";

// @lat: [[tests#Remote-native workspace file operations]]

const { SshTransport, buildRemoteFileWorkerCommand, sshCapture } = __testInternals;

function makeConnection() {
  return {
    remote: "fake@host",
    remoteDisplayTarget: "fake@host",
    port: 22,
    remoteCwd: "/remote/worktree",
    remoteHome: "/remote",
    localCwd: "/local/worktree",
    localHome: "/local",
  };
}

function makeFileTransport(overrides = {}) {
  return {
    dispose: async () => {},
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    readWorkspaceFile: async () => ({
      kind: "text",
      content: "",
      sourceBytes: 0,
      totalFileLines: 1,
      startLineDisplay: 1,
      userLimitedLines: null,
      hasMoreAfterUserLimit: false,
      firstLineBytes: 0,
      truncation: {
        content: "",
        truncated: false,
        truncatedBy: null,
        totalLines: 1,
        totalBytes: 0,
        outputLines: 1,
        outputBytes: 0,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2_000,
        maxBytes: 50 * 1024,
      },
    }),
    editWorkspaceFile: async () => ({
      diff: "",
      diffTruncated: false,
      sourceBytes: 0,
      writtenBytes: 0,
    }),
    ...overrides,
  };
}

test("PiSshSession maps workspace paths and forwards abort signals to high-level file operations", async () => {
  const controller = new AbortController();
  const calls = [];
  const transport = {
    exec: async () => ({ exitCode: 0 }),
    ...makeFileTransport({
      readWorkspaceFile: async (path, options, signal) => {
        calls.push({ operation: "read", path, options, signal });
        return makeFileTransport().readWorkspaceFile();
      },
      writeFile: async (path, content, signal) => {
        calls.push({ operation: "write", path, content, signal });
      },
      editWorkspaceFile: async (path, displayPath, edits, signal) => {
        calls.push({ operation: "edit", path, displayPath, edits, signal });
        return makeFileTransport().editWorkspaceFile();
      },
    }),
  };
  const session = createPiSshSession({
    connection: makeConnection(),
    transport,
    execCapture: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    }),
  });

  await session.readWorkspaceFile(
    "/local/worktree/file.txt",
    { offset: 2, limit: 3, maxLines: 2_000, maxBytes: 50 * 1024 },
    controller.signal,
  );
  await session.writeWorkspaceFile("/local/worktree/file.txt", Buffer.from("hello"), controller.signal);
  await session.editWorkspaceFile(
    "/local/worktree/file.txt",
    "file.txt",
    [{ oldText: "hello", newText: "world" }],
    controller.signal,
  );

  assert.deepEqual(calls.map(({ operation, path }) => ({ operation, path })), [
    { operation: "read", path: "/remote/worktree/file.txt" },
    { operation: "write", path: "/remote/worktree/file.txt" },
    { operation: "edit", path: "/remote/worktree/file.txt" },
  ]);
  assert.ok(calls.every(({ signal }) => signal === controller.signal));
});

test("SshTransport file operations do not wait behind the bash command queue", async () => {
  let releaseBash;
  const bashBlocked = new Promise((resolve) => {
    releaseBash = resolve;
  });
  const transport = new SshTransport(makeConnection(), {
    shell: {
      dispose: async () => {},
      exec: async () => {
        await bashBlocked;
        return { exitCode: 0 };
      },
    },
    fileTransport: makeFileTransport({
      readFile: async () => Buffer.from("file-result"),
    }),
  });

  const bash = transport.exec("sleep 10", "/local/worktree", { onData: () => {} });
  const file = await Promise.race([
    transport.readFile("/remote/worktree/file.txt"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("file operation blocked behind bash")), 100)),
  ]);
  assert.equal(file.toString("utf8"), "file-result");

  releaseBash();
  await bash;
  await transport.dispose();
});

test("remote file worker launcher requires Python 3.9+ before evaluating worker source", () => {
  const command = buildRemoteFileWorkerCommand();
  assert.match(command, /sys\.version_info >= \(3, 9\)/);
  assert.match(command, /requires Python 3\.9 or newer/);
  assert.ok(command.indexOf("sys.version_info") < command.indexOf("base64 -d"));
});

test("sshCapture short-circuits already-aborted signals without spawning ssh", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await sshCapture("fake@host", 22, "pwd", { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
});
