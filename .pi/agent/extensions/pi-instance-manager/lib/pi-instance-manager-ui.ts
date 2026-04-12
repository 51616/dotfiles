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
  const queueSuffix = queuedCount > 0 ? ` (queue: ${queuedCount})` : "";

  if (mode === "manager_down") return `manager: off${queueSuffix}`;
  if (mode === "compacting") return `manager: compacting${queueSuffix}`;
  if (mode === "in_turn") return `manager: turn running${queueSuffix}`;

  if (mode === "waiting_lock") {
    if (isDiscordPromptOwner(owner)) return `manager: waiting for discord${queueSuffix}`;
    return `manager: waiting for lock${queueSuffix}`;
  }

  return `manager: on${queueSuffix}`;
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

  if (mode === "in_turn" || mode === "compacting" || mode === "waiting_lock") {
    clearSpinner();
    ctx.ui.setStatus("pi-compact", undefined);
    return;
  }

  if (!spinner.timer) {
    spinner.timer = setInterval(() => {
      spinner.index = (spinner.index + 1) % SPINNER.length;
      if (spinner.mode === "manager_down") {
        ctx.ui.setStatus("pi-compact", "| ⚠ Waiting for instance-manager...");
      }
    }, 140);

    spinner.timer.unref?.();
  }
}
