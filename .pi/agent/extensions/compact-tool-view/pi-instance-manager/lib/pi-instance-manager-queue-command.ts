import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";
import { type SessionInputQueue } from "./pi-instance-manager-queue.ts";
import { buildQueuePopupRows } from "./pi-instance-manager-queue-rows.ts";

type QueueEditDraft = { text: string; owner?: string };

type QueueAction = "turn.cancel" | "turn.done";

export function registerQueueCommand({
  pi,
  queue,
  getManagerLockOwner,
  getAwaitingTurnEnd,
  getActiveTurnTicketId,
  clearActiveTurnTicketId,
  getActiveTurnText,
  finishTurnTicket,
  refreshManagerState,
  reissueQueueTickets,
  setFooter,
}: {
  pi: ExtensionAPI;
  queue: SessionInputQueue;
  getManagerLockOwner: () => string;
  getAwaitingTurnEnd: () => boolean;
  getActiveTurnTicketId: () => string;
  clearActiveTurnTicketId: () => void;
  getActiveTurnText: () => string;
  finishTurnTicket: (ticketId: string, op: QueueAction) => Promise<void>;
  refreshManagerState: () => Promise<void>;
  reissueQueueTickets: (sessionId: string, nextItems: QueueEditDraft[]) => Promise<boolean>;
  setFooter: (ctx: ExtensionContext) => void;
}) {
  pi.registerCommand("queue", {
    description: "Open shared queue manager for current session",
    handler: async (_args, ctx) => {
      const sid = asString(ctx.sessionManager.getSessionId()).trim();
      if (!sid) {
        ctx.ui.notify("No active session.", "warning");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("Queue UI requires a TUI session.", "warning");
        return;
      }

      let openQueuePopup: typeof import("./pi-instance-manager-queue-popup.ts").openQueuePopup;
      try {
        ({ openQueuePopup } = await import("./pi-instance-manager-queue-popup.ts"));
      } catch (e) {
        ctx.ui.notify(`Queue UI unavailable: ${String((e as any)?.message || e)}`, "error");
        return;
      }

      while (true) {
        const rows = buildQueuePopupRows({
          managerLockOwner: getManagerLockOwner(),
          awaitingTurnEnd: getAwaitingTurnEnd(),
          activeTurnText: getActiveTurnText(),
          queued: queue.list(sid),
        });

        const action = await openQueuePopup({ ctx, rows });

        if (action.action === "close") {
          if (ctx.hasUI) setFooter(ctx);
          return;
        }

        if (action.action === "cancel_running") {
          const runningTicketId = getActiveTurnTicketId();
          if (runningTicketId) {
            await finishTurnTicket(runningTicketId, "turn.cancel");
            clearActiveTurnTicketId();
            ctx.ui.notify("Best-effort cancel requested. Press Esc in main view to interrupt running turn.", "warning");
          } else {
            ctx.ui.notify("No local running turn to cancel.", "info");
          }
          await refreshManagerState();
          if (ctx.hasUI) setFooter(ctx);
          continue;
        }

        if (action.action === "remove") {
          await finishTurnTicket(action.ticketId, "turn.cancel");
          queue.removeByTicket(sid, action.ticketId);
          await refreshManagerState();
          if (ctx.hasUI) setFooter(ctx);
          continue;
        }

        if (action.action === "edit") {
          const text = String(action.text || "").trim();
          if (!text) {
            ctx.ui.notify("Edited text is empty. Keeping old content.", "warning");
            continue;
          }

          const current = queue.list(sid);
          const next = current.map((item) =>
            item.ticketId === action.ticketId ? { text, owner: item.owner } : { text: item.text, owner: item.owner },
          );
          const ok = await reissueQueueTickets(sid, next);
          if (!ok) ctx.ui.notify("Failed to update queue item.", "warning");
          await refreshManagerState();
          if (ctx.hasUI) setFooter(ctx);
          continue;
        }

        if (action.action === "move") {
          const current = queue.list(sid);
          const idx = current.findIndex((item) => item.ticketId === action.ticketId);
          if (idx < 0) continue;
          const nextIdx = action.direction === "up" ? idx - 1 : idx + 1;
          if (nextIdx < 0 || nextIdx >= current.length) continue;

          const moved = current.slice();
          const [item] = moved.splice(idx, 1);
          moved.splice(nextIdx, 0, item);

          const ok = await reissueQueueTickets(
            sid,
            moved.map((it) => ({ text: it.text, owner: it.owner })),
          );
          if (!ok) ctx.ui.notify("Failed to reorder queue.", "warning");
          await refreshManagerState();
          if (ctx.hasUI) setFooter(ctx);
          continue;
        }
      }
    },
  });
}
