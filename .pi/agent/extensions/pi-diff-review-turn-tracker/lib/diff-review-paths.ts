import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

export function resolveAgentDir({
  env = process.env,
  homeDir = os.homedir(),
}: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): string {
  const configured = env[AGENT_DIR_ENV];
  if (configured) return expandTilde(configured, homeDir);
  return path.join(homeDir, ".pi", "agent");
}

/** Mirrors pi's SessionManager.getDefaultSessionDir() safe-path encoding. */
export function safeSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function diffReviewCandidateRoots({
  repoRoot,
  scopeKey,
  allowRepoRoot = true,
  tmpRoot = os.tmpdir(),
  agentDir = resolveAgentDir(),
}: {
  repoRoot: string;
  /** Stable identifier used only for local storage paths. Defaults to repoRoot. */
  scopeKey?: string;
  /** Whether repo-local writes (repoRoot/.pi/diff-review) are allowed. */
  allowRepoRoot?: boolean;
  tmpRoot?: string;
  agentDir?: string;
}): { tmp: string; home: string; repo?: string } {
  const safe = safeSessionDirName(scopeKey ?? repoRoot);
  return {
    tmp: path.join(tmpRoot, "pi", "sessions", safe, "diff-review"),
    home: path.join(agentDir, "sessions", safe, "diff-review"),
    ...(allowRepoRoot ? { repo: path.join(repoRoot, ".pi", "diff-review") } : {}),
  };
}

function tryEnsureWritableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

export function resolveDiffReviewRootForWrite({
  repoRoot,
  scopeKey,
  allowRepoRoot = true,
  tmpRoot = os.tmpdir(),
  agentDir = resolveAgentDir(),
}: {
  repoRoot: string;
  scopeKey?: string;
  allowRepoRoot?: boolean;
  tmpRoot?: string;
  agentDir?: string;
}): { rootDir: string; outputLocation: "tmp" | "home" | "repo" } {
  const roots = diffReviewCandidateRoots({ repoRoot, scopeKey, allowRepoRoot, tmpRoot, agentDir });

  const tmp = tryEnsureWritableDir(roots.tmp);
  if (tmp) return { rootDir: tmp, outputLocation: "tmp" };

  const home = tryEnsureWritableDir(roots.home);
  if (home) return { rootDir: home, outputLocation: "home" };

  if (roots.repo) {
    const repo = tryEnsureWritableDir(roots.repo);
    if (repo) return { rootDir: repo, outputLocation: "repo" };
  }

  const repoLabel = roots.repo ? `, or ${roots.repo}` : "";
  throw new Error(`Unable to create a writable diff-review directory in ${roots.tmp}, ${roots.home}${repoLabel}.`);
}
