import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { RemoteFffWorkerClient } from "../lib/worker-client.ts";

function makeFakeWorker(script) {
  const dir = mkdtempSync(join(tmpdir(), "remote-fff-worker-test-"));
  const path = join(dir, "fake-worker.mjs");
  writeFileSync(path, script);
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeClient(workerPath, requestTimeoutMs = 1000) {
  return new RemoteFffWorkerClient({
    remote: "fake",
    port: 22,
    remoteCwd: "/remote/worktree",
    nodePath: process.execPath,
    nodeEntry: "/unused/fff-node.js",
    workerPath,
    cacheDir: "/tmp/remote-fff-cache",
    idleTtlMs: 10000,
    requestTimeoutMs,
    launcher: {
      launch() {
        return spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
      },
    },
  });
}

test("RemoteFffWorkerClient reuses one worker process for multiple requests", async () => {
  const worker = makeFakeWorker(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { pid: process.pid, method: req.method, params: req.params } }) + "\\n");
});
`);
  const client = makeClient(worker.path);
  try {
    const first = await client.request("one", { value: 1 });
    const second = await client.request("two", { value: 2 });
    assert.equal(first.pid, second.pid);
    assert.equal(first.method, "one");
    assert.deepEqual(second.params, { value: 2 });
  } finally {
    client.dispose();
    worker.cleanup();
  }
});

test("RemoteFffWorkerClient rejects pending requests when worker emits invalid JSON", async () => {
  const worker = makeFakeWorker(`
process.stdin.on("data", () => process.stdout.write("not-json\\n"));
`);
  const client = makeClient(worker.path);
  try {
    await assert.rejects(client.request("broken", {}), /invalid JSON/);
  } finally {
    client.dispose();
    worker.cleanup();
  }
});

test("RemoteFffWorkerClient kills the worker and rejects on abort", async () => {
  const worker = makeFakeWorker(`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", () => {});
`);
  const client = makeClient(worker.path, 5000);
  const controller = new AbortController();
  const pending = client.request("hang", {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(client.isRunning, false);
  worker.cleanup();
});
