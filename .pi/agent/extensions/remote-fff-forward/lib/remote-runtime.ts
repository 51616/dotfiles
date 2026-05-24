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

const REMOTE_WORKER_VERSION = "v1";

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

function buildRuntimeProbeCommand(): string {
  const checkScript = [
    "const entry = process.env.PI_REMOTE_FFF_NODE_ENTRY;",
    "if (!entry) throw new Error('missing PI_REMOTE_FFF_NODE_ENTRY');",
    "const mod = await import('file://' + entry);",
    "mod.FileFinder.ensureLoaded();",
  ].join(" ");

  return [
    "set -eu",
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    'node_path=$(command -v node || true)',
    'if [ -z "$node_path" ]; then echo "node was not found after loading nvm" >&2; exit 127; fi',
    'npm_root=$(npm root -g 2>/dev/null || true)',
    'if [ -z "$npm_root" ]; then echo "npm root -g returned no path" >&2; exit 127; fi',
    'node_entry="$npm_root/@ff-labs/fff-node/dist/src/index.js"',
    'if [ ! -r "$node_entry" ]; then echo "@ff-labs/fff-node is not readable at $node_entry" >&2; exit 127; fi',
    `PI_REMOTE_FFF_NODE_ENTRY="$node_entry" "$node_path" --input-type=module -e ${shellQuote(checkScript)}`,
    'printf "nodePath=%s\\n" "$node_path"',
    'printf "nodeEntry=%s\\n" "$node_entry"',
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
