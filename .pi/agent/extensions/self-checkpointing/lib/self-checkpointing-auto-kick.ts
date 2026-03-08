import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PidLockRecord } from "../../lib/autockpt/autockpt-pid-lock.ts";
import { shouldTimeoutAutoKick } from "../../lib/autockpt/autockpt-auto-kick-timeout.ts";
import { probeCtxState } from "../../lib/autockpt/autockpt-ctx-probes.ts";

export type AutoKickControllerDeps = {
  pi: Pick<ExtensionAPI, "sendMessage">;
  pid: number;
  customType: string;

  maxAgeMs: number;
  minIntervalMs: number;
  attemptLimit: number;

  buildDirectiveMessage: () => any;

  getHandledThisTurn: () => boolean;
  getPendingCompactionRequested: () => boolean;
  setArmed: (next: boolean) => void;

  setCheckpointCycleActive: (ctx: ExtensionContext, active: boolean) => void;
  setStatus: (ctx: ExtensionContext, text?: string) => void;
  pushDebug: (ctx: ExtensionContext, line: string) => void;

  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath?: string, note?: string) => boolean;
  releaseCompactionLock: (ctx: ExtensionContext, reason: string) => void;
  getActiveCompactionLock: (ctx: ExtensionContext) => PidLockRecord | null;
};

export type AutoKickController = {
  isInFlight: () => boolean;

  resetForSessionStart: () => void;
  markFooterMatched: () => void;

  bumpActivity: () => void;

  clearInFlight: (ctx: ExtensionContext, reason: string) => void;
  maybeClearStale: (ctx: ExtensionContext, source: string) => boolean;

  start: (ctx: ExtensionContext, reason: string) => boolean;
};

export function createAutoKickController(deps: AutoKickControllerDeps): AutoKickController {
  let inFlight = false;
  let startedAtMs: number | undefined;
  let lastActivityAtMs: number | undefined;
  let attempts = 0;
  let lastKickAtMs = 0;

  const isInFlight = () => inFlight;

  const resetForSessionStart = () => {
    inFlight = false;
    startedAtMs = undefined;
    lastActivityAtMs = undefined;
    attempts = 0;
    lastKickAtMs = 0;
  };

  // When we see a valid footer, the current cycle is complete.
  // Reset attempts so future cycles aren’t blocked by prior failures.
  const markFooterMatched = () => {
    inFlight = false;
    startedAtMs = undefined;
    lastActivityAtMs = undefined;
    attempts = 0;
  };

  const bumpActivity = () => {
    if (!inFlight) return;
    lastActivityAtMs = Date.now();
  };

  const clearInFlight = (ctx: ExtensionContext, reason: string) => {
    if (!inFlight) return;

    deps.pushDebug(ctx, `auto-kick clearing in-flight state (reason=${reason})`);

    inFlight = false;
    startedAtMs = undefined;
    lastActivityAtMs = undefined;

    // Release the compaction owner lock so future attempts aren't blocked.
    deps.releaseCompactionLock(ctx, `auto_kick_clear:${reason}`);

    // Stamp muting should reflect the remaining checkpoint-cycle state.
    deps.setCheckpointCycleActive(ctx, deps.getPendingCompactionRequested());
  };

  const maybeClearStale = (ctx: ExtensionContext, source: string): boolean => {
    if (!inFlight) return false;

    // If another process owns the compaction lock now, we can’t continue this cycle.
    const lock = deps.getActiveCompactionLock(ctx);
    if (lock && lock.pid !== deps.pid) {
      deps.pushDebug(ctx, `auto-kick aborted: compaction lock held by pid ${lock.pid} (source=${source})`);
      clearInFlight(ctx, `lock_lost:${source}`);
      return true;
    }

    const startedAt = startedAtMs ?? 0;
    if (!startedAt) {
      deps.pushDebug(ctx, `auto-kick aborted: missing startedAt (source=${source})`);
      clearInFlight(ctx, `missing_startedAt:${source}`);
      return true;
    }

    const { isIdle, hasPendingMessages } = probeCtxState(ctx);
    const canTimeout = isIdle && !hasPendingMessages;

    const nowMs = Date.now();
    if (
      shouldTimeoutAutoKick({
        nowMs,
        startedAtMs: startedAt,
        lastActivityAtMs,
        maxAgeMs: deps.maxAgeMs,
        canTimeout,
      })
    ) {
      const basis = lastActivityAtMs ?? startedAt;
      const ageMs = nowMs - basis;
      deps.pushDebug(
        ctx,
        `auto-kick timeout ageMs=${ageMs} (source=${source}, isIdle=${isIdle}, hasPendingMessages=${hasPendingMessages})`,
      );
      clearInFlight(ctx, `timeout:${source}`);
      return true;
    }

    return false;
  };

  const start = (ctx: ExtensionContext, reason: string): boolean => {
    if (deps.getHandledThisTurn()) return false;
    if (deps.getPendingCompactionRequested()) return false;

    const now = Date.now();
    if (now - lastKickAtMs < deps.minIntervalMs) return false;
    if (inFlight) return false;

    if (attempts >= deps.attemptLimit) {
      deps.setStatus(ctx, "| Checkpoint: auto-kick failed (needs manual) 🔴");
      deps.pushDebug(ctx, `auto-kick giving up after ${attempts} attempts`);
      return false;
    }

    // Claim ownership early: the process that injects the steering directive is the one
    // that must later run compaction+resume.
    if (!deps.ensureCompactionLock(ctx, undefined, `pi-self-checkpointing autoKick (reason=${reason})`)) {
      const lock = deps.getActiveCompactionLock(ctx);
      if (lock && lock.pid !== deps.pid) {
        deps.setStatus(ctx, `| Checkpoint: owned by pid ${lock.pid} 🟡`);
      }
      return false;
    }

    inFlight = true;
    startedAtMs = now;
    lastActivityAtMs = now;
    attempts += 1;
    lastKickAtMs = now;

    deps.setCheckpointCycleActive(ctx, true);
    deps.setArmed(false);

    deps.pushDebug(ctx, `auto-kick injecting directive (reason=${reason}, attempt=${attempts})`);
    deps.setStatus(ctx, "| Checkpoint: writing checkpoint… 🟡");

    // Deliver as "steer" so we can interrupt an in-flight agent run.
    // If the agent is idle, triggerTurn ensures we start a turn immediately.
    try {
      deps.pi.sendMessage(
        {
          customType: deps.customType,
          content: deps.buildDirectiveMessage(),
          display: true,
          details: { reason, attempt: attempts },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch (err: any) {
      const msgRaw = String(err?.message || err || "unknown error");
      const msg = msgRaw.replace(/\s+/g, " ").trim().slice(0, 120);

      deps.pushDebug(ctx, `auto-kick sendMessage threw: ${msg}`);
      deps.setStatus(ctx, `| Checkpoint: auto-kick failed (${msg}) 🔴`);
      clearInFlight(ctx, `sendMessage_throw:${reason}`);
      return false;
    }

    return true;
  };

  return {
    isInFlight,
    resetForSessionStart,
    markFooterMatched,
    bumpActivity,
    clearInFlight,
    maybeClearStale,
    start,
  };
}
