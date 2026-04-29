// @lat: [[git-state#Git state editor meter]]

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getActivePiSshSession,
  type PiSshExecTextResult,
  type PiSshSession,
} from "../pi-ssh/lib/pi-ssh-session-runtime.ts";
import { getPiSshFooterSnapshot } from "../pi-ssh/lib/pi-ssh-footer-runtime.ts";
import {
  registerTuiBrokerEditorTopRightStatusProvider,
  requestTuiBrokerEditorRefresh,
  unregisterTuiBrokerEditorTopRightStatusProvider,
} from "../tui-broker/lib/runtime.ts";
import {
  buildGitStateSignature,
  formatGitStateLabel,
  parseNumstat,
  parsePorcelainFileCount,
  parsePorcelainUntrackedFileCount,
  parseUntrackedLineStats,
  type GitStateSnapshot,
  type UntrackedLineStats,
} from "./lib/git-state.ts";

const CONTRIBUTION_KEY = "git-state";
const POLL_INTERVAL_MS = 3_000;
const GIT_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_SECONDS = GIT_TIMEOUT_MS / 1_000;
const UNTRACKED_LINE_COUNT_BYTE_LIMIT = 256 * 1024;

const UNTRACKED_LINE_STATS_SCRIPT = String.raw`import json, os, stat, subprocess, sys
limit = int(sys.argv[1])
proc = subprocess.run(
    ["git", "--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"],
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
)
if proc.returncode != 0:
    raise SystemExit(proc.returncode)
additions = 0
total_bytes = 0
for raw_path in proc.stdout.split(b"\0"):
    if not raw_path:
        continue
    path = raw_path.decode(sys.getfilesystemencoding(), "surrogateescape")
    try:
        info = os.lstat(path)
    except OSError:
        continue
    if not stat.S_ISREG(info.st_mode):
        continue
    remaining = limit - total_bytes
    if remaining <= 0:
        print(json.dumps({"additions": additions, "capped": True}, separators=(",", ":")))
        raise SystemExit(0)
    try:
        with open(path, "rb") as handle:
            data = handle.read(remaining + 1)
    except OSError:
        continue
    if len(data) > remaining:
        print(json.dumps({"additions": additions, "capped": True}, separators=(",", ":")))
        raise SystemExit(0)
    total_bytes += len(data)
    if b"\0" in data:
        continue
    if data:
        additions += data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
print(json.dumps({"additions": additions, "capped": False}, separators=(",", ":")))`;

let currentSnapshot: GitStateSnapshot | null = null;
let currentSignature = buildGitStateSignature(null);
let activeCtx: ExtensionContext | null = null;
let refreshInFlight = false;
let interval: ReturnType<typeof setInterval> | undefined;
let generation = 0;

type GitCommand = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type UntrackedLineStatsReader = (repoRoot: string) => Promise<UntrackedLineStats>;

type RemoteFooterSnapshot = {
  remoteCwd: string;
};

type ReadGitStateDeps = {
  getActiveSession?: () => PiSshSession | null;
  getRemoteFooterSnapshot?: () => RemoteFooterSnapshot | null;
};

const defaultReadGitStateDeps: Required<ReadGitStateDeps> = {
  getActiveSession: getActivePiSshSession,
  getRemoteFooterSnapshot: getPiSshFooterSnapshot,
};

function setSnapshot(snapshot: GitStateSnapshot | null): void {
  const nextSignature = buildGitStateSignature(snapshot);
  if (nextSignature === currentSignature) return;

  currentSnapshot = snapshot;
  currentSignature = nextSignature;
  requestTuiBrokerEditorRefresh();
}

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function localGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return { code: result.code, stdout: result.stdout };
}

async function localUntrackedLineStats(pi: ExtensionAPI, repoRoot: string): Promise<UntrackedLineStats> {
  const result = await pi.exec("python3", ["-c", UNTRACKED_LINE_STATS_SCRIPT, String(UNTRACKED_LINE_COUNT_BYTE_LIMIT)], {
    cwd: repoRoot,
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.code !== 0) return { additions: 0, capped: true };
  return parseUntrackedLineStats(result.stdout) ?? { additions: 0, capped: true };
}

function buildRemoteGitCommand(cwd: string, args: string[]): string {
  const quotedArgs = args.map(shellQuote).join(" ");
  return `cd -- ${shellQuote(cwd)} && git --no-optional-locks ${quotedArgs}`;
}

async function remoteGit(session: PiSshSession, cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const result: PiSshExecTextResult = await session.execText(buildRemoteGitCommand(cwd, args), {
    timeoutSeconds: GIT_TIMEOUT_SECONDS,
  });
  return { code: result.exitCode ?? 1, stdout: result.output };
}

function buildRemoteUntrackedLineStatsCommand(repoRoot: string): string {
  return [
    `cd -- ${shellQuote(repoRoot)}`,
    "if command -v python3 >/dev/null 2>&1; then PI_PY=python3; elif command -v python >/dev/null 2>&1; then PI_PY=python; else exit 127; fi",
    `"$PI_PY" -c ${shellQuote(UNTRACKED_LINE_STATS_SCRIPT)} ${shellQuote(String(UNTRACKED_LINE_COUNT_BYTE_LIMIT))}`,
  ].join(" && ");
}

async function remoteUntrackedLineStats(session: PiSshSession, repoRoot: string): Promise<UntrackedLineStats> {
  const result: PiSshExecTextResult = await session.execText(buildRemoteUntrackedLineStatsCommand(repoRoot), {
    timeoutSeconds: GIT_TIMEOUT_SECONDS,
  });
  if (result.exitCode !== 0) return { additions: 0, capped: true };
  return parseUntrackedLineStats(result.output) ?? { additions: 0, capped: true };
}

async function readBranchName(git: GitCommand, repoRoot: string): Promise<string> {
  const branchResult = await git(repoRoot, ["branch", "--show-current"]);
  const branchName = branchResult.stdout.trim();
  if (branchResult.code === 0 && branchName) return branchName;

  const headResult = await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const head = headResult.stdout.trim();
  if (headResult.code === 0 && head) return `detached@${head}`;

  return "unknown";
}

async function readGitStateWithCommand(
  git: GitCommand,
  readUntrackedLineStats: UntrackedLineStatsReader,
  cwd: string,
): Promise<GitStateSnapshot | null> {
  const rootResult = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) return null;

  const repoRoot = rootResult.stdout.trim();
  if (!repoRoot) return null;

  return readGitStateInRepo(git, readUntrackedLineStats, repoRoot);
}

