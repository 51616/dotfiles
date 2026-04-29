// @lat: [[git-state#Git state editor meter]]

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
  type GitStateSnapshot,
} from "./lib/git-state.ts";

const CONTRIBUTION_KEY = "git-state";
const POLL_INTERVAL_MS = 3_000;
const GIT_TIMEOUT_MS = 2_000;

let currentSnapshot: GitStateSnapshot | null = null;
let currentSignature = buildGitStateSignature(null);
let activeCtx: ExtensionContext | null = null;
let refreshInFlight = false;
let interval: ReturnType<typeof setInterval> | undefined;
let generation = 0;

function setSnapshot(snapshot: GitStateSnapshot | null): void {
  const nextSignature = buildGitStateSignature(snapshot);
  if (nextSignature === currentSignature) return;

  currentSnapshot = snapshot;
  currentSignature = nextSignature;
  requestTuiBrokerEditorRefresh();
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return { code: result.code, stdout: result.stdout };
}

async function readBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const branchResult = await git(pi, repoRoot, ["branch", "--show-current"]);
  const branchName = branchResult.stdout.trim();
  if (branchResult.code === 0 && branchName) return branchName;

  const headResult = await git(pi, repoRoot, ["rev-parse", "--short", "HEAD"]);
  const head = headResult.stdout.trim();
  if (headResult.code === 0 && head) return `detached@${head}`;

  return "unknown";
}

async function readGitState(pi: ExtensionAPI, cwd: string): Promise<GitStateSnapshot | null> {
  const rootResult = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) return null;

  const repoRoot = rootResult.stdout.trim();
  if (!repoRoot) return null;

  const branchName = await readBranchName(pi, repoRoot);

  const statusResult = await git(pi, repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusResult.code !== 0) return null;

  let diffResult = await git(pi, repoRoot, ["diff", "--numstat", "HEAD", "--"]);
  if (diffResult.code !== 0) {
    diffResult = await git(pi, repoRoot, ["diff", "--numstat", "--"]);
  }

  const { additions, deletions } = parseNumstat(diffResult.code === 0 ? diffResult.stdout : "");

  return {
    branchName,
    files: parsePorcelainFileCount(statusResult.stdout),
    additions,
    deletions,
    repoRoot,
  };
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
