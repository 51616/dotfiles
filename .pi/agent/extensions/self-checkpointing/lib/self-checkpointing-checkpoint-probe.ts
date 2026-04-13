import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { isLikelyCheckpointPath } from "../../lib/autockpt/autockpt-footer-guards.ts";
import {
  getActiveSkillUriBackend,
  type SkillUriBackendConnectionInfo,
  type SkillUriBackendProvider,
} from "../../skill-uri/lib/backend-runtime.ts";

export type CheckpointProbeInfo = {
  mode: "local" | "ssh";
  source: "local-default" | "active-backend" | "cached-backend";
  remote?: string;
  port?: number;
  remotePath?: string;
};

export type CheckpointProbe = {
  isFreshCheckpointFile: (checkpointPath: string, maxCheckpointAgeMs: number) => boolean;
  inferLatestCheckpointPath: (maxCheckpointAgeMs: number) => string | null;
  describe: () => CheckpointProbeInfo;
};

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
  getActiveBackend?: () => Pick<SkillUriBackendProvider, "getConnectionInfo"> | null;
};

type ProbeValidationResult = {
  exists: boolean;
  fresh: boolean;
  mtimeMs?: number;
};

type ProbeLatestResult = {
  latestPath: string | null;
  mtimeMs?: number;
};

type RemoteValidateResult = {
  exists?: boolean;
  fresh?: boolean;
  mtimeMs?: number;
};

type RemoteLatestResult = {
  latestPath?: string | null;
  mtimeMs?: number | null;
};

const REMOTE_PROBE_BEGIN_MARKER = "__PI_SELF_CHECKPOINT_PROBE_BEGIN__";
const REMOTE_PROBE_END_MARKER = "__PI_SELF_CHECKPOINT_PROBE_END__";
const DEFAULT_SSH_PROBE_TIMEOUT_MS = 8_000;
const MAX_SSH_STDOUT_BYTES = 64 * 1024;
const CHECKPOINT_DIR = "/tmp/pi-work/checkpoints";

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
    dir_path = "/tmp/pi-work/checkpoints"
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
                latest_path = candidate
    result = {"latestPath": latest_path, "mtimeMs": latest_mtime}
else:
    result = {"error": "unknown_mode", "mode": mode}
