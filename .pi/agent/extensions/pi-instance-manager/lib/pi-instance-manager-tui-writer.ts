import { asString } from "./pi-instance-manager-common.ts";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export type TuiWriterLease = {
  ownerId: string;
  fencingToken: string;
  managerGeneration: number;
};

const TUI_WRITER_LEASE_MS = 25_000;
const TUI_WRITER_RENEW_MS = 8_000;

function randomOwnerId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  const uuid = cryptoApi?.randomUUID?.();
  if (uuid) return uuid;
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseManagerGeneration(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

export function createTuiWriterLeaseController({
  managerRequest,
  setManagerUnavailableError,
  scheduleQueueRetry,
  onRenewAttemptFinished,
  ownerPid = process.pid,
  ownerId = randomOwnerId(),
  leaseMs = TUI_WRITER_LEASE_MS,
  renewMs = TUI_WRITER_RENEW_MS,
}: {
  managerRequest: ManagerRequestFn;
  setManagerUnavailableError: (message: string) => void;
  scheduleQueueRetry: (ms?: number) => void;
  onRenewAttemptFinished: () => void;
  ownerPid?: number;
  ownerId?: string;
  leaseMs?: number;
  renewMs?: number;
}) {
  let activeSessionId = "";
  let activeFencingToken = "";
  let renewTimer: NodeJS.Timeout | null = null;

  function ownerForSession(sessionId: string): string {
    return `pi-tui:prompt:pid=${ownerPid}:instance=${ownerId}:session=${sessionId}`;
  }

  function writerOwnerForSession(sessionId: string): string {
    return `pi-tui:writer:pid=${ownerPid}:instance=${ownerId}:session=${sessionId}`;
  }

  function stopTuiWriterRenew() {
    if (!renewTimer) return;
    clearInterval(renewTimer);
    renewTimer = null;
  }

  function clearLocalLease() {
    stopTuiWriterRenew();
    activeSessionId = "";
    activeFencingToken = "";
  }

  function startRenew(sessionId: string) {
    stopTuiWriterRenew();
    renewTimer = setInterval(() => {
      const sid = activeSessionId;
      const fence = activeFencingToken;
      if (!sid || sid !== sessionId || !fence) return;

      void managerRequest(
        "tui_writer.renew",
        {
          sessionId: sid,
          ownerId,
          fencingToken: fence,
          leaseMs,
        },
        1800,
      )
        .then((data) => {
          if (data?.renewed) {
            const nextFence = asString(data?.fencingToken).trim();
            if (nextFence) activeFencingToken = nextFence;
            setManagerUnavailableError("");
            return;
          }
          setManagerUnavailableError("tui_writer.renew rejected");
          clearLocalLease();
          scheduleQueueRetry(1200);
        })
        .catch((error) => {
          setManagerUnavailableError(`tui_writer.renew failed: ${String(error instanceof Error ? error.message : error)}`);
          scheduleQueueRetry(1200);
        })
        .finally(onRenewAttemptFinished);
    }, renewMs);
    renewTimer.unref?.();
  }

  async function acquireTuiWriterLease(sessionId: string): Promise<TuiWriterLease | null> {
    const sid = asString(sessionId).trim();
    if (!sid) return null;

    if (activeSessionId === sid && activeFencingToken) {
      return { ownerId, fencingToken: activeFencingToken, managerGeneration: 0 };
    }

    if (activeSessionId && activeSessionId !== sid) {
      await releaseTuiWriterLease();
    }

    try {
      const data = await managerRequest(
        "tui_writer.acquire",
        {
          sessionId: sid,
          ownerId,
          owner: writerOwnerForSession(sid),
          pid: ownerPid,
          leaseMs,
        },
        2200,
      );

      const fencingToken = asString(data?.fencingToken).trim();
      if (!fencingToken) {
        setManagerUnavailableError("tui_writer.acquire returned empty fencingToken");
        return null;
      }

      activeSessionId = sid;
      activeFencingToken = fencingToken;
      startRenew(sid);
      setManagerUnavailableError("");
      return {
        ownerId,
        fencingToken,
        managerGeneration: parseManagerGeneration(data?.managerGeneration),
      };
    } catch (error) {
      setManagerUnavailableError(`tui_writer.acquire failed: ${String(error instanceof Error ? error.message : error)}`);
      scheduleQueueRetry(1200);
      return null;
    }
  }

  async function releaseTuiWriterLease() {
    const sid = activeSessionId;
    const fence = activeFencingToken;
    clearLocalLease();
    if (!sid || !fence) return;

    try {
      await managerRequest(
        "tui_writer.release",
        {
          sessionId: sid,
          ownerId,
          fencingToken: fence,
        },
        1600,
      );
      setManagerUnavailableError("");
    } catch (error) {
      setManagerUnavailableError(`tui_writer.release failed: ${String(error instanceof Error ? error.message : error)}`);
    }
  }

  return {
    ownerId,
    ownerForSession,
    acquireTuiWriterLease,
    releaseTuiWriterLease,
    stopTuiWriterRenew,
  };
}
