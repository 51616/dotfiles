import test from "node:test";
import assert from "node:assert/strict";

import { __testInternals } from "../index.ts";

const { SshTransport, sshCapture, createRemoteReadOps, createRemoteWriteOps, createRemoteEditOps } = __testInternals;

function makeConnection() {
  return {
    remote: "fake@host",
    port: 22,
    remoteCwd: "/remote/worktree",
    remoteHome: "/remote",
    localCwd: "/local/worktree",
    localHome: "/local",
  };
}

test("remote read/write/edit ops forward the tool abort signal to transport calls", async () => {
  const controller = new AbortController();
  controller.abort();

  const seenSignals = [];
  const transport = {
    dispose: async () => {},
    exec: async () => ({ exitCode: 0 }),
    readFile: async (_path, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-read");
      return Buffer.from("");
    },
    ensureReadable: async (_path, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-access");
    },
    ensureReadableWritable: async (_path, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-edit-access");
    },
    detectImageMimeType: async (_path, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-image");
      return null;
    },
    mkdir: async (_path, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-mkdir");
    },
    writeFile: async (_path, _content, signal) => {
      seenSignals.push(signal);
      if (signal?.aborted) throw new Error("aborted-write");
    },
  };

  const conn = makeConnection();
  const readOps = createRemoteReadOps(conn, transport, controller.signal);
  const writeOps = createRemoteWriteOps(conn, transport, controller.signal);
  const editOps = createRemoteEditOps(conn, transport, controller.signal);

  await assert.rejects(readOps.readFile("/local/worktree/file.txt"), /aborted-read/);
  await assert.rejects(readOps.access("/local/worktree/file.txt"), /aborted-access/);
  assert.equal(await readOps.detectImageMimeType("/local/worktree/file.txt"), null);
  await assert.rejects(writeOps.mkdir("/local/worktree/out"), /aborted-mkdir/);
  await assert.rejects(writeOps.writeFile("/local/worktree/file.txt", "hello"), /aborted-write/);
  await assert.rejects(editOps.access("/local/worktree/file.txt"), /aborted-edit-access/);

  assert.ok(seenSignals.length >= 6);
  for (const signal of seenSignals) {
    assert.equal(signal, controller.signal);
  }
});

test("SshTransport writeFile does not fall back to one-shot SSH after an aborted persistent write", async () => {
  const controller = new AbortController();
  controller.abort();

  let fallbackCalls = 0;
  const transport = new SshTransport(makeConnection(), {
    shell: {
      dispose: async () => {},
      exec: async () => {
        throw new Error("aborted");
      },
    },
    sshExecFn: async () => {
      fallbackCalls += 1;
      return Buffer.alloc(0);
    },
  });

  await assert.rejects(transport.writeFile("/remote/worktree/out.txt", Buffer.from("hello"), controller.signal), /aborted/);
  assert.equal(fallbackCalls, 0);
});

test("SshTransport writeFile does not fall back to one-shot SSH after a timed-out persistent write", async () => {
  let fallbackCalls = 0;
  const transport = new SshTransport(makeConnection(), {
    shell: {
      dispose: async () => {},
      exec: async () => {
        throw new Error("timeout:3");
      },
    },
    sshExecFn: async () => {
      fallbackCalls += 1;
      return Buffer.alloc(0);
    },
  });

  await assert.rejects(transport.writeFile("/remote/worktree/out.txt", Buffer.from("hello")), /timeout:3/);
  assert.equal(fallbackCalls, 0);
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
