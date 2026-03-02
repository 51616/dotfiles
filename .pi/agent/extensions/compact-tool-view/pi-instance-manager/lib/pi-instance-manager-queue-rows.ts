import { asString } from "./pi-instance-manager-common.ts";
import { truncateOneLine } from "./pi-instance-manager-queue.ts";

export type QueuePopupRowDraft =
  | { kind: "running"; label: string; text: string }
  | { kind: "queued"; label: string; ticketId: string; text: string };

export function buildQueuePopupRows({
  managerLockOwner,
  awaitingTurnEnd,
  activeTurnText,
  queued,
}: {
  managerLockOwner: string;
  awaitingTurnEnd: boolean;
  activeTurnText: string;
  queued: Array<{ ticketId: string; text: string }>;
}): QueuePopupRowDraft[] {
  const rows: QueuePopupRowDraft[] = [];

  const runningOwner = asString(managerLockOwner).trim();
  const runningText = truncateOneLine(activeTurnText || runningOwner || "running…", 80);
  if (awaitingTurnEnd || runningOwner) {
    rows.push({
      kind: "running",
      label: "Current assistant turn",
      text: runningText,
    });
  }

  for (let i = 0; i < queued.length; i += 1) {
    const item = queued[i];
    rows.push({
      kind: "queued",
      label: `Queued #${i + 1}`,
      ticketId: item.ticketId,
      text: item.text,
    });
  }

  return rows;
}
