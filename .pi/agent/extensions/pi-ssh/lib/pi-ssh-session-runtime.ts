import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";

const ACTIVE_SESSION_KEY = "__PI_SSH_ACTIVE_SESSION__";
const DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS = 15;

type GlobalState = Record<string, unknown>;

export interface PiSshConnection {
  remote: string;
  port: number;
  remoteCwd: string;
  remoteHome: string;
  localCwd: string;
  localHome: string;
}

export interface PiSshExecCaptureOptions {
  stdin?: string | Buffer;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

export interface PiSshExecCaptureResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface PiSshExecTextResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface PiSshStageTransport {
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>;
  writeFile(path: string, content: Buffer, signal?: AbortSignal): Promise<void>;
}

export interface PiSshTransport extends PiSshStageTransport {
  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  ): Promise<{ exitCode: number | null }>;
  ensureReadable(remotePath: string, signal?: AbortSignal): Promise<void>;
  ensureReadableWritable(remotePath: string, signal?: AbortSignal): Promise<void>;
  detectImageMimeType(remotePath: string, signal?: AbortSignal): Promise<string | null>;
  mkdir(remoteDir: string, signal?: AbortSignal): Promise<void>;
}

export interface PiSshRemoteContext {
  remoteHome: string;
  transport: PiSshStageTransport;
}

export type PiSshConnectionInfo = {
  kind: "ssh";
  remote: string;
  port: number;
  remoteCwd: string;
};

export type PiSshResolvedRepoIdentity = {
  session: PiSshSession;
  connection: PiSshConnectionInfo;
  remoteCwd: string;
  repoRoot: string;
};

export type PiSshRemoteStatKind = "file" | "directory" | "other" | null;

export interface PiSshRemoteStat {
  exists: boolean;
  kind: PiSshRemoteStatKind;
  mtimeMs: number | null;
  size: number | null;
}

export interface PiSshSession {
  getConnectionInfo(): PiSshConnectionInfo;
  getRemoteContext(signal?: AbortSignal): PiSshRemoteContext;
  createReadOps(signal?: AbortSignal): ReadOperations;
  createWriteOps(signal?: AbortSignal): WriteOperations;
  createEditOps(signal?: AbortSignal): EditOperations;
  createBashOps(options?: { onCommandComplete?: (cwd: string) => void }): BashOperations;
  mapLocalPathToRemote(localPath: string): string;
  execCapture(command: string, options?: PiSshExecCaptureOptions): Promise<PiSshExecCaptureResult>;
  execText(command: string, options?: Omit<PiSshExecCaptureOptions, "stdin">): Promise<PiSshExecTextResult>;
  exists(remotePath: string, signal?: AbortSignal): Promise<boolean>;
  stat(remotePath: string, signal?: AbortSignal): Promise<PiSshRemoteStat>;
  repoRoot(remoteCwd?: string, signal?: AbortSignal): Promise<string | null>;
}

const REPO_ROOT_CACHE = new WeakMap<PiSshSession, Map<string, string | null>>();

const REMOTE_STAT_SCRIPT = String.raw`import json, os, stat, sys
path = sys.argv[1]
if not os.path.exists(path):
    print(json.dumps({"exists": False, "kind": None, "mtimeMs": None, "size": None}, separators=(",", ":")))
    raise SystemExit(0)
info = os.stat(path)
mode = info.st_mode
kind = "other"
if stat.S_ISREG(mode):
    kind = "file"
elif stat.S_ISDIR(mode):
    kind = "directory"
print(json.dumps({
    "exists": True,
    "kind": kind,
    "mtimeMs": int(info.st_mtime * 1000),
    "size": int(info.st_size),
}, separators=(",", ":")))`;

function getGlobalState(): GlobalState {
  return globalThis as GlobalState;
}

