import {
  asString,
  LOCK_WAIT_TIMEOUT_MS,
  TURN_LOCK_LEASE_MS,
  TURN_LOCK_RENEW_MS,
} from "./pi-instance-manager-common.ts";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export function createTurnLockController({
  managerRequest,
  getActiveTurnLockToken,
  setActiveTurnLockToken,
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

  function startTurnLockRenew(token: string, sessionId: string, owner: string) {
    stopTurnLockRenew();

    turnLockRenewTimer = setInterval(() => {
      if (!getActiveTurnLockToken() || getActiveTurnLockToken() !== token || getActiveTurnLockSessionId() !== sessionId) return;

      void managerRequest("lock.renew", { token, leaseMs: turnLockLeaseMs }, 3500)
        .then((data) => {
          if (data?.renewed) {
            setManagerUnavailableError("");
            return;
          }
          setManagerUnavailableError(`lock.renew rejected (owner=${owner})`);
          scheduleQueueRetry(1200);
        })
        .catch((error) => {
          setManagerUnavailableError(`lock.renew failed: ${String(error?.message || error)}`);
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
    setActiveTurnLockToken("");
    setActiveTurnLockSessionId("");
    setAwaitingTurnEnd(false);
    clearActiveTurnText();
    stopTurnLockRenew();

    if (!token) return;

    try {
      await managerRequest("lock.release", { token }, 1600);
      setManagerUnavailableError("");
    } catch (error) {
      setManagerUnavailableError(`lock.release failed: ${String(error?.message || error)}`);
      scheduleQueueRetry(1200);
    }
  }

  async function acquireTurnLock(sessionId: string): Promise<{ token: string; waited: boolean }> {
    const sid = asString(sessionId).trim();
    if (!sid) return { token: "", waited: false };

    const owner = `pi-tui:prompt:pid=${ownerPid}:session=${sid}`;
    const deadline = Date.now() + lockWaitTimeoutMs;
    let waited = false;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setManagerUnavailableError("lock.acquire timed out");
        scheduleQueueRetry(1500);
        return { token: "", waited };
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
        if (token) {
          setManagerUnavailableError("");
          setActiveTurnLockToken(token);
          setActiveTurnLockSessionId(sid);
          startTurnLockRenew(token, sid, owner);
          return { token, waited };
        }
      } catch (error) {
        const message = String(error?.message || error);
        if (message === "timeout") {
          // Expected while waiting in manager FIFO queue.
          waited = true;
          continue;
        }

        setManagerUnavailableError(message);
        scheduleQueueRetry(1200);
        return { token: "", waited };
      }
    }
  }

  return {
    stopTurnLockRenew,
    releaseTurnLock,
    acquireTurnLock,
  };
}
