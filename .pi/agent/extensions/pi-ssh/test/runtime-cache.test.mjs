import test from "node:test";
import assert from "node:assert/strict";

import {
  __publishActivePiSshSessionForTests,
  __resetPiSshSessionForTests,
  createPiSshSession,
  getActivePiSshSession,
} from "../lib/pi-ssh-session-runtime.ts";
import {
  __getReusablePiSshRuntimeForTests,
  __resetReusablePiSshRuntimeForTests,
  buildReusablePiSshRuntimeKey,
  shouldKeepReusablePiSshRuntime,
  storeReusablePiSshRuntime,
  takeReusablePiSshRuntime,
} from "../lib/pi-ssh-runtime-cache.ts";

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

function makeTransport(disposeCalls) {
  return {
    async dispose() {
      disposeCalls.push("dispose");
    },
    exec: async () => ({ exitCode: 0 }),
    execText: async () => ({ exitCode: 0, output: "" }),
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
  };
}

function makeSession(connection, transport) {
  return createPiSshSession({
    connection,
    transport,
    execCapture: async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      timedOut: false,
      aborted: false,
    }),
  });
}

test("reusable SSH runtime keys normalize flag whitespace and preserve target identity", () => {
  const one = buildReusablePiSshRuntimeKey({
    sshFlag: " user@example.com:/remote/worktree ",
    port: 2222,
    localCwd: "/local/worktree",
    localHome: "/local/home",
  });
  const two = buildReusablePiSshRuntimeKey({
    sshFlag: "user@example.com:/remote/worktree",
    port: 2222,
    localCwd: "/local/worktree",
    localHome: "/local/home",
  });
  const otherPort = buildReusablePiSshRuntimeKey({
    sshFlag: "user@example.com:/remote/worktree",
    port: 22,
    localCwd: "/local/worktree",
    localHome: "/local/home",
  });

  assert.equal(one, two);
  assert.notEqual(one, otherPort);
});

test("pi-ssh keeps reusable runtimes only for session replacement reasons", () => {
  assert.equal(shouldKeepReusablePiSshRuntime("new"), true);
  assert.equal(shouldKeepReusablePiSshRuntime("resume"), true);
  assert.equal(shouldKeepReusablePiSshRuntime("fork"), true);
  assert.equal(shouldKeepReusablePiSshRuntime("reload"), false);
  assert.equal(shouldKeepReusablePiSshRuntime("quit"), false);
  assert.equal(shouldKeepReusablePiSshRuntime("startup"), false);
});

test("reusable SSH runtime can be stashed and claimed without disposing the transport", async () => {
  await __resetReusablePiSshRuntimeForTests();
  __resetPiSshSessionForTests();
  const disposeCalls = [];
  const connection = makeConnection();
  const transport = makeTransport(disposeCalls);
  const session = makeSession(connection, transport);
  const cacheKey = buildReusablePiSshRuntimeKey({
    sshFlag: "user@example.com:/remote/worktree",
    port: 2222,
    localCwd: "/local/worktree",
    localHome: "/local/home",
  });

  await storeReusablePiSshRuntime({
    cacheKey,
    connection,
    transport,
    session,
    remotePromptContext: { file: null },
  });

  const claimed = takeReusablePiSshRuntime(cacheKey);

  assert.equal(claimed?.session, session);
  assert.equal(__getReusablePiSshRuntimeForTests(), null);
  assert.deepEqual(disposeCalls, []);
});

test("clearing a stashed SSH runtime disposes it and unpublishes the matching active session", async () => {
  await __resetReusablePiSshRuntimeForTests();
  __resetPiSshSessionForTests();
  const disposeCalls = [];
  const connection = makeConnection();
  const transport = makeTransport(disposeCalls);
  const session = makeSession(connection, transport);
  const cacheKey = buildReusablePiSshRuntimeKey({
    sshFlag: "user@example.com:/remote/worktree",
    port: 2222,
    localCwd: "/local/worktree",
    localHome: "/local/home",
  });

  __publishActivePiSshSessionForTests(session);
  await storeReusablePiSshRuntime({
    cacheKey,
    connection,
    transport,
    session,
    remotePromptContext: { file: null },
  });
  await __resetReusablePiSshRuntimeForTests();

  assert.deepEqual(disposeCalls, ["dispose"]);
  assert.equal(getActivePiSshSession(), null);
});
