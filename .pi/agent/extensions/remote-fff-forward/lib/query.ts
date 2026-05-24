import path from "node:path";

function toSlashPath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function normalizeAbsoluteConstraint(pathConstraint: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    const relative = toSlashPath(path.relative(normalizedRoot, pathConstraint));
    if (relative === "") return null;
    if (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative)) {
      return relative;
    }
  }
  throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
}

export function normalizePathConstraint(
  pathConstraint: string,
  workspaceRoots: readonly string[] = [process.cwd()],
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    const relative = normalizeAbsoluteConstraint(trimmed, workspaceRoots);
    if (relative === null) return null;
    trimmed = relative;
  }

  if (trimmed === "." || trimmed === "./") return null;
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  if (/[*?[{]/.test(trimmed)) return trimmed;

  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;

  return `${trimmed}/`;
}

export function normalizeExcludes(
  exclude: string | string[] | undefined,
  workspaceRoots: readonly string[] = [process.cwd()],
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const part of parts) {
      const stripped = part.startsWith("!") ? part.slice(1) : part;
      const normalized = normalizePathConstraint(stripped, workspaceRoots);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

export function buildQuery(
  pathConstraint: string | undefined,
  pattern: string,
  exclude?: string | string[],
  workspaceRoots: readonly string[] = [process.cwd()],
): string {
  const parts: string[] = [];
  if (pathConstraint) {
    const normalizedPath = normalizePathConstraint(pathConstraint, workspaceRoots);
    if (normalizedPath) parts.push(normalizedPath);
  }
  parts.push(...normalizeExcludes(exclude, workspaceRoots));
  parts.push(pattern);
  return parts.join(" ");
}
