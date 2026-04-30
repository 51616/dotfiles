import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PendingResume } from "../../lib/autockpt/autockpt-pending-resume.ts";
import { isPidAlive, type PidLockRecord } from "../../lib/autockpt/autockpt-pid-lock.ts";
import { probeCtxState } from "../../lib/autockpt/autockpt-ctx-probes.ts";

export type PendingResumeControllerDeps = {
  pid: number;

  readPending: (ctx: ExtensionContext) => PendingResume | null;
  writePending: (ctx: ExtensionContext, next: PendingResume) => void;
  clearPending: (ctx: ExtensionContext) => void;

  sessionIdFor: (ctx: ExtensionContext) => string;
  getActiveCompactionLock: (ctx: ExtensionContext) => PidLockRecord | null;
  isCheckpointAvailable: (checkpointPath: string) => boolean;

  pushDebug: (ctx: ExtensionContext, line: string) => void;
  sendUserMessage: (text: string) => void;
};

export type PendingResumeController = {
  trySend: (ctx: ExtensionContext, reason: string) => boolean;
  observeInputText: (ctx: ExtensionContext, inputText: string, source?: string) => { cleared: boolean };
};

export function createPendingResumeController(deps: PendingResumeControllerDeps): PendingResumeController {
  const trySend = (ctx: ExtensionContext, reason: string): boolean => {
    const pending = deps.readPending(ctx);
    if (!pending) return false;

    // Ownership guard: only the process that initiated compaction should resume.
    if (pending.ownerPid === undefined) {
      deps.pushDebug(ctx, "pending resume missing ownerPid; clearing");
      deps.clearPending(ctx);
      return false;
    }
    let ownerPid = pending.ownerPid;
    if (pending.ownerPid !== deps.pid) {
      const alive = isPidAlive(pending.ownerPid);
      if (alive !== false) return false;
      deps.pushDebug(ctx, `taking over pending resume from dead ownerPid=${pending.ownerPid}`);
      ownerPid = deps.pid;
    }

    const sid = deps.sessionIdFor(ctx);
    if (sid) {
      if (pending.sessionId === undefined || pending.sessionId !== sid) return false;
    }

    // If the checkpoint file is gone, the pending record is useless and can cause confusing self-pings.
    // In pi-ssh mode the checkpoint may exist only on the remote workspace, so use the injected
    // checkpoint-availability probe instead of a local fs existence check.
    if (!deps.isCheckpointAvailable(pending.checkpointPath)) {
      deps.pushDebug(ctx, `stale pending resume: missing checkpoint file (${pending.checkpointPath}); clearing`);
      deps.clearPending(ctx);
      return false;
    }

    const lock = deps.getActiveCompactionLock(ctx);
    if (lock && lock.pid !== deps.pid) return false;

    const { isIdle, hasPendingMessages } = probeCtxState(ctx);
    if (!isIdle) return false;
    if (hasPendingMessages) return false;

    // Avoid spamming in case of a weird loop.
    const t = Date.now();
    if (pending.lastSentAt && t - pending.lastSentAt < 1500) return false;

    const next: PendingResume = {
      ...pending,
      ownerPid,
      attempts: (pending.attempts || 0) + 1,
      lastSentAt: t,
    };
    deps.writePending(ctx, next);

    deps.pushDebug(ctx, `sending pending resume (reason=${reason}, attempts=${next.attempts})`);
    deps.sendUserMessage(next.resumeText);
    return true;
  };

  const observeInputText = (ctx: ExtensionContext, inputText: string, source?: string) => {
    const pending = deps.readPending(ctx);
    if (!pending) return { cleared: false };

    if (inputText === pending.resumeText) {
      deps.pushDebug(
        ctx,
        `pending resume observed in input pipeline (source=${String(source || "?")}); clearing (${pending.checkpointPath})`,
      );
      deps.clearPending(ctx);
      return { cleared: true };
    }

    return { cleared: false };
  };

  return { trySend, observeInputText };
}
