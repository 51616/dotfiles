import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type PidLockRecord = {
  v: 1;
  pid: number;
  createdAt: number;
  checkpointPath?: string;
  note?: string;
};

function toPidLockRecord(value: unknown): PidLockRecord | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Record<string, unknown>;

  const pid = Number(parsed.pid);
  const createdAt = Number(parsed.createdAt);

  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

  const checkpointPath = typeof parsed.checkpointPath === "string" ? parsed.checkpointPath : undefined;
  const note = typeof parsed.note === "string" ? parsed.note : undefined;

  return {
    v: 1,
    pid,
    createdAt,
    checkpointPath: checkpointPath?.trim() ? checkpointPath.trim() : undefined,
    note: note?.trim() ? note.trim() : undefined,
  };
}

export function readPidLock(lockPath: string): PidLockRecord | null {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = String(readFileSync(lockPath, "utf8") || "");
    const parsed = JSON.parse(raw);
    return toPidLockRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Returns:
 * - true  => process exists (or we lack permission to signal it)
 * - false => process definitely not running
 * - null  => unknown / environment limitation
 */
export function isPidAlive(pid: number): boolean | null {
  try {
    // Signal 0 does not actually send a signal, it just performs error checking.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    const code = String(err?.code || "");
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

export function isPidLockStale(lock: PidLockRecord, maxAgeMs: number): boolean {
  const alive = isPidAlive(lock.pid);
  if (alive === false) return true;

  // Only fall back to age-based staleness when liveness is unknown.
  if (alive === null) {
    const ageMs = Date.now() - lock.createdAt;
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && ageMs > maxAgeMs) return true;
  }

  return false;
}

export function clearStalePidLock(lockPath: string, maxAgeMs: number): boolean {
  const lock = readPidLock(lockPath);
  if (!lock) return false;
  if (!isPidLockStale(lock, maxAgeMs)) return false;

  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export type AcquirePidLockResult =
  | {
      acquired: true;
      record: PidLockRecord;
    }
  | {
      acquired: false;
      record: PidLockRecord | null;
      reason: string;
    };

export function tryAcquirePidLock(
  lockPath: string,
  opts: {
    maxAgeMs: number;
    checkpointPath?: string;
    note?: string;
  },
): AcquirePidLockResult {
  const { maxAgeMs, checkpointPath, note } = opts;

  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // ignore
  }

  const record: PidLockRecord = {
    v: 1,
    pid: process.pid,
    createdAt: Date.now(),
    checkpointPath,
    note,
  };

  const attempt = (): AcquirePidLockResult => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, JSON.stringify(record, null, 2), "utf8");
      } finally {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      return { acquired: true, record };
    } catch (err: any) {
      const code = String(err?.code || "");
      if (code !== "EEXIST") {
        return { acquired: false, record: null, reason: `open_failed:${code || "unknown"}` };
      }

      const existing = readPidLock(lockPath);
      if (existing && isPidLockStale(existing, maxAgeMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        // one retry after stale cleanup
        try {
          const fd2 = openSync(lockPath, "wx");
          try {
            writeFileSync(fd2, JSON.stringify(record, null, 2), "utf8");
          } finally {
            try {
              closeSync(fd2);
            } catch {
              // ignore
            }
          }
          return { acquired: true, record };
        } catch (err2: any) {
          const code2 = String(err2?.code || "");
          return { acquired: false, record: readPidLock(lockPath), reason: `retry_failed:${code2 || "unknown"}` };
        }
      }

      return {
        acquired: false,
        record: existing,
        reason: existing ? `held_by_pid:${existing.pid}` : "held_unknown",
      };
    }
  };

  // NOTE: this is synchronous by design.
  return attempt();
}

export function releasePidLock(lockPath: string, expectedPid: number): boolean {
  try {
    const lock = readPidLock(lockPath);
    if (!lock) return true;
    if (lock.pid !== expectedPid) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