print(json.dumps(result, separators=(",", ":")))`;

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveCheckpointBackendConfig(
  connectionInfo: SkillUriBackendConnectionInfo | null | undefined,
): SshCheckpointConfig | null {
  if (!connectionInfo || connectionInfo.kind !== "ssh") {
    return null;
  }

  const remote = connectionInfo.remote.trim();
  if (!remote) {
    return null;
  }

  return {
    remote,
    remotePath: connectionInfo.remoteCwd,
    port: connectionInfo.port,
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
  ].filter(Boolean);
  const remoteCommand = commandParts.join("\n");
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

function validateLocalCheckpointFile(
  checkpointPath: string,
  maxCheckpointAgeMs: number,
): ProbeValidationResult {
  if (!isLikelyCheckpointPath(checkpointPath)) {
    return { exists: false, fresh: false };
  }
  if (!existsSync(checkpointPath)) {
    return { exists: false, fresh: false };
  }

  try {
    const st = statSync(checkpointPath);
    const ageMs = Date.now() - st.mtimeMs;
    return {
      exists: true,
      fresh: maxCheckpointAgeMs <= 0 ? true : ageMs <= maxCheckpointAgeMs,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { exists: false, fresh: false };
  }
}

function inferLatestLocalCheckpoint(maxCheckpointAgeMs: number): ProbeLatestResult {
  const dir = CHECKPOINT_DIR;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { latestPath: null };
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

  return {
    latestPath: bestPath,
    mtimeMs: bestMtimeMs >= 0 ? bestMtimeMs : undefined,
  };
}

function validateRemoteCheckpointFile(
  config: SshCheckpointConfig,
  options: CreateCheckpointProbeOptions,
  checkpointPath: string,
  maxCheckpointAgeMs: number,
): ProbeValidationResult {
  if (!isLikelyCheckpointPath(checkpointPath)) {
    return { exists: false, fresh: false };
  }

  const result = runRemoteProbe<RemoteValidateResult>(
    config,
    options,
    "validate",
    maxCheckpointAgeMs,
    checkpointPath,
  );
  return {
    exists: Boolean(result?.exists),
    fresh: Boolean(result?.exists && result?.fresh),
    mtimeMs: typeof result?.mtimeMs === "number" ? result.mtimeMs : undefined,
  };
}

function inferLatestRemoteCheckpoint(
  config: SshCheckpointConfig,
  options: CreateCheckpointProbeOptions,
  maxCheckpointAgeMs: number,
): ProbeLatestResult {
  const result = runRemoteProbe<RemoteLatestResult>(config, options, "latest", maxCheckpointAgeMs);
  const latestPath = typeof result?.latestPath === "string" ? result.latestPath.trim() : "";
  return {
    latestPath: latestPath || null,
    mtimeMs: typeof result?.mtimeMs === "number" ? result.mtimeMs : undefined,
  };
}

export function createLocalCheckpointProbe(): CheckpointProbe {
  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      const result = validateLocalCheckpointFile(checkpointPath, maxCheckpointAgeMs);
      return result.exists && result.fresh;
    },

    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      return inferLatestLocalCheckpoint(maxCheckpointAgeMs).latestPath;
    },

    describe() {
      return { mode: "local", source: "local-default" };
    },
  };
}

export function createSshCheckpointProbe(
  config: SshCheckpointConfig,
  options: CreateCheckpointProbeOptions = {},
): CheckpointProbe {
  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      const result = validateRemoteCheckpointFile(config, options, checkpointPath, maxCheckpointAgeMs);
      return result.exists && result.fresh;
    },

    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      return inferLatestRemoteCheckpoint(config, options, maxCheckpointAgeMs).latestPath;
    },

    describe() {
      return {
        mode: "ssh",
        source: "active-backend",
        remote: config.remote,
        port: config.port,
        remotePath: config.remotePath,
      };
    },
  };
}

export function createCheckpointProbe(options: CreateCheckpointProbeOptions = {}): CheckpointProbe {
  const localProbe = createLocalCheckpointProbe();
  const getActiveBackend = options.getActiveBackend ?? getActiveSkillUriBackend;
  let lastSshConfig: SshCheckpointConfig | null = null;

  const resolveProbeState = (): { probe: CheckpointProbe; info: CheckpointProbeInfo } => {
    const activeSshConfig = resolveCheckpointBackendConfig(getActiveBackend()?.getConnectionInfo());
    if (activeSshConfig) {
      lastSshConfig = activeSshConfig;
      return {
        probe: createSshCheckpointProbe(activeSshConfig, options),
        info: {
          mode: "ssh",
          source: "active-backend",
          remote: activeSshConfig.remote,
          port: activeSshConfig.port,
          remotePath: activeSshConfig.remotePath,
        },
      };
    }

    if (lastSshConfig) {
      return {
        probe: createSshCheckpointProbe(lastSshConfig, options),
        info: {
          mode: "ssh",
          source: "cached-backend",
          remote: lastSshConfig.remote,
          port: lastSshConfig.port,
          remotePath: lastSshConfig.remotePath,
        },
      };
    }

    return {
      probe: localProbe,
      info: {
        mode: "local",
        source: "local-default",
      },
    };
  };

  return {
    isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs) {
      return resolveProbeState().probe.isFreshCheckpointFile(checkpointPath, maxCheckpointAgeMs);
    },
    inferLatestCheckpointPath(maxCheckpointAgeMs) {
      return resolveProbeState().probe.inferLatestCheckpointPath(maxCheckpointAgeMs);
    },
    describe() {
      return resolveProbeState().info;
    },
  };
}
