#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createPiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";
import { RemoteFffManager } from "../lib/manager.ts";

const remote = process.env.REMOTE_FFF_SSH_ALIAS || "gcp_slurm_sakana_eu";
const port = Number.parseInt(process.env.REMOTE_FFF_SSH_PORT || "22", 10);
const remoteHome = process.env.REMOTE_FFF_HOME;
const remoteCwd = process.env.REMOTE_FFF_BASE;
const mode = process.argv[2] || "normal";

if (!remoteHome || !remoteCwd) {
  throw new Error("REMOTE_FFF_HOME and REMOTE_FFF_BASE are required");
}

function shellQuote(value) {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sshCapture(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-p", String(port), "-o", "BatchMode=yes", remote, command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let aborted = false;
    const timeout = options.timeoutSeconds
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutSeconds * 1000)
      : null;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, timedOut, aborted });
    });
    if (options.stdin) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

async function execOk(command, stdin) {
  const result = await sshCapture(command, { stdin, timeoutSeconds: 20 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString("utf8") || result.stdout.toString("utf8") || `ssh failed ${result.exitCode}`);
  }
  return result.stdout.toString("utf8");
}

const transport = {
  exec: async () => ({ exitCode: 0 }),
  readFile: async (remotePath) => (await sshCapture(`cat -- ${shellQuote(remotePath)}`, { timeoutSeconds: 20 })).stdout,
  ensureReadable: async () => {},
  ensureReadableWritable: async () => {},
  detectImageMimeType: async () => null,
  mkdir: async (remoteDir) => {
    await execOk(`mkdir -p -- ${shellQuote(remoteDir)}`);
  },
  writeFile: async (remotePath, content) => {
    await execOk(`mkdir -p -- ${shellQuote(dirname(remotePath))} && cat > ${shellQuote(remotePath)}`, content);
  },
};

const session = createPiSshSession({
  connection: {
    remote,
    port,
    remoteCwd,
    remoteHome,
    localCwd: "/tmp/local-remote-fff-live",
    localHome: "/tmp/local-remote-fff-home",
  },
  transport,
  execCapture: sshCapture,
});

const manager = new RemoteFffManager({ idleTtlMs: 5000, requestTimeoutMs: 20000 });
const client = await manager.getClient(session);
const health = await client.request("health", { basePath: remoteCwd, scanTimeoutMs: 5000 });
const find = await client.request("find", { basePath: remoteCwd, query: "alpha", pageIndex: 0, pageSize: 10, scanTimeoutMs: 5000 });
const grep = await client.request("grep", { basePath: remoteCwd, query: "alpha", mode: "plain", smartCase: true, maxMatchesPerFile: 5, scanTimeoutMs: 5000 });
const payload = {
  mode,
  localSshPid: manager.snapshot?.localPid ?? null,
  remoteWorkerPid: health.pid,
  indexedFiles: health.health.filePicker?.indexedFiles ?? null,
  findPaths: find.items.map((item) => item.relativePath),
  grepPaths: grep.items.map((item) => item.relativePath),
};
console.log(JSON.stringify(payload, null, 2));

if (mode === "crash") {
  const pidFile = process.env.REMOTE_FFF_PID_FILE;
  if (!pidFile) throw new Error("REMOTE_FFF_PID_FILE is required in crash mode");
  writeFileSync(pidFile, String(health.pid));
  process.kill(process.pid, "SIGKILL");
}

manager.dispose();
