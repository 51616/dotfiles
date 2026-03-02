import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ManagerStatusMode = "idle" | "compacting" | "waiting_lock" | "in_turn" | "manager_down";

export type SpinnerState = {
  timer: NodeJS.Timeout | null;
  index: number;
  mode: ManagerStatusMode;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function isDiscordPromptOwner(owner: string): boolean {
  return /^pi-discord-bot:prompt(?::|$)/.test(owner);
}

export function instanceManagerStatusLine(mode: ManagerStatusMode, owner: string, queuedCount: number): string {
  const queueSuffix = queuedCount > 0 ? ` q=${queuedCount}` : "";

  if (mode === "manager_down") return `| IM: down 🔴${queueSuffix}`;
  if (mode === "compacting") return `| IM: compacting 🟡${queueSuffix}`;
  if (mode === "in_turn") return `| IM: turn running 🟡${queueSuffix}`;

  if (mode === "waiting_lock") {
    if (isDiscordPromptOwner(owner)) return `| IM: waiting for discord turn 🟡${queueSuffix}`;
    return `| IM: waiting for lock 🟡${queueSuffix}`;
  }

  return `| IM: idle 🟢${queueSuffix}`;
}

export function ensureManagerSpinnerStatus(
  ctx: ExtensionContext,
  mode: ManagerStatusMode,
  queuedCount: number,
  spinner: SpinnerState,
) {
  if (!ctx.hasUI) return;

  const clearSpinner = () => {
    if (spinner.timer) {
      clearInterval(spinner.timer);
      spinner.timer = null;
    }
  };

  spinner.mode = mode;

  if (mode === "idle") {
    clearSpinner();
    if (queuedCount === 0) {
      ctx.ui.setStatus("pi-compact", undefined);
    }
    return;
  }

  if (!spinner.timer) {
    spinner.timer = setInterval(() => {
      spinner.index = (spinner.index + 1) % SPINNER.length;
      const ch = SPINNER[spinner.index];

      if (spinner.mode === "compacting") {
        ctx.ui.setStatus("pi-compact", `| ${ch} Compacting...`);
        return;
      }

      if (spinner.mode === "manager_down") {
        ctx.ui.setStatus("pi-compact", "| ⚠ Waiting for instance-manager...");
        return;
      }

      if (spinner.mode === "in_turn") {
        ctx.ui.setStatus("pi-compact", `| ${ch} Turn running (conversation lock held)...`);
        return;
      }

      ctx.ui.setStatus("pi-compact", `| ${ch} Waiting for conversation lock...`);
    }, 140);

    spinner.timer.unref?.();
  }
}
