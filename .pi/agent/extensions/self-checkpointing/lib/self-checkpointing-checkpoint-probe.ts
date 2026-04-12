import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isLikelyCheckpointPath } from "../../lib/autockpt/autockpt-footer-guards.ts";

export type CheckpointProbe = {
  isFreshCheckpointFile: (checkpointPath: string, maxCheckpointAgeMs: number) => boolean;
  inferLatestCheckpointPath: (maxCheckpointAgeMs: number) => string | null;
};

type FlagReader = Partial<Pick<ExtensionAPI, "getFlag">>;

type SshCheckpointConfig = {
  remote: string;
  remotePath?: string;
  port: number;
};

type SshExecRequest = {
  remote: string;
  port: number;
  remoteCommand: string;
  timeoutMs: number;
};

type SshExecResult = {
  stdout: string;
  status: number | null;
};

type CreateCheckpointProbeOptions = {
  sshExec?: (request: SshExecRequest) => SshExecResult;
  sshProbeTimeoutMs?: number;
};

type RemoteValidateResult = {
  exists?: boolean;
  fresh?: boolean;
};

type RemoteLatestResult = {
  latestPath?: string | null;
};

const REMOTE_PROBE_BEGIN_MARKER = "__PI_SELF_CHECKPOINT_PROBE_BEGIN__";
const REMOTE_PROBE_END_MARKER = "__PI_SELF_CHECKPOINT_PROBE_END__";
const DEFAULT_SSH_PROBE_TIMEOUT_MS = 8_000;
const MAX_SSH_STDOUT_BYTES = 64 * 1024;

const REMOTE_PROBE_SCRIPT = String.raw`import json, os, sys, time
mode = sys.argv[1]
max_age_ms = int(sys.argv[2])
now_ms = int(time.time() * 1000)
result = {}
if mode == "validate":
    checkpoint_path = sys.argv[3] if len(sys.argv) > 3 else ""
    exists = os.path.exists(checkpoint_path)
    result = {"exists": exists, "fresh": False}
    if exists:
        mtime_ms = int(os.path.getmtime(checkpoint_path) * 1000)
        result["mtimeMs"] = mtime_ms
        result["fresh"] = True if max_age_ms <= 0 else (now_ms - mtime_ms) <= max_age_ms
elif mode == "latest":
    dir_path = os.path.join(os.getcwd(), "work", "log", "checkpoints")
    latest_path = None
    latest_mtime = None
    if os.path.isdir(dir_path):
        for name in os.listdir(dir_path):
            if not name.endswith(".md"):
                continue
            candidate = os.path.join(dir_path, name)
            if not os.path.isfile(candidate):
                continue
            try:
                mtime_ms = int(os.path.getmtime(candidate) * 1000)
            except OSError:
                continue
            if max_age_ms > 0 and (now_ms - mtime_ms) > max_age_ms:
                continue
            if latest_mtime is None or mtime_ms > latest_mtime:
                latest_mtime = mtime_ms
                latest_path = os.path.join("work", "log", "checkpoints", name)
    result = {"latestPath": latest_path, "mtimeMs": latest_mtime}
else:
    result = {"error": "unknown_mode", "mode": mode}
print(json.dumps(result, separators=(",", ":")))`;

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function findRemotePathSeparator(value: string): number {
  const schemeIndex = value.indexOf("://");
  const searchStart = schemeIndex === -1 ? 0 : schemeIndex + 3;
  const colonIndex = value.indexOf(":", searchStart);
  if (colonIndex === -1) {
    return -1;
  }

  if (value.indexOf(":") === colonIndex) {
    return colonIndex;
  }

  return -1;
}

export function parseSshFlag(raw: string): SshCheckpointConfig {
  const value = raw.trim();
  if (!value) {
    throw new Error("--ssh requires a value like user@host or user@host:/remote/path");
  }

  const colonIndex = findRemotePathSeparator(value);
  if (colonIndex === -1) {
    return { remote: value, port: 22 };
  }

  const remote = value.slice(0, colonIndex).trim();
  const remotePath = value.slice(colonIndex + 1).trim();
  if (!remote) {
    throw new Error("Invalid --ssh value: missing remote host");
  }
  if (!remotePath) {
    throw new Error("Invalid --ssh value: empty remote path");
  }
  return { remote, remotePath, port: 22 };
}

