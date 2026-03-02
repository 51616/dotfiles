import { Key, matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateOneLine } from "./pi-instance-manager-queue.ts";

export type QueuePopupRow = {
  kind: "running" | "queued";
  label: string;
  ticketId?: string;
  text: string;
};

export type QueuePopupAction =
  | { action: "close" }
  | { action: "move"; ticketId: string; direction: "up" | "down" }
  | { action: "remove"; ticketId: string }
  | { action: "edit"; ticketId: string; text: string }
  | { action: "cancel_running" };

type PopupMode = "browse" | "confirm_remove" | "edit";

function isPrintableInput(data: string): boolean {
  if (!data) return false;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    return code >= 32 && code !== 127;
  }
  return false;
}

export async function openQueuePopup({
  ctx,
  rows,
}: {
  ctx: ExtensionContext;
  rows: QueuePopupRow[];
}): Promise<QueuePopupAction> {
  const result = await ctx.ui.custom<QueuePopupAction>((tui, theme, _keybindings, done) => {
    let index = 0;
    let mode: PopupMode = "browse";
    let editBuffer = "";

    function rowAt(i: number): QueuePopupRow | null {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[Math.max(0, Math.min(rows.length - 1, i))] || null;
    }

    function moveSelection(delta: number) {
      if (!Array.isArray(rows) || rows.length === 0) return;
      index = Math.max(0, Math.min(rows.length - 1, index + delta));
      tui.requestRender();
    }

    const component: Component = {
      handleInput(data: string) {
        const selected = rowAt(index);

        if (mode === "confirm_remove") {
          if (matchesKey(data, "y") || matchesKey(data, "Y")) {
            if (selected?.kind === "queued" && selected.ticketId) {
              done({ action: "remove", ticketId: selected.ticketId });
              return;
            }
            mode = "browse";
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "n") || matchesKey(data, "N") || matchesKey(data, Key.escape)) {
            mode = "browse";
            tui.requestRender();
            return;
          }
          return;
        }

        if (mode === "edit") {
          if (matchesKey(data, Key.ctrl("s"))) {
            if (selected?.kind === "queued" && selected.ticketId) {
              done({ action: "edit", ticketId: selected.ticketId, text: editBuffer.trim() });
              return;
            }
            mode = "browse";
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.escape)) {
            mode = "browse";
            tui.requestRender();
            return;
          }

          if (matchesKey(data, Key.backspace)) {
            editBuffer = editBuffer.slice(0, -1);
            tui.requestRender();
            return;
          }

          if (isPrintableInput(data)) {
            editBuffer += data;
            tui.requestRender();
            return;
          }

          return;
        }

        // browse mode
        if (matchesKey(data, Key.escape)) {
          done({ action: "close" });
          return;
        }

        if (matchesKey(data, Key.up)) {
          if (selected?.kind === "queued" && selected.ticketId) {
            done({ action: "move", ticketId: selected.ticketId, direction: "up" });
            return;
          }
          moveSelection(-1);
          return;
        }

        if (matchesKey(data, Key.down)) {
          if (selected?.kind === "queued" && selected.ticketId) {
            done({ action: "move", ticketId: selected.ticketId, direction: "down" });
            return;
          }
          moveSelection(1);
          return;
        }

        if (matchesKey(data, "e") || matchesKey(data, "E")) {
          if (selected?.kind === "queued") {
            mode = "edit";
            editBuffer = selected.text;
            tui.requestRender();
          }
          return;
        }

        if (matchesKey(data, "x") || matchesKey(data, "X")) {
          if (selected?.kind === "queued") {
            mode = "confirm_remove";
            tui.requestRender();
          }
          return;
        }

        if (matchesKey(data, "c") || matchesKey(data, "C")) {
          if (selected?.kind === "running") {
            done({ action: "cancel_running" });
          }
        }
      },

      render(width: number): string[] {
        const w = Math.max(30, width);
        const lines: string[] = [];
        const title = theme.fg("accent", theme.bold("Queue Manager (/queue)"));
        lines.push(truncateToWidth(title, w));

        if (mode === "edit") {
          lines.push(truncateToWidth(theme.fg("warning", "Edit mode: ctrl+s save • esc cancel"), w));
        } else if (mode === "confirm_remove") {
          lines.push(truncateToWidth(theme.fg("warning", "Remove selected item? (y/n)"), w));
        } else {
          lines.push(truncateToWidth(theme.fg("dim", "↑/↓ move item • e edit • x remove • c cancel running • esc close"), w));
        }

        if (!rows.length) {
          lines.push(truncateToWidth(theme.fg("muted", "(queue empty)"), w));
          return lines;
        }

        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const selected = i === index;
          const prefix = selected ? "> " : "  ";
          const left = row.kind === "running" ? "Current assistant turn" : row.label;
          const text = row.kind === "running" ? truncateOneLine(row.text, 60) : truncateOneLine(row.text, 60);
          const raw = `${prefix}${left}: ${text}`;
          const line = selected ? theme.bg("selectedBg", raw) : raw;
          lines.push(truncateToWidth(line, w));
        }

        if (mode === "edit") {
          const editor = `${theme.fg("accent", "edit> ")}${editBuffer}`;
          lines.push(truncateToWidth(editor, w));
        }

        return lines;
      },

      invalidate() {},
    };

    return component;
  }, { overlay: true });

  return result || { action: "close" };
}