function shellQuote(value: string): string {
  if (!value) {
    return "''";
  }
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function resolveCommandFailure(result: PiSshExecCaptureResult | PiSshExecTextResult, fallbackPrefix: string): Error {
  if (result.aborted) {
    return new Error("aborted");
  }
  if (result.timedOut) {
    return new Error(`SSH command timed out after ${fallbackPrefix}`);
  }
  const detail = "stderr" in result
    ? result.stderr.toString("utf-8").trim() || result.stdout.toString("utf-8").trim()
    : result.output.trim();
  const suffix = result.exitCode === null ? "unknown exit code" : `exit code ${result.exitCode}`;
  return new Error(detail || `SSH command failed with ${suffix}`);
}

function buildRepoRootCommand(remoteCwd: string): string {
  return [
    `if cd -- ${shellQuote(remoteCwd)} 2>/dev/null && root=$(git --no-optional-locks rev-parse --show-toplevel 2>/dev/null); then`,
    '  printf "%s" "$root"',
    "fi",
  ].join("\n");
}

function buildRemoteStatCommand(remotePath: string): string {
  return [
    'if command -v python3 >/dev/null 2>&1; then PI_PY=python3',
    'elif command -v python >/dev/null 2>&1; then PI_PY=python',
    'else echo "pi-ssh session stat requires python3 or python on the remote host" >&2; exit 127',
    'fi',
    `"$PI_PY" -c ${shellQuote(REMOTE_STAT_SCRIPT)} ${shellQuote(remotePath)}`,
  ].join("\n");
}

function normalizeRemoteStatKind(value: unknown): PiSshRemoteStatKind {
  if (value === "file" || value === "directory" || value === "other") {
    return value;
  }
  return null;
}

function parseRemoteStat(stdout: Buffer): PiSshRemoteStat {
  const raw = stdout.toString("utf-8").trim();
  if (!raw) {
    throw new Error("SSH stat helper returned no output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `SSH stat helper returned invalid JSON: ${error.message}`
        : "SSH stat helper returned invalid JSON",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("SSH stat helper returned a non-object payload");
  }

  const exists = Boolean((parsed as Record<string, unknown>).exists);
  return {
    exists,
    kind: exists ? normalizeRemoteStatKind((parsed as Record<string, unknown>).kind) : null,
    mtimeMs: typeof (parsed as Record<string, unknown>).mtimeMs === "number"
      ? (parsed as Record<string, unknown>).mtimeMs as number
      : null,
    size: typeof (parsed as Record<string, unknown>).size === "number"
      ? (parsed as Record<string, unknown>).size as number
      : null,
  };
}

export function mapLocalPathToRemote(
  localPath: string,
  connection: Pick<PiSshConnection, "localCwd" | "localHome" | "remoteCwd" | "remoteHome">,
): string {
  if (localPath === connection.localCwd) return connection.remoteCwd;
  if (localPath.startsWith(`${connection.localCwd}/`)) {
    return `${connection.remoteCwd}${localPath.slice(connection.localCwd.length)}`;
  }
  if (localPath === connection.localHome) return connection.remoteHome;
  if (localPath.startsWith(`${connection.localHome}/`)) {
    return `${connection.remoteHome}${localPath.slice(connection.localHome.length)}`;
  }
  return localPath;
}

export function createRemoteReadOps(
  connection: Pick<PiSshConnection, "localCwd" | "localHome" | "remoteCwd" | "remoteHome">,
  transport: PiSshTransport,
  signal?: AbortSignal,
): ReadOperations {
  return {
    readFile: async (absolutePath) => transport.readFile(mapLocalPathToRemote(absolutePath, connection), signal),
    access: async (absolutePath) => transport.ensureReadable(mapLocalPathToRemote(absolutePath, connection), signal),
    detectImageMimeType: async (absolutePath) => {
      try {
        return await transport.detectImageMimeType(mapLocalPathToRemote(absolutePath, connection), signal);
      } catch {
        return null;
      }
    },
  };
}

export function createRemoteWriteOps(
  connection: Pick<PiSshConnection, "localCwd" | "localHome" | "remoteCwd" | "remoteHome">,
  transport: PiSshTransport,
  signal?: AbortSignal,
): WriteOperations {
  return {
    mkdir: async (absoluteDir) => transport.mkdir(mapLocalPathToRemote(absoluteDir, connection), signal),
    writeFile: async (absolutePath, content) =>
      transport.writeFile(mapLocalPathToRemote(absolutePath, connection), Buffer.from(content, "utf-8"), signal),
  };
}

export function createRemoteEditOps(
  connection: Pick<PiSshConnection, "localCwd" | "localHome" | "remoteCwd" | "remoteHome">,
  transport: PiSshTransport,
  signal?: AbortSignal,
): EditOperations {
  const readOps = createRemoteReadOps(connection, transport, signal);
  const writeOps = createRemoteWriteOps(connection, transport, signal);

  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (absolutePath) =>
      transport.ensureReadableWritable(mapLocalPathToRemote(absolutePath, connection), signal),
  };
}

export function createRemoteBashOps(
  transport: Pick<PiSshTransport, "exec">,
  options: { onCommandComplete?: (cwd: string) => void } = {},
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      try {
        return await transport.exec(command, cwd, { onData, signal, timeout });
      } finally {
        options.onCommandComplete?.(cwd);
      }
    },
  };
}

