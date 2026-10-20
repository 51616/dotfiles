import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

export interface RemoteFffRuntime {
  remote: string;
  port: number;
  remoteCwd: string;
  remoteHome: string;
  nodePath: string;
  nodeEntry: string;
  workerPath: string;
  cacheDir: string;
}

// v2: worker passes fff-node's grep cursor through opaquely (fff-node >= 0.11 has no public cursor constructor).
const REMOTE_WORKER_VERSION = "v2";

/** Oldest supported `@ff-labs/fff-node`. 0.11.0 moved the entry to `dist/index.js` and dropped `dist/types.js`. */
export const MIN_FFF_NODE_VERSION = "0.11.0";

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseKeyValueLines(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function getBundledWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "remote", "worker.mjs");
}

/**
 * Node ESM script that validates an installed `@ff-labs/fff-node` package and prints `nodeEntry=<abs path>`.
 * Input: env `PI_REMOTE_FFF_PACKAGE_ROOT`. The entry comes from the package's own `exports` map instead of a
 * hardcoded `dist/...` path, because fff-node 0.11 silently moved its entry and broke the old hardcoded path.
 */
export function buildFffNodeResolveScript(): string {
  return `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.PI_REMOTE_FFF_PACKAGE_ROOT;
if (!root) throw new Error("missing PI_REMOTE_FFF_PACKAGE_ROOT");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const parse = (v) => String(v).split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
const [have, min] = [parse(pkg.version), parse(${JSON.stringify(MIN_FFF_NODE_VERSION)})];
const cmp = have.map((n, i) => n - min[i]).find((d) => d !== 0) ?? 0;
if (have.some(Number.isNaN) || cmp < 0) {
  console.error("@ff-labs/fff-node " + pkg.version + " at " + root + " is too old; need >= ${MIN_FFF_NODE_VERSION}. Run: npm install -g @ff-labs/fff-node@latest");
  process.exit(65);
}
const exp = pkg.exports && pkg.exports["."];
const rel = (exp && (exp.import || exp.default)) || pkg.module;
if (typeof rel !== "string") {
  console.error("@ff-labs/fff-node " + pkg.version + " has no ESM entry in package.json exports");
  process.exit(65);
}
const entry = join(root, rel);
const mod = await import(pathToFileURL(entry).href);
mod.FileFinder.ensureLoaded();
console.log("nodeEntry=" + entry);
`;
}

function buildRuntimeProbeCommand(): string {
  return [
    "set -eu",
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    'node_path=$(command -v node || true)',
    'if [ -z "$node_path" ]; then echo "node was not found after loading nvm" >&2; exit 127; fi',
    'npm_root=$(npm root -g 2>/dev/null || true)',
    'if [ -z "$npm_root" ]; then echo "npm root -g returned no path" >&2; exit 127; fi',
    'package_root="$npm_root/@ff-labs/fff-node"',
    'if [ ! -r "$package_root/package.json" ]; then echo "@ff-labs/fff-node is not installed at $package_root. Run: npm install -g @ff-labs/fff-node@latest" >&2; exit 127; fi',
    `PI_REMOTE_FFF_PACKAGE_ROOT="$package_root" "$node_path" --input-type=module -e ${shellQuote(buildFffNodeResolveScript())}`,
    'printf "nodePath=%s\\n" "$node_path"',
  ].join("\n");
}

export async function resolveRemoteFffRuntime(session: PiSshSession, signal?: AbortSignal): Promise<RemoteFffRuntime> {
  const connection = session.getConnectionInfo();
  const remoteContext = session.getRemoteContext(signal);
  const remoteHome = remoteContext.remoteHome;
  const remoteRoot = `${remoteHome}/.cache/pi/remote-fff-forward`;
  const workerDir = `${remoteRoot}/${REMOTE_WORKER_VERSION}`;
  const workerPath = `${workerDir}/worker.mjs`;
  const cacheDir = `${remoteRoot}/data`;

  const probe = await session.execCapture(buildRuntimeProbeCommand(), { signal, timeoutSeconds: 20 });
  if (probe.aborted) throw new Error("aborted");
  if (probe.timedOut) throw new Error("Remote FFF runtime probe timed out");
  if (probe.exitCode !== 0) {
    const stderr = probe.stderr.toString("utf-8").trim();
    const stdout = probe.stdout.toString("utf-8").trim();
    throw new Error(stderr || stdout || `Remote FFF runtime probe failed with exit code ${probe.exitCode}`);
  }

  const parsed = parseKeyValueLines(probe.stdout.toString("utf-8"));
  const nodePath = parsed.get("nodePath");
  const nodeEntry = parsed.get("nodeEntry");
  if (!nodePath || !nodeEntry) {
    throw new Error("Remote FFF runtime probe did not return nodePath and nodeEntry");
  }

  const mkdir = await session.execCapture(`mkdir -p ${shellQuote(workerDir)} ${shellQuote(cacheDir)}`, { signal, timeoutSeconds: 10 });
  if (mkdir.aborted) throw new Error("aborted");
  if (mkdir.timedOut) throw new Error("Remote FFF worker directory setup timed out");
  if (mkdir.exitCode !== 0) {
    const stderr = mkdir.stderr.toString("utf-8").trim();
    throw new Error(stderr || `Remote FFF worker directory setup failed with exit code ${mkdir.exitCode}`);
  }

  const workerContent = await readFile(getBundledWorkerPath());
  await remoteContext.transport.writeFile(workerPath, workerContent, signal);

  return {
    remote: connection.remote,
    port: connection.port,
    remoteCwd: connection.remoteCwd,
    remoteHome,
    nodePath,
    nodeEntry,
    workerPath,
    cacheDir,
  };
}
