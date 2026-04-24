// @lat: [[extensions#Working spinner customization]]

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

const WORKING_MESSAGES: readonly string[] = [
  "Cooking...",
  "Thinking...",
  "Working...",
  "Brewing...",
  "Crunching...",
  "Weaving...",
  "Forging...",
  "Simmering...",
];

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

const OPENCODE_PULSE_FRAMES: readonly string[] = ["█", "▓", "▒", "░"];
const OPENCODE_PULSE_INTERVAL_MS = 125;

function buildOpencodePulseIndicator(ctx: UiContext): WorkingIndicatorOptions {
  return {
    frames: OPENCODE_PULSE_FRAMES.map((frame) => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", frame))),
    intervalMs: OPENCODE_PULSE_INTERVAL_MS,
  };
}

let lastWorkingMessage: string | null = null;

function chooseWorkingMessage(): string {
  const candidates = WORKING_MESSAGES.filter((message) => message !== lastWorkingMessage);
  const next = candidates[Math.floor(Math.random() * candidates.length)] ?? WORKING_MESSAGES[0] ?? "Working...";
  lastWorkingMessage = next;
  return next;
}

function applySpinner(ctx: UiContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingMessage(chooseWorkingMessage());
  ctx.ui.setWorkingIndicator(buildOpencodePulseIndicator(ctx));
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applySpinner(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applySpinner(ctx);
  });
}
