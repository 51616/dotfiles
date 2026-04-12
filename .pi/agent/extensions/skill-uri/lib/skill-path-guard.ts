import { lstat, realpath } from "node:fs/promises";
import { join as pathJoin } from "node:path";

function isWithinPrefix(prefix: string, value: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

async function getRealpathCached(cache: Map<string, string>, path: string): Promise<string> {
  const existing = cache.get(path);
  if (existing) return existing;
  const resolved = await realpath(path);
  cache.set(path, resolved);
  return resolved;
}

/**
 * Guards against symlink-based escapes from a skill root.
 *
 * This is a defense-in-depth check: even if a relative path stays within the skill root
 * lexically, symlinks inside the tree could point outside. We reject any access where an
 * existing path prefix resolves outside the skill root's realpath.
 */
export class SkillPathGuard {
  private rootRealpathCache = new Map<string, string>();

  clear(): void {
    this.rootRealpathCache.clear();
  }

  async assertNoSymlinkEscape(rootPath: string, relativePath: string): Promise<void> {
    const rootReal = await getRealpathCached(this.rootRealpathCache, rootPath);
    const segments = relativePath.split("/").filter((s) => s.length > 0);

    let cursor = rootPath;
    for (const segment of segments) {
      cursor = pathJoin(cursor, segment);
      try {
        await lstat(cursor);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            break;
          }
        }
        throw error instanceof Error ? error : new Error(String(error));
      }

      const cursorReal = await realpath(cursor);
      if (!isWithinPrefix(rootReal, cursorReal)) {
        throw new Error(`Skill path escapes root via symlink: ${relativePath}`);
      }
    }
  }
}
