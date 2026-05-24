import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = join(extensionRoot, "remote", "worker.mjs");
const localFffNodeEntry = "/home/tan/.pi/agent/npm/node_modules/@ff-labs/fff-node/dist/src/index.js";

function onceLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf-8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(stdout.slice(0, newline));
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf-8");
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`worker closed before response: ${stderr.trim()}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("close", onClose);
  });
}

async function request(child, method, params) {
  const id = `${method}-${Date.now()}-${Math.random()}`;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  const line = await onceLine(child);
  const response = JSON.parse(line);
  assert.equal(response.id, id);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

test("remote worker script runs FFF find and grep over stdio", { skip: !existsSync(localFffNodeEntry) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-fff-worker-local-"));
  const base = join(dir, "repo");
  const cacheDir = join(dir, "cache");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(base, "README.md"), "alpha docs\n");

  const child = spawn(process.execPath, [workerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_REMOTE_FFF_NODE_ENTRY: localFffNodeEntry,
      PI_REMOTE_FFF_CACHE_DIR: cacheDir,
      PI_REMOTE_FFF_IDLE_TTL_MS: "10000",
    },
  });

  try {
    const health = await request(child, "health", { basePath: base, scanTimeoutMs: 5000 });
    assert.equal(health.basePath, base);
    assert.equal(health.health.filePicker.initialized, true);

    const found = await request(child, "find", { basePath: base, query: "alpha", pageIndex: 0, pageSize: 10, scanTimeoutMs: 5000 });
    assert.deepEqual(found.items.map((item) => item.relativePath), ["src/alpha.ts"]);

    const grep = await request(child, "grep", { basePath: base, query: "alpha", mode: "plain", smartCase: true, maxMatchesPerFile: 5, scanTimeoutMs: 5000 });
    assert.ok(grep.items.some((item) => item.relativePath === "README.md"));
    assert.ok(grep.items.some((item) => item.relativePath === "src/alpha.ts"));
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