export function parseSshPort(raw: string | undefined): number {
  const value = (raw ?? "22").trim();
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid SSH port: ${value}`);
  }
  return parsed;
}

export function resolveSshCheckpointConfig(flags: FlagReader): SshCheckpointConfig | null {
  const getFlag = typeof flags.getFlag === "function" ? flags.getFlag.bind(flags) : () => undefined;
  const sshRaw = getFlag("ssh");
  const ssh = typeof sshRaw === "string" ? sshRaw.trim() : "";
  if (!ssh) {
    return null;
  }

  const portRaw = getFlag("p") ?? getFlag("ssh-port");
  const port = parseSshPort(typeof portRaw === "string" ? portRaw : undefined);
  const parsed = parseSshFlag(ssh);
  return {
    remote: parsed.remote,
    remotePath: parsed.remotePath,
    port,
  };
}

function buildRemoteWorkspacePrefix(remotePath?: string): string {
  if (!remotePath) {
    return "";
  }
  if (remotePath === "~") {
    return 'cd -- "$HOME"';
  }
  if (remotePath.startsWith("~/")) {
    return `cd -- "$HOME"/${shellQuote(remotePath.slice(2))}`;
  }
  return `cd -- ${shellQuote(remotePath)}`;
}

function buildSshArgs(port: number): string[] {
  return [
    "-p",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    "-o",
    "ControlPath=/tmp/pi-ssh-%C",
  ];
}

function defaultSshExec(request: SshExecRequest): SshExecResult {
  const result = spawnSync("ssh", [...buildSshArgs(request.port), request.remote, request.remoteCommand], {
    encoding: "utf-8",
    timeout: request.timeoutMs,
    maxBuffer: MAX_SSH_STDOUT_BYTES,
  });

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    status: result.status,
  };
}

function extractRemoteProbePayload(stdout: string): string | null {
  const begin = stdout.indexOf(REMOTE_PROBE_BEGIN_MARKER);
  if (begin === -1) {
    return null;
  }
  const start = begin + REMOTE_PROBE_BEGIN_MARKER.length;
  const end = stdout.indexOf(REMOTE_PROBE_END_MARKER, start);
  if (end === -1) {
    return null;
  }
  return stdout.slice(start, end).trim();
}

function runRemoteProbe<T extends object>(
  config: SshCheckpointConfig,
  options: CreateCheckpointProbeOptions,
  mode: "validate" | "latest",
  maxCheckpointAgeMs: number,
  checkpointPath?: string,
): T | null {
  const timeoutMs = options.sshProbeTimeoutMs ?? DEFAULT_SSH_PROBE_TIMEOUT_MS;
  const sshExec = options.sshExec ?? defaultSshExec;
  const workspacePrefix = buildRemoteWorkspacePrefix(config.remotePath);
  const pythonArgs = [mode, String(maxCheckpointAgeMs)];
  if (checkpointPath) {
    pythonArgs.push(checkpointPath);
  }

  const commandParts = [
    "set -eu",
    workspacePrefix,
    `printf '%s\\n' ${shellQuote(REMOTE_PROBE_BEGIN_MARKER)}`,
    [
      'if command -v python3 >/dev/null 2>&1; then PI_PY=python3',
      'elif command -v python >/dev/null 2>&1; then PI_PY=python',
      `else printf '%s\\n' ${shellQuote('{"error":"python_missing"}')}; fi`,
    ].join("; "),
    'if [ -n "${PI_PY:-}" ]; then',
    `  "$PI_PY" -c ${shellQuote(REMOTE_PROBE_SCRIPT)} ${pythonArgs.map(shellQuote).join(" ")}`,
    "fi",
    `printf '%s\\n' ${shellQuote(REMOTE_PROBE_END_MARKER)}`,
  ];
  const remoteCommand = commandParts.join("; ");
  const result = sshExec({
    remote: config.remote,
    port: config.port,
    remoteCommand,
    timeoutMs,
  });

  if (result.status !== 0 && !result.stdout) {
    return null;
  }

  const payload = extractRemoteProbePayload(result.stdout);
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

export function createLocalCheckpointProbe(): CheckpointProbe {
  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      if (!isLikelyCheckpointPath(checkpointPath)) return false;
      if (!existsSync(checkpointPath)) return false;

      if (maxCheckpointAgeMs <= 0) return true;

      try {
        const st = statSync(checkpointPath);
        const ageMs = Date.now() - st.mtimeMs;
        return ageMs <= maxCheckpointAgeMs;
      } catch {
        return false;
      }
    },

    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      const dir = path.join("work", "log", "checkpoints");

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return null;
      }

      const nowMs = Date.now();
      let bestPath: string | null = null;
      let bestMtimeMs = -1;

      for (const name of entries) {
        if (!name.endsWith(".md")) continue;

        const candidate = path.join(dir, name);

        try {
          const st = statSync(candidate);
          const ageMs = nowMs - st.mtimeMs;
          if (maxCheckpointAgeMs > 0 && ageMs > maxCheckpointAgeMs) continue;

          if (st.mtimeMs > bestMtimeMs) {
            bestMtimeMs = st.mtimeMs;
            bestPath = candidate;
          }
        } catch {
          // ignore
        }
      }

      return bestPath;
    },
  };
}

export function createSshCheckpointProbe(
  config: SshCheckpointConfig,
  options: CreateCheckpointProbeOptions = {},
): CheckpointProbe {
  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      if (!isLikelyCheckpointPath(checkpointPath)) return false;

      const result = runRemoteProbe<RemoteValidateResult>(
        config,
        options,
        "validate",
        maxCheckpointAgeMs,
        checkpointPath,
      );
      return Boolean(result?.exists && result?.fresh);
    },

    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      const result = runRemoteProbe<RemoteLatestResult>(config, options, "latest", maxCheckpointAgeMs);
      const latestPath = typeof result?.latestPath === "string" ? result.latestPath.trim() : "";
      return latestPath || null;
    },
  };
}

export function createCheckpointProbe(
  flags: FlagReader,
  options: CreateCheckpointProbeOptions = {},
): CheckpointProbe {
  const localProbe = createLocalCheckpointProbe();

  const resolveProbe = (): CheckpointProbe => {
    const sshConfig = resolveSshCheckpointConfig(flags);
    if (!sshConfig) {
      return localProbe;
    }
    return createSshCheckpointProbe(sshConfig, options);
  };

  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      return resolveProbe().isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs);
    },
    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      return resolveProbe().inferLatestCheckpointPath(maxCheckpointAgeMs);
    },
  };
}
