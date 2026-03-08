import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  clearPendingResume,
  readPendingResume,
  type PendingResume,
  writePendingResume,
} from "../../lib/autockpt/autockpt-pending-resume.ts";
import {
  clearStalePidLock,
  isPidLockStale,
  readPidLock,
  releasePidLock,
  tryAcquirePidLock,
  type PidLockRecord,
} from "../../lib/autockpt/autockpt-pid-lock.ts";

export type SelfCheckpointingSessionStore = {
  sessionIdFor: (ctx: ExtensionContext) => string;

  pendingResumePathFor: (ctx: ExtensionContext) => string;
  compactionLockPathFor: (ctx: ExtensionContext) => string;

  readPending: (ctx: ExtensionContext) => PendingResume | null;
  writePending: (ctx: ExtensionContext, p: PendingResume) => void;
  clearPending: (ctx: ExtensionContext) => void;

  getActiveCompactionLock: (ctx: ExtensionContext) => PidLockRecord | null;
  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath?: string, note?: string) => boolean;
  releaseCompactionLock: (ctx: ExtensionContext, reason: string) => void;

  cleanupLockOnSessionStart: (ctx: ExtensionContext) => void;
  cleanupLockOnShutdown: (ctx: ExtensionContext) => void;
};

export function createSelfCheckpointingSessionStore(opts: {
  pendingDir: string;
  pendingResumePathOverride: string;
  compactionLockPathOverride: string;
  lockMaxAgeMs: number;
  pushDebug: (ctx: ExtensionContext, line: string) => void;
  isDebugEnabled: () => boolean;
}) : SelfCheckpointingSessionStore {
  const {
    pendingDir,
    pendingResumePathOverride,
    compactionLockPathOverride,
    lockMaxAgeMs,
    pushDebug,
    isDebugEnabled,
  } = opts;

  const sessionIdFor = (ctx: ExtensionContext): string => {
    try {
      // Some unit-ish tests stub a minimal ctx without sessionManager.
      const sid = (ctx as any)?.sessionManager?.getSessionId?.();
      return String(sid || "").trim();
    } catch {
      return "";
    }
  };

  const sessionHashFor = (ctx: ExtensionContext): string => {
    const sid = sessionIdFor(ctx);
    const basis = sid || `no-session:${process.pid}`;
    return createHash("sha1").update(basis).digest("hex").slice(0, 12);
  };

  const pendingResumePathFor = (ctx: ExtensionContext): string => {
    if (pendingResumePathOverride) return pendingResumePathOverride;
    return path.join(pendingDir, `pending-resume.${sessionHashFor(ctx)}.json`);
  };

  const compactionLockPathFor = (ctx: ExtensionContext): string => {
    if (compactionLockPathOverride) return compactionLockPathOverride;
    return path.join(pendingDir, `compaction.${sessionHashFor(ctx)}.lock.json`);
  };

  let compactionLockHeld: PidLockRecord | null = null;
  let compactionLockHeldPath: string | null = null;

  const getActiveCompactionLock = (ctx: ExtensionContext): PidLockRecord | null => {
    const lockPath = compactionLockPathFor(ctx);
    const lock = readPidLock(lockPath);
    if (!lock) return null;

    if (isPidLockStale(lock, lockMaxAgeMs)) {
      clearStalePidLock(lockPath, lockMaxAgeMs);
      return null;
    }

    return lock;
  };

  const readPending = (ctx: ExtensionContext): PendingResume | null =>
    readPendingResume(pendingResumePathFor(ctx));

  const writePending = (ctx: ExtensionContext, p: PendingResume) => {
    writePendingResume(pendingResumePathFor(ctx), p);
  };

  const clearPending = (ctx: ExtensionContext) => {
    clearPendingResume(pendingResumePathFor(ctx));
  };

  const releaseCompactionLock = (ctx: ExtensionContext, reason: string) => {
    if (!compactionLockHeld && !compactionLockHeldPath) return;

    const lockPath = compactionLockHeldPath ?? compactionLockPathFor(ctx);
    const ok = releasePidLock(lockPath, process.pid);
    pushDebug(ctx, `compaction lock released ok=${ok} reason=${reason}`);
    compactionLockHeld = null;
    compactionLockHeldPath = null;
  };

  const ensureCompactionLock = (
    ctx: ExtensionContext,
    checkpointPath?: string,
    note: string = "pi-self-checkpointing compaction owner lock",
  ): boolean => {
    const lockPath = compactionLockPathFor(ctx);

    const active = getActiveCompactionLock(ctx);
    if (active && active.pid === process.pid) {
      compactionLockHeld = active;
      compactionLockHeldPath = lockPath;
      return true;
    }

    const res = tryAcquirePidLock(lockPath, {
      maxAgeMs: lockMaxAgeMs,
      checkpointPath,
      note,
    });

    if (!res.acquired) {
      if (isDebugEnabled()) pushDebug(ctx, `compaction lock not acquired (${res.reason})`);
      return false;
    }

    compactionLockHeld = res.record;
    compactionLockHeldPath = lockPath;
    return true;
  };

  const cleanupLockOnSessionStart = (ctx: ExtensionContext) => {
    const lockPath = compactionLockPathFor(ctx);
    clearStalePidLock(lockPath, lockMaxAgeMs);
    releasePidLock(lockPath, process.pid);
    compactionLockHeld = null;
    compactionLockHeldPath = null;
  };

  const cleanupLockOnShutdown = (ctx: ExtensionContext) => {
    try {
      releasePidLock(compactionLockPathFor(ctx), process.pid);
    } catch {
      // ignore
    }

    compactionLockHeld = null;
    compactionLockHeldPath = null;
  };

  return {
    sessionIdFor,
    pendingResumePathFor,
    compactionLockPathFor,
    readPending,
    writePending,
    clearPending,
    getActiveCompactionLock,
    ensureCompactionLock,
    releaseCompactionLock,
    cleanupLockOnSessionStart,
    cleanupLockOnShutdown,
  };
}
