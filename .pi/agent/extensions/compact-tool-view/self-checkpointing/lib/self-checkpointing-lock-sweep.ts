import { readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isPidLockStale, readPidLock } from "../../lib/autockpt/autockpt-pid-lock.ts";

export function cleanupStaleCompactionLocksInStateDir(opts: {
  ctx: ExtensionContext;
  pendingDir: string;
  lockMaxAgeMs: number;
  pushDebug: (ctx: ExtensionContext, line: string) => void;
  source: string;
}) {
  const { ctx, pendingDir, lockMaxAgeMs, pushDebug, source } = opts;

  let removed = 0;

  try {
    const names = readdirSync(pendingDir);
    for (const name of names) {
      if (!name.startsWith("compaction.") || !name.endsWith(".lock.json")) continue;
      const lockPath = path.join(pendingDir, name);

      const lock = readPidLock(lockPath);
      if (!lock) {
        // Avoid racing with a lock file that is being created right now.
        try {
          const st = statSync(lockPath);
          if (Date.now() - st.mtimeMs < 5_000) continue;
        } catch {
          // If we can't stat it, err on the side of leaving it in place.
          continue;
        }

        try {
          unlinkSync(lockPath);
          removed += 1;
        } catch {
          // ignore
        }
        continue;
      }

      if (!isPidLockStale(lock, lockMaxAgeMs)) continue;

      try {
        unlinkSync(lockPath);
        removed += 1;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  if (removed) {
    pushDebug(ctx, `cleaned ${removed} stale compaction lock file(s) (source=${source})`);
  }
}