async function readGitStateInRepo(
  git: GitCommand,
  readUntrackedLineStats: UntrackedLineStatsReader,
  repoRoot: string,
): Promise<GitStateSnapshot | null> {
  const branchName = await readBranchName(git, repoRoot);

  const statusResult = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusResult.code !== 0) return null;

  let diffResult = await git(repoRoot, ["diff", "--numstat", "HEAD", "--"]);
  if (diffResult.code !== 0) {
    diffResult = await git(repoRoot, ["diff", "--numstat", "--"]);
  }

  const { additions, deletions } = parseNumstat(diffResult.code === 0 ? diffResult.stdout : "");
  const untrackedFiles = parsePorcelainUntrackedFileCount(statusResult.stdout);
  const untrackedLineStats = untrackedFiles > 0
    ? await readUntrackedLineStats(repoRoot).catch(() => ({ additions: 0, capped: true }))
    : { additions: 0, capped: false };

  return {
    branchName,
    files: parsePorcelainFileCount(statusResult.stdout),
    additions: additions + untrackedLineStats.additions,
    deletions,
    additionsUnknown: untrackedLineStats.capped,
    repoRoot,
  };
}

function resolveRemoteCwd(session: PiSshSession, localCwd: string, snapshot: RemoteFooterSnapshot | null): string {
  const snapshotCwd = snapshot?.remoteCwd?.trim();
  if (snapshotCwd) return snapshotCwd;

  const mappedCwd = session.mapLocalPathToRemote(localCwd).trim();
  if (mappedCwd && mappedCwd !== localCwd) return mappedCwd;

  return session.getConnectionInfo().remoteCwd;
}

async function readRemoteGitState(
  session: PiSshSession,
  localCwd: string,
  snapshot: RemoteFooterSnapshot | null,
): Promise<GitStateSnapshot | null> {
  const remoteCwd = resolveRemoteCwd(session, localCwd, snapshot);
  const repoRoot = await session.repoRoot(remoteCwd);
  if (!repoRoot) return null;

  return readGitStateInRepo(
    (cwd, args) => remoteGit(session, cwd, args),
    (root) => remoteUntrackedLineStats(session, root),
    repoRoot,
  );
}

export async function readGitState(
  pi: ExtensionAPI,
  cwd: string,
  deps: ReadGitStateDeps = defaultReadGitStateDeps,
): Promise<GitStateSnapshot | null> {
  const getActiveSession = deps.getActiveSession ?? defaultReadGitStateDeps.getActiveSession;
  const session = getActiveSession();
  if (session) {
    const getRemoteFooterSnapshot = deps.getRemoteFooterSnapshot ?? defaultReadGitStateDeps.getRemoteFooterSnapshot;
    return readRemoteGitState(session, cwd, getRemoteFooterSnapshot());
  }

  return readGitStateWithCommand(
    (gitCwd, args) => localGit(pi, gitCwd, args),
    (repoRoot) => localUntrackedLineStats(pi, repoRoot),
    cwd,
  );
}

async function refresh(pi: ExtensionAPI): Promise<void> {
  const ctx = activeCtx;
  if (!ctx?.hasUI || refreshInFlight) return;

  refreshInFlight = true;
  const refreshGeneration = generation;

  try {
    const cwd = ctx.sessionManager.getCwd();
    const snapshot = await readGitState(pi, cwd);
    if (refreshGeneration === generation) {
      setSnapshot(snapshot);
    }
  } catch {
    if (refreshGeneration === generation) {
      setSnapshot(null);
    }
  } finally {
    refreshInFlight = false;
  }
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext): void {
  activeCtx = ctx;
  generation += 1;

  registerTuiBrokerEditorTopRightStatusProvider(CONTRIBUTION_KEY, () => {
    if (!currentSnapshot) return null;
    return { text: formatGitStateLabel(currentSnapshot), priority: 100 };
  });

  if (interval) clearInterval(interval);
  interval = setInterval(() => {
    void refresh(pi);
  }, POLL_INTERVAL_MS);
  interval.unref?.();

  void refresh(pi);
}

function stopPolling(): void {
  activeCtx = null;
  generation += 1;
  if (interval) clearInterval(interval);
  interval = undefined;
  unregisterTuiBrokerEditorTopRightStatusProvider(CONTRIBUTION_KEY);
  setSnapshot(null);
}

export default function gitState(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startPolling(pi, ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startPolling(pi, ctx);
  });

  pi.on("session_fork", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startPolling(pi, ctx);
  });

  pi.on("before_agent_start", () => {
    void refresh(pi);
  });

  pi.on("tool_execution_end", () => {
    void refresh(pi);
  });

  pi.on("agent_end", () => {
    void refresh(pi);
  });

  pi.on("session_shutdown", () => {
    stopPolling();
  });
}
