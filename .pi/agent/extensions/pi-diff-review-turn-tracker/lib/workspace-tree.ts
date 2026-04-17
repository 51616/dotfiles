import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeArtifactPath } from "./observed-changed-paths.ts";
import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

const LOCAL_SNAPSHOT_TIMEOUT_MS = 10_000;
const LOCAL_DIFF_TIMEOUT_MS = 15_000;
const REMOTE_SNAPSHOT_TIMEOUT_SECONDS = 10;
const REMOTE_DIFF_TIMEOUT_SECONDS = 15;
const TREE_OID_PATTERN = /^[0-9a-f]{40,64}$/i;

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type WorkspaceTreeDiff = {
  patchText: string;
  nameStatus: string;
  touchedPaths: string[];
};

function shellQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function shellJoin(argv: string[]): string {
  return argv.map((value) => shellQuote(value)).join(" ");
}

function normalizeText(value: string | Buffer | null | undefined): string {
  return Buffer.isBuffer(value)
    ? value.toString("utf8").replace(/\r\n/g, "\n")
    : String(value ?? "").replace(/\r\n/g, "\n");
}

function runLocalGit(
  repoRoot: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CommandResult {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
    timeout: options.timeoutMs ?? LOCAL_DIFF_TIMEOUT_MS,
  });

  const stdout = normalizeText(result.stdout);
  const stderr = normalizeText(result.stderr);
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`git ${args[0] ?? "command"} timed out in ${repoRoot}`);
  }
  if (result.status !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed in ${repoRoot}`);
  }
  return {
    stdout,
    stderr,
    exitCode: result.status,
  };
}

function validateTreeOid(value: string, context: string): string {
  const treeOid = value.trim();
  if (!TREE_OID_PATTERN.test(treeOid)) {
    throw new Error(`${context} returned an invalid tree oid: ${treeOid || "<empty>"}`);
  }
  return treeOid;
}

function normalizePatchText(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed}\n` : "";
}

export function parseTouchedPathsFromNameStatus(nameStatus: string): string[] {
  const seen = new Set<string>();
  const touched: string[] = [];

  for (const rawLine of normalizeText(nameStatus).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0] ?? "M";
    const rawPath = code === "R" || code === "C"
      ? (parts[2] ?? parts[1] ?? "")
      : (parts[1] ?? "");
    const normalizedPath = normalizeArtifactPath(rawPath);
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    touched.push(normalizedPath);
  }

  return touched.sort((left, right) => left.localeCompare(right));
}

export function captureLocalWorkspaceTree(repoRoot: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-index-"));
  const indexPath = path.join(tempDir, "index");
  try {
    runLocalGit(repoRoot, ["add", "-A", "--", "."], {
      env: { GIT_INDEX_FILE: indexPath },
      timeoutMs: LOCAL_SNAPSHOT_TIMEOUT_MS,
    });
    const tree = runLocalGit(repoRoot, ["write-tree"], {
      env: { GIT_INDEX_FILE: indexPath },
      timeoutMs: LOCAL_SNAPSHOT_TIMEOUT_MS,
    }).stdout;
    return validateTreeOid(tree, `git write-tree (${repoRoot})`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function diffLocalWorkspaceTrees(repoRoot: string, startTree: string, endTree: string): WorkspaceTreeDiff {
  if (startTree === endTree) {
    return { patchText: "", nameStatus: "", touchedPaths: [] };
  }

  const patchText = normalizePatchText(runLocalGit(repoRoot, [
    "diff",
    "--binary",
    "--find-renames",
    "-M",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    startTree,
    endTree,
  ], { timeoutMs: LOCAL_DIFF_TIMEOUT_MS }).stdout);
  const nameStatus = normalizeText(runLocalGit(repoRoot, [
    "diff",
    "--name-status",
    "--find-renames",
    "-M",
    startTree,
    endTree,
  ], { timeoutMs: LOCAL_DIFF_TIMEOUT_MS }).stdout).trim();

  return {
    patchText,
    nameStatus,
    touchedPaths: parseTouchedPathsFromNameStatus(nameStatus),
  };
}

async function runRemoteCommand(
  session: PiSshSession,
  command: string,
  timeoutSeconds: number,
): Promise<CommandResult> {
  const result = await session.execCapture(command, { timeoutSeconds });
  const stdout = normalizeText(result.stdout);
  const stderr = normalizeText(result.stderr);
  if (result.aborted) {
    throw new Error("remote command aborted");
  }
  if (result.timedOut) {
    throw new Error(`remote command timed out after ${timeoutSeconds}s`);
  }
  if (result.exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `remote command failed with exit code ${result.exitCode ?? "unknown"}`);
  }
  return { stdout, stderr, exitCode: result.exitCode };
}

function buildRemoteGitCommand(repoRoot: string, args: string[]): string {
  return [
    `cd -- ${shellQuote(repoRoot)} || { echo "pi-diff-review remote git could not cd into ${repoRoot}" >&2; exit 2; }`,
    'command -v git >/dev/null 2>&1 || { echo "pi-diff-review remote git requires git on the remote host" >&2; exit 127; }',
    `env GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true ${shellJoin(["git", ...args])}`,
  ].join("\n");
}

function buildRemoteWorkspaceTreeCommand(repoRoot: string): string {
  return [
    `cd -- ${shellQuote(repoRoot)} || { echo "pi-diff-review remote snapshot could not cd into ${repoRoot}" >&2; exit 2; }`,
    'command -v git >/dev/null 2>&1 || { echo "pi-diff-review remote snapshot requires git on the remote host" >&2; exit 127; }',
    'tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-diff-review-index.XXXXXX") || { echo "pi-diff-review remote snapshot could not create a temp dir" >&2; exit 3; }',
    'cleanup() { rm -rf "$tmp_dir"; }',
    'trap cleanup EXIT INT TERM',
    'export GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true',
    'export GIT_INDEX_FILE="$tmp_dir/index"',
    'git add -A -- . >/dev/null 2>&1 || { echo "pi-diff-review remote snapshot failed while staging the worktree" >&2; exit 4; }',
    'git write-tree',
  ].join("\n");
}

export async function captureRemoteWorkspaceTree(session: PiSshSession, repoRoot: string): Promise<string> {
  const result = await runRemoteCommand(session, buildRemoteWorkspaceTreeCommand(repoRoot), REMOTE_SNAPSHOT_TIMEOUT_SECONDS);
  return validateTreeOid(result.stdout, `remote git write-tree (${repoRoot})`);
}

export async function diffRemoteWorkspaceTrees(
  session: PiSshSession,
  repoRoot: string,
  startTree: string,
  endTree: string,
): Promise<WorkspaceTreeDiff> {
  if (startTree === endTree) {
    return { patchText: "", nameStatus: "", touchedPaths: [] };
  }

  const patchText = normalizePatchText((await runRemoteCommand(
    session,
    buildRemoteGitCommand(repoRoot, [
      "diff",
      "--binary",
      "--find-renames",
      "-M",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      startTree,
      endTree,
    ]),
    REMOTE_DIFF_TIMEOUT_SECONDS,
  )).stdout);
  const nameStatus = (await runRemoteCommand(
    session,
    buildRemoteGitCommand(repoRoot, [
      "diff",
      "--name-status",
      "--find-renames",
      "-M",
      startTree,
      endTree,
    ]),
    REMOTE_DIFF_TIMEOUT_SECONDS,
  )).stdout.trim();

  return {
    patchText,
    nameStatus,
    touchedPaths: parseTouchedPathsFromNameStatus(nameStatus),
  };
}
