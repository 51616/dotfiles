import { asString, LOCK_WAIT_TIMEOUT_MS } from "./pi-instance-manager-common.ts";

type TurnTicketOp = "turn.done" | "turn.cancel";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export type TurnTicketHandle = {
  ticketId: string;
  fencingToken: string;
  managerGeneration: number;
};

function parseManagerGeneration(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

export function createTurnTicketClient({
  managerRequest,
  setManagerUnavailableError,
  scheduleQueueRetry,
  getTuiWriterLease,
  buildTuiOwner,
  lockWaitTimeoutMs = LOCK_WAIT_TIMEOUT_MS,
  ownerPid = process.pid,
}: {
  managerRequest: ManagerRequestFn;
  setManagerUnavailableError: (message: string) => void;
  scheduleQueueRetry: (ms?: number) => void;
  getTuiWriterLease: (sessionId: string) => Promise<{ ownerId: string; fencingToken: string } | null>;
  buildTuiOwner: (sessionId: string) => string;
  lockWaitTimeoutMs?: number;
  ownerPid?: number;
}) {
  async function enqueueTurnTicket(sessionId: string, text: string): Promise<TurnTicketHandle | null> {
    const sid = asString(sessionId).trim();
    if (!sid) return null;

    const owner = buildTuiOwner(sid) || `pi-tui:prompt:pid=${ownerPid}:session=${sid}`;
    const writerLease = await getTuiWriterLease(sid);
    if (!writerLease) return null;

    try {
      const data = await managerRequest(
        "turn.enqueue",
        {
          sessionId: sid,
          owner,
          pid: ownerPid,
          preview: text,
          writerOwnerId: writerLease.ownerId,
          writerFencingToken: writerLease.fencingToken,
        },
        2200,
      );
      const ticketId = asString(data?.ticketId).trim();
      if (!ticketId) {
        setManagerUnavailableError("turn.enqueue returned empty ticketId");
        return null;
      }
      setManagerUnavailableError("");
      return {
        ticketId,
        fencingToken: asString(data?.fencingToken).trim(),
        managerGeneration: parseManagerGeneration(data?.managerGeneration),
      };
    } catch (error) {
      setManagerUnavailableError(`turn.enqueue failed: ${String(error instanceof Error ? error.message : error)}`);
      scheduleQueueRetry(1200);
      return null;
    }
  }

  async function waitForTurnGrant(
    ticketId: string,
    fencingToken = "",
  ): Promise<{ granted: boolean; waited: boolean; managerGeneration: number; fencingToken: string }> {
    const tid = asString(ticketId).trim();
    const fence = asString(fencingToken).trim();
    if (!tid) return { granted: false, waited: false, managerGeneration: 0, fencingToken: fence };

    const deadline = Date.now() + lockWaitTimeoutMs;
    let waited = false;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setManagerUnavailableError(`turn.wait timed out (ticket=${tid})`);
        scheduleQueueRetry(1200);
        return { granted: false, waited, managerGeneration: 0, fencingToken: fence };
      }

      const slice = Math.min(remaining, 15_000);
      try {
        const payload: Record<string, unknown> = { ticketId: tid, timeoutMs: slice };
        if (fence) payload.fencingToken = fence;
        const data = await managerRequest("turn.wait", payload, slice + 1200);
        if (data?.granted) {
          setManagerUnavailableError("");
          return {
            granted: true,
            waited,
            managerGeneration: parseManagerGeneration(data?.managerGeneration),
            fencingToken: asString(data?.fencingToken).trim() || fence,
          };
        }
        waited = true;
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (message === "timeout") {
          waited = true;
          continue;
        }

        if (message.includes("unknown ticket")) {
          setManagerUnavailableError(`turn.wait unknown ticket: ${tid}`);
          return { granted: false, waited, managerGeneration: 0, fencingToken: fence };
        }

        setManagerUnavailableError(`turn.wait failed: ${message}`);
        scheduleQueueRetry(1200);
        return { granted: false, waited, managerGeneration: 0, fencingToken: fence };
      }
    }
  }

  async function finishTurnTicket(ticketId: string, op: TurnTicketOp, fencingToken = "") {
    const tid = asString(ticketId).trim();
    const fence = asString(fencingToken).trim();
    if (!tid) return;
    try {
      const payload: Record<string, unknown> = { ticketId: tid };
      if (fence) payload.fencingToken = fence;
      await managerRequest(op, payload, 1800);
      setManagerUnavailableError("");
    } catch (error) {
      setManagerUnavailableError(`${op} failed: ${String(error instanceof Error ? error.message : error)}`);
      scheduleQueueRetry(1200);
    }
  }

  return {
    enqueueTurnTicket,
    waitForTurnGrant,
    finishTurnTicket,
  };
}
