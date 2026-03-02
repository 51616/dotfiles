import { asString, LOCK_WAIT_TIMEOUT_MS } from "./pi-instance-manager-common.ts";

type TurnTicketOp = "turn.done" | "turn.cancel";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export function createTurnTicketClient({
  managerRequest,
  setManagerUnavailableError,
  scheduleQueueRetry,
  lockWaitTimeoutMs = LOCK_WAIT_TIMEOUT_MS,
  ownerPid = process.pid,
}: {
  managerRequest: ManagerRequestFn;
  setManagerUnavailableError: (message: string) => void;
  scheduleQueueRetry: (ms?: number) => void;
  lockWaitTimeoutMs?: number;
  ownerPid?: number;
}) {
  async function enqueueTurnTicket(sessionId: string, text: string): Promise<string> {
    const sid = asString(sessionId).trim();
    if (!sid) return "";

    const owner = `pi-tui:prompt:pid=${ownerPid}:session=${sid}`;
    try {
      const data = await managerRequest(
        "turn.enqueue",
        {
          sessionId: sid,
          owner,
          pid: ownerPid,
          preview: text,
        },
        2200,
      );
      const ticketId = asString(data?.ticketId).trim();
      if (!ticketId) {
        setManagerUnavailableError("turn.enqueue returned empty ticketId");
        return "";
      }
      setManagerUnavailableError("");
      return ticketId;
    } catch (error) {
      setManagerUnavailableError(`turn.enqueue failed: ${String(error?.message || error)}`);
      scheduleQueueRetry(1200);
      return "";
    }
  }

  async function waitForTurnGrant(ticketId: string): Promise<{ granted: boolean; waited: boolean }> {
    const tid = asString(ticketId).trim();
    if (!tid) return { granted: false, waited: false };

    const deadline = Date.now() + lockWaitTimeoutMs;
    let waited = false;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setManagerUnavailableError(`turn.wait timed out (ticket=${tid})`);
        scheduleQueueRetry(1200);
        return { granted: false, waited };
      }

      const slice = Math.min(remaining, 15_000);
      try {
        const data = await managerRequest("turn.wait", { ticketId: tid, timeoutMs: slice }, slice + 1200);
        if (data?.granted) {
          setManagerUnavailableError("");
          return { granted: true, waited };
        }
        waited = true;
      } catch (error) {
        const message = String(error?.message || error);
        if (message === "timeout") {
          waited = true;
          continue;
        }

        if (message.includes("unknown ticket")) {
          setManagerUnavailableError(`turn.wait unknown ticket: ${tid}`);
          return { granted: false, waited };
        }

        setManagerUnavailableError(`turn.wait failed: ${message}`);
        scheduleQueueRetry(1200);
        return { granted: false, waited };
      }
    }
  }

  async function finishTurnTicket(ticketId: string, op: TurnTicketOp) {
    const tid = asString(ticketId).trim();
    if (!tid) return;
    try {
      await managerRequest(op, { ticketId: tid }, 1800);
      setManagerUnavailableError("");
    } catch (error) {
      setManagerUnavailableError(`${op} failed: ${String(error?.message || error)}`);
      scheduleQueueRetry(1200);
    }
  }

  return {
    enqueueTurnTicket,
    waitForTurnGrant,
    finishTurnTicket,
  };
}
