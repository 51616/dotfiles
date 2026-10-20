import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildFffNodeResolveScript } from "../lib/remote-runtime.ts";

const extensionRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = join(extensionRoot, "remote", "worker.mjs");

// pi installs `npm:@ff-labs/pi-fff` (a configured package) with its fff-node dependency here. This test must
// fail, not skip, when that copy is missing or unresolvable: a hardcoded path plus `skip` hid the fff-node 0.11
// layout change for months. The entry is resolved by the same script the remote probe runs.
const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const localFffPackageRoot = join(agentDir, "npm/node_modules/@ff-labs/fff-node");

function resolveFffNodeEntry(packageRoot) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", buildFffNodeResolveScript()], {
    env: { ...process.env, PI_REMOTE_FFF_PACKAGE_ROOT: packageRoot },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, entry: result.stdout.match(/^nodeEntry=(.+)$/m)?.[1] };
}

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

test("fff-node resolve script rejects versions older than the supported minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-fff-old-node-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@ff-labs/fff-node", version: "0.8.1", main: "dist/src/index.js" }));
    const result = resolveFffNodeEntry(dir);
    assert.equal(result.status, 65);
    assert.match(result.stderr, /0\.8\.1 .* too old; need >= 0\.11\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote worker script runs FFF find and paginated grep over stdio", async () => {
  assert.ok(existsSync(join(localFffPackageRoot, "package.json")), `@ff-labs/fff-node missing at ${localFffPackageRoot}`);
  const resolved = resolveFffNodeEntry(localFffPackageRoot);
  assert.equal(resolved.status, 0, resolved.stderr);
  const localFffNodeEntry = resolved.entry;
  assert.ok(localFffNodeEntry, "resolve script printed no nodeEntry");

  const dir = mkdtempSync(join(tmpdir(), "remote-fff-worker-local-"));
  const base = join(dir, "repo");
  const cacheDir = join(dir, "cache");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
  writeFileSync(join(base, "README.md"), "alpha docs\n");
  // More matching files than one grep page (fff-node default pageSize 50) to force a nextCursor.
  mkdirSync(join(base, "many"), { recursive: true });
  for (let i = 0; i < 80; i += 1) writeFileSync(join(base, "many", `f${i}.txt`), "needle\n");

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

    const grepParams = { basePath: base, query: "needle", mode: "plain", smartCase: true, maxMatchesPerFile: 5, scanTimeoutMs: 5000 };
    const first = await request(child, "grep", grepParams);
    assert.ok(first.nextCursor && typeof first.nextCursor === "object", "first grep page should return a nextCursor");
    // The cursor must survive a JSON round trip, because cursor tokens carry it between tool calls.
    const second = await request(child, "grep", { ...grepParams, cursor: JSON.parse(JSON.stringify(first.nextCursor)) });
    const seen = [...first.items, ...second.items].map((item) => item.relativePath);
    assert.equal(new Set(seen).size, seen.length, "pages must not repeat files");
    assert.equal(first.items.length + second.items.length, 80);
  } finally {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});