export function createPiSshSession(options: {
  connection: PiSshConnection;
  transport: PiSshTransport;
  execCapture: (command: string, options?: PiSshExecCaptureOptions) => Promise<PiSshExecCaptureResult>;
  execText?: (command: string, options?: Omit<PiSshExecCaptureOptions, "stdin">) => Promise<PiSshExecTextResult>;
}): PiSshSession {
  const { connection, transport, execCapture, execText: execTextImpl } = options;

  const execText = async (command: string, captureOptions: Omit<PiSshExecCaptureOptions, "stdin"> = {}): Promise<PiSshExecTextResult> => {
    if (execTextImpl) {
      return execTextImpl(command, captureOptions);
    }
    const result = await execCapture(command, captureOptions);
    return {
      output: [result.stdout.toString("utf-8"), result.stderr.toString("utf-8")].filter(Boolean).join("\n").replace(/\r\n/g, "\n"),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  };

  return {
    getConnectionInfo() {
      return {
        kind: "ssh",
        remote: connection.remote,
        port: connection.port,
        remoteCwd: connection.remoteCwd,
      };
    },

    getRemoteContext() {
      return {
        remoteHome: connection.remoteHome,
        transport,
      };
    },

    createReadOps(signal) {
      return createRemoteReadOps(connection, transport, signal);
    },

    createWriteOps(signal) {
      return createRemoteWriteOps(connection, transport, signal);
    },

    createEditOps(signal) {
      return createRemoteEditOps(connection, transport, signal);
    },

    createBashOps(runtimeOptions) {
      return createRemoteBashOps(transport, runtimeOptions);
    },

    mapLocalPathToRemote(localPath) {
      return mapLocalPathToRemote(localPath, connection);
    },

    async execCapture(command, captureOptions = {}) {
      return execCapture(command, captureOptions);
    },

    async execText(command, captureOptions = {}) {
      return execText(command, captureOptions);
    },

    async exists(remotePath, signal) {
      const result = await execText(`test -e ${shellQuote(remotePath)}`, {
        signal,
        timeoutSeconds: DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS,
      });
      if (result.aborted || result.timedOut) {
        throw resolveCommandFailure(result, `${DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS}s`);
      }
      if (result.exitCode === 0) {
        return true;
      }
      if (result.exitCode === 1) {
        return false;
      }
      throw resolveCommandFailure(result, `${DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS}s`);
    },

    async stat(remotePath, signal) {
      const result = await execCapture(buildRemoteStatCommand(remotePath), {
        signal,
        timeoutSeconds: DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS,
      });
      if (result.aborted || result.timedOut || result.exitCode !== 0) {
        throw resolveCommandFailure(result, `${DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS}s`);
      }
      return parseRemoteStat(result.stdout);
    },

    async repoRoot(remoteCwd = connection.remoteCwd, signal) {
      const result = await execText(buildRepoRootCommand(remoteCwd), {
        signal,
        timeoutSeconds: DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS,
      });
      if (result.aborted || result.timedOut) {
        throw resolveCommandFailure(result, `${DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS}s`);
      }
      if (result.exitCode !== 0) {
        throw resolveCommandFailure(result, `${DEFAULT_SESSION_HELPER_TIMEOUT_SECONDS}s`);
      }
      const root = result.output.trim();
      return root || null;
    },
  };
}

export function getActivePiSshSession(): PiSshSession | null {
  const value = getGlobalState()[ACTIVE_SESSION_KEY];
  return value && typeof value === "object" ? value as PiSshSession : null;
}

export function publishActivePiSshSession(session: PiSshSession | null): void {
  getGlobalState()[ACTIVE_SESSION_KEY] = session;
}

export function clearPublishedPiSshSession(): void {
  publishActivePiSshSession(null);
}

export function __publishActivePiSshSessionForTests(session: PiSshSession | null): void {
  publishActivePiSshSession(session);
}

function normalizeRemotePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveRemoteCwdForLocalPath(session: PiSshSession, localCwd: string): string {
  const mapped = normalizeRemotePath(session.mapLocalPathToRemote(localCwd));
  if (mapped && mapped !== normalizeRemotePath(localCwd) && mapped.startsWith("/")) {
    return mapped;
  }
  return session.getConnectionInfo().remoteCwd;
}

function getOrCreateRepoRootCache(session: PiSshSession): Map<string, string | null> {
  let cache = REPO_ROOT_CACHE.get(session);
  if (!cache) {
    cache = new Map<string, string | null>();
    REPO_ROOT_CACHE.set(session, cache);
  }
  return cache;
}

function setCachedRepoRoot(session: PiSshSession, remotePath: string, repoRoot: string | null): void {
  const cache = getOrCreateRepoRootCache(session);
  const normalizedRemotePath = normalizeRemotePath(remotePath);
  cache.set(normalizedRemotePath, repoRoot ? normalizeRemotePath(repoRoot) : null);
  if (repoRoot) {
    const normalizedRepoRoot = normalizeRemotePath(repoRoot);
    cache.set(normalizedRepoRoot, normalizedRepoRoot);
  }
}

async function resolveCachedRepoRoot(session: PiSshSession, remoteCwd: string): Promise<string | null> {
  const normalizedRemoteCwd = normalizeRemotePath(remoteCwd);
  const cache = getOrCreateRepoRootCache(session);
  if (cache.has(normalizedRemoteCwd)) {
    return cache.get(normalizedRemoteCwd) ?? null;
  }
  for (const [cachedPath, cachedRepoRoot] of cache.entries()) {
    if (!cachedRepoRoot) continue;
    if (normalizedRemoteCwd === cachedPath || normalizedRemoteCwd.startsWith(`${cachedPath}/`)) {
      return cachedRepoRoot;
    }
  }
  const repoRoot = await session.repoRoot(normalizedRemoteCwd);
  setCachedRepoRoot(session, normalizedRemoteCwd, repoRoot ?? null);
  return repoRoot ?? null;
}

export async function resolvePiSshRepoIdentity(session: PiSshSession, localCwd: string): Promise<PiSshResolvedRepoIdentity> {
  const connection = session.getConnectionInfo();
  const remoteCwd = resolveRemoteCwdForLocalPath(session, localCwd);
  const candidates = [remoteCwd, connection.remoteCwd]
    .map((value) => normalizeRemotePath(value))
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const repoRoot = await resolveCachedRepoRoot(session, candidate);
      if (!repoRoot) continue;
      setCachedRepoRoot(session, remoteCwd, repoRoot);
      setCachedRepoRoot(session, connection.remoteCwd, repoRoot);
      return {
        session,
        connection,
        remoteCwd,
        repoRoot,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw new Error(`Could not resolve remote SSH repo root: ${lastError.message}`);
  }
  throw new Error("Remote SSH workspace is not inside a git repository.");
}

export async function resolveActivePiSshRepoIdentity(localCwd: string): Promise<PiSshResolvedRepoIdentity | null> {
  const session = getActivePiSshSession();
  if (!session) return null;
  return resolvePiSshRepoIdentity(session, localCwd);
}

export function __resetPiSshSessionForTests(): void {
  clearPublishedPiSshSession();
}
