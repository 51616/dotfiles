#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const nodeEntry = process.env.PI_REMOTE_FFF_NODE_ENTRY;
if (!nodeEntry) {
  console.error("PI_REMOTE_FFF_NODE_ENTRY is required");
  process.exit(2);
}

const cacheDir = process.env.PI_REMOTE_FFF_CACHE_DIR || join(process.env.HOME || ".", ".cache", "pi", "remote-fff-forward");
const idleTtlMs = Number.parseInt(process.env.PI_REMOTE_FFF_IDLE_TTL_MS || "1800000", 10);

const { FileFinder } = await import(pathToFileURL(nodeEntry).href);
const { createGrepCursor } = await import(pathToFileURL(join(dirname(nodeEntry), "types.js")).href);

let finder = null;
let finderBasePath = null;
let idleTimer = null;
let requestQueue = Promise.resolve();

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function resetIdleTimer() {
  if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) return;
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    shutdown(0);
  }, idleTtlMs);
  idleTimer.unref?.();
}

function shutdown(code) {
  clearIdleTimer();
  if (finder && !finder.isDestroyed) {
    finder.destroy();
  }
  finder = null;
  finderBasePath = null;
  process.exit(code);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function pathKey(basePath) {
  return createHash("sha256").update(basePath).digest("hex").slice(0, 16);
}

async function ensureFinder(basePath, scanTimeoutMs) {
  if (finder && !finder.isDestroyed && finderBasePath === basePath) return finder;
  if (finder && !finder.isDestroyed) finder.destroy();

  mkdirSync(cacheDir, { recursive: true });
  const key = pathKey(basePath);
  const created = FileFinder.create({
    basePath,
    frecencyDbPath: join(cacheDir, `${key}.frecency.mdb`),
    historyDbPath: join(cacheDir, `${key}.history.mdb`),
    aiMode: true,
  });
  if (!created.ok) throw new Error(created.error);

  finder = created.value;
  finderBasePath = basePath;
  await finder.waitForScan(scanTimeoutMs ?? 15000);
  return finder;
}

function unwrap(result) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function handleRequest(request) {
  const method = assertString(request.method, "method");
  const params = assertObject(request.params ?? {}, "params");

  if (method === "health") {
    const basePath = typeof params.basePath === "string" && params.basePath.length > 0 ? params.basePath : null;
    if (basePath) await ensureFinder(basePath, optionalNumber(params.scanTimeoutMs, "scanTimeoutMs"));
    const health = finder && !finder.isDestroyed ? finder.healthCheck(basePath ?? undefined) : FileFinder.healthCheckStatic(basePath ?? undefined);
    return {
      pid: process.pid,
      basePath: finderBasePath,
      cacheDir,
      health: unwrap(health),
    };
  }

  if (method === "find") {
    const basePath = assertString(params.basePath, "basePath");
    const query = assertString(params.query, "query");
    const pageIndex = optionalNumber(params.pageIndex, "pageIndex") ?? 0;
    const pageSize = optionalNumber(params.pageSize, "pageSize") ?? 30;
    const f = await ensureFinder(basePath, optionalNumber(params.scanTimeoutMs, "scanTimeoutMs"));
    return unwrap(f.fileSearch(query, { pageIndex, pageSize }));
  }

  if (method === "grep") {
    const basePath = assertString(params.basePath, "basePath");
    const query = assertString(params.query, "query");
    const cursorOffset = optionalNumber(params.cursorOffset, "cursorOffset");
    const f = await ensureFinder(basePath, optionalNumber(params.scanTimeoutMs, "scanTimeoutMs"));
    const value = unwrap(f.grep(query, {
      mode: params.mode === "regex" || params.mode === "fuzzy" ? params.mode : "plain",
      smartCase: params.smartCase !== false,
      maxMatchesPerFile: optionalNumber(params.maxMatchesPerFile, "maxMatchesPerFile") ?? 20,
      cursor: cursorOffset === undefined ? null : createGrepCursor(cursorOffset),
      beforeContext: optionalNumber(params.beforeContext, "beforeContext") ?? 0,
      afterContext: optionalNumber(params.afterContext, "afterContext") ?? 0,
      classifyDefinitions: true,
    }));
    const nextCursor = value.nextCursor;
    return {
      ...value,
      nextCursor: undefined,
      nextCursorOffset: nextCursor && typeof nextCursor._offset === "number" ? nextCursor._offset : null,
    };
  }

  if (method === "rescan") {
    const basePath = typeof params.basePath === "string" && params.basePath.length > 0 ? params.basePath : finderBasePath;
    if (!basePath) throw new Error("basePath is required before rescan");
    const f = await ensureFinder(basePath, optionalNumber(params.scanTimeoutMs, "scanTimeoutMs"));
    unwrap(f.scanFiles());
    return { basePath };
  }

  throw new Error(`Unknown method: ${method}`);
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function processLine(line) {
  clearIdleTimer();
  let request;
  try {
    request = JSON.parse(line);
    const id = assertString(request.id, "id");
    const result = await handleRequest(assertObject(request, "request"));
    writeResponse({ id, ok: true, result });
  } catch (error) {
    const id = request && typeof request.id === "string" ? request.id : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    writeResponse({ id, ok: false, error: message });
  } finally {
    resetIdleTimer();
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  // FileFinder is stateful per base path. Keep requests sequential so a second
  // request cannot destroy the active finder while the first request is scanning.
  requestQueue = requestQueue.then(() => processLine(line), () => processLine(line));
});

rl.on("close", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(130));
process.on("SIGHUP", () => shutdown(0));

resetIdleTimer();
