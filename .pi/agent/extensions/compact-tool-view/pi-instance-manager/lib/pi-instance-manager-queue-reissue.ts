import { asString } from "./pi-instance-manager-common.ts";
import type { SessionInputQueue } from "./pi-instance-manager-queue.ts";

export async function reissueQueueTickets({
  queue,
  sessionId,
  nextItems,
  enqueueTurnTicket,
  finishTurnTicket,
  nowMs = () => Date.now(),
}: {
  queue: SessionInputQueue;
  sessionId: string;
  nextItems: Array<{ text: string; owner?: string }>;
  enqueueTurnTicket: (sessionId: string, text: string) => Promise<string>;
  finishTurnTicket: (ticketId: string, op: "turn.cancel" | "turn.done") => Promise<void>;
  nowMs?: () => number;
}): Promise<boolean> {
  const sid = asString(sessionId).trim();
  if (!sid) return false;

  const rebuilt: Array<{ ticketId: string; text: string; queuedAt: number; owner?: string }> = [];
  for (const item of nextItems) {
    const ticketId = await enqueueTurnTicket(sid, item.text);
    if (!ticketId) {
      for (const created of rebuilt) {
        await finishTurnTicket(created.ticketId, "turn.cancel");
      }
      return false;
    }
    rebuilt.push({
      ticketId,
      text: item.text,
      queuedAt: nowMs(),
      owner: item.owner,
    });
  }

  const old = queue.list(sid);
  for (const item of old) {
    await finishTurnTicket(item.ticketId, "turn.cancel");
  }

  queue.replace(sid, rebuilt);
  return true;
}
