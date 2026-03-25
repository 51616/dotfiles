import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRootCache = new Map<string, string | null>();

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function findExistingLookupStart(absolutePath: string): string {
  let current = absolutePath;
  while (true) {
    if (fs.existsSync(current)) {
      try {
        return fs.statSync(current).isDirectory() ? current : path.dirname(current);
      } catch {
        return path.dirname(current);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
}

export function findRepoRoot(startPath: string): string | null {
  const lookup = findExistingLookupStart(path.resolve(startPath));
  if (repoRootCache.has(lookup)) return repoRootCache.get(lookup) ?? null;

  const result = spawnSync("git", ["-C", lookup, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const repoRoot = result.status === 0 ? result.stdout.trim() || null : null;
  repoRootCache.set(lookup, repoRoot);
  return repoRoot;
}

export function repoKeyForRoot(repoRoot: string): string {
  const base = path.basename(repoRoot) || "repo";
  const safeBase = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return `${safeBase}-${digest}`;
}

export function resolveRepoPath(rawPath: string, cwd: string): { repoRoot: string; repoKey: string; absolutePath: string; repoRelPath: string } | null {
  const absolutePath = path.resolve(cwd, rawPath);
  const repoRoot = findRepoRoot(absolutePath);
  if (!repoRoot) return null;
  const repoRelPath = normalizePath(path.relative(repoRoot, absolutePath));
  if (!repoRelPath || repoRelPath.startsWith("../") || repoRelPath === "..") return null;
  return {
    repoRoot,
    repoKey: repoKeyForRoot(repoRoot),
    absolutePath,
    repoRelPath,
  };
}

export function findCwdRepoRoot(cwd: string): string | null {
  return findRepoRoot(cwd);
}
