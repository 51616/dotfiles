import { asString } from "./pi-instance-manager-common.ts";
import type { QueuedInput, SessionInputQueue } from "./pi-instance-manager-queue.ts";

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
  enqueueTurnTicket: (
    sessionId: string,
    text: string,
  ) => Promise<{ ticketId: string; fencingToken: string; managerGeneration: number } | null>;
  finishTurnTicket: (ticketId: string, op: "turn.cancel" | "turn.done", fencingToken?: string) => Promise<void>;
  nowMs?: () => number;
}): Promise<boolean> {
  const sid = asString(sessionId).trim();
  if (!sid) return false;

  const rebuilt: QueuedInput[] = [];
  for (const item of nextItems) {
    const ticket = await enqueueTurnTicket(sid, item.text);
    if (!ticket) {
      for (const created of rebuilt) {
        await finishTurnTicket(created.ticketId, "turn.cancel", created.fencingToken);
      }
      return false;
    }
    rebuilt.push({
      ticketId: ticket.ticketId,
      fencingToken: ticket.fencingToken,
      managerGeneration: ticket.managerGeneration,
      text: item.text,
      queuedAt: nowMs(),
      owner: item.owner,
    });
  }

  const old = queue.list(sid);
  for (const item of old) {
    await finishTurnTicket(item.ticketId, "turn.cancel", item.fencingToken);
  }

  queue.replace(sid, rebuilt);
  return true;
}
