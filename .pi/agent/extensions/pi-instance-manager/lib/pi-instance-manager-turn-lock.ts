import {
  asString,
  LOCK_WAIT_TIMEOUT_MS,
  TURN_LOCK_LEASE_MS,
  TURN_LOCK_RENEW_MS,
} from "./pi-instance-manager-common.ts";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

function parseManagerGeneration(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

export function createTurnLockController({
  managerRequest,
  getActiveTurnLockToken,
  setActiveTurnLockToken,
  getActiveTurnLockFencingToken,
  setActiveTurnLockFencingToken,
  getActiveTurnLockSessionId,
  setActiveTurnLockSessionId,
  setAwaitingTurnEnd,
  clearActiveTurnText,
  setManagerUnavailableError,
  scheduleQueueRetry,
  onRenewAttemptFinished,
  lockWaitTimeoutMs = LOCK_WAIT_TIMEOUT_MS,
  turnLockLeaseMs = TURN_LOCK_LEASE_MS,
  turnLockRenewMs = TURN_LOCK_RENEW_MS,
  ownerPid = process.pid,
}: {
  managerRequest: ManagerRequestFn;
  getActiveTurnLockToken: () => string;
  setActiveTurnLockToken: (value: string) => void;
  getActiveTurnLockFencingToken: () => string;
  setActiveTurnLockFencingToken: (value: string) => void;
  getActiveTurnLockSessionId: () => string;
  setActiveTurnLockSessionId: (value: string) => void;
  setAwaitingTurnEnd: (value: boolean) => void;
  clearActiveTurnText: () => void;
  setManagerUnavailableError: (message: string) => void;
  scheduleQueueRetry: (ms?: number) => void;
  onRenewAttemptFinished: () => void;
  lockWaitTimeoutMs?: number;
  turnLockLeaseMs?: number;
  turnLockRenewMs?: number;
  ownerPid?: number;
}) {
  let turnLockRenewTimer: NodeJS.Timeout | null = null;

  function stopTurnLockRenew() {
    if (!turnLockRenewTimer) return;
    clearInterval(turnLockRenewTimer);
    turnLockRenewTimer = null;
  }

  function startTurnLockRenew(token: string, fencingToken: string, sessionId: string, owner: string) {
    stopTurnLockRenew();

    turnLockRenewTimer = setInterval(() => {
      if (!getActiveTurnLockToken() || getActiveTurnLockToken() !== token || getActiveTurnLockSessionId() !== sessionId) return;

      const payload: Record<string, unknown> = { token, leaseMs: turnLockLeaseMs };
      const currentFence = asString(getActiveTurnLockFencingToken() || fencingToken).trim();
      if (currentFence) payload.fencingToken = currentFence;

      void managerRequest("lock.renew", payload, 3500)
        .then((data) => {
          if (data?.renewed) {
            const nextFence = asString(data?.fencingToken).trim();
            if (nextFence) setActiveTurnLockFencingToken(nextFence);
            setManagerUnavailableError("");
            return;
          }
          setManagerUnavailableError(`lock.renew rejected (owner=${owner}, generation=${parseManagerGeneration(data?.managerGeneration) || "unknown"})`);
          scheduleQueueRetry(1200);
        })
        .catch((error) => {
          setManagerUnavailableError(`lock.renew failed: ${String(error instanceof Error ? error.message : error)}`);
          scheduleQueueRetry(1200);
        })
        .finally(() => {
          onRenewAttemptFinished();
        });
    }, turnLockRenewMs);

    turnLockRenewTimer.unref?.();
  }

  async function releaseTurnLock() {
    const token = getActiveTurnLockToken();
    const fencingToken = getActiveTurnLockFencingToken();
    setActiveTurnLockToken("");
    setActiveTurnLockFencingToken("");
    setActiveTurnLockSessionId("");
    setAwaitingTurnEnd(false);
    clearActiveTurnText();
    stopTurnLockRenew();

    if (!token) return;

    try {
      const payload: Record<string, unknown> = { token };
      if (fencingToken) payload.fencingToken = fencingToken;
      await managerRequest("lock.release", payload, 1600);
      setManagerUnavailableError("");
    } catch (error) {
      setManagerUnavailableError(`lock.release failed: ${String(error instanceof Error ? error.message : error)}`);
      scheduleQueueRetry(1200);
    }
  }

  function adoptTurnLock({
    sessionId,
    token,
    fencingToken,
    owner,
  }: {
    sessionId: string;
    token: string;
    fencingToken: string;
    owner: string;
  }): boolean {
    const sid = asString(sessionId).trim();
    const lockToken = asString(token).trim();
    const fence = asString(fencingToken).trim();
    if (!sid || !lockToken || !fence) return false;

    setActiveTurnLockToken(lockToken);
    setActiveTurnLockFencingToken(fence);
    setActiveTurnLockSessionId(sid);
    startTurnLockRenew(lockToken, fence, sid, asString(owner).trim() || `pi-tui:prompt:pid=${ownerPid}:session=${sid}`);
    return true;
  }

  async function acquireTurnLock(
    sessionId: string,
  ): Promise<{ token: string; fencingToken: string; managerGeneration: number; waited: boolean }> {
    const sid = asString(sessionId).trim();
    if (!sid) return { token: "", fencingToken: "", managerGeneration: 0, waited: false };

    const owner = `pi-tui:prompt:pid=${ownerPid}:session=${sid}`;
    const deadline = Date.now() + lockWaitTimeoutMs;
    let waited = false;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setManagerUnavailableError("lock.acquire timed out");
        scheduleQueueRetry(1500);
        return { token: "", fencingToken: "", managerGeneration: 0, waited };
      }

      const slice = Math.min(remaining, 15_000);

      try {
        const data = await managerRequest(
          "lock.acquire",
          {
            sessionId: sid,
            owner,
            pid: ownerPid,
            leaseMs: turnLockLeaseMs,
            timeoutMs: slice,
          },
          slice + 1200,
        );

        const token = asString(data?.token).trim();
        const fencingToken = asString(data?.fencingToken).trim();
        const managerGeneration = parseManagerGeneration(data?.managerGeneration);
        if (token) {
          setManagerUnavailableError("");
          setActiveTurnLockToken(token);
          setActiveTurnLockFencingToken(fencingToken);
          setActiveTurnLockSessionId(sid);
          startTurnLockRenew(token, fencingToken, sid, owner);
          return { token, fencingToken, managerGeneration, waited };
        }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (message === "timeout") {
          // Expected while waiting in manager FIFO queue.
          waited = true;
          continue;
        }

        setManagerUnavailableError(message);
        scheduleQueueRetry(1200);
        return { token: "", fencingToken: "", managerGeneration: 0, waited };
      }
    }
  }

  return {
    stopTurnLockRenew,
    releaseTurnLock,
    acquireTurnLock,
    adoptTurnLock,
  };
}
