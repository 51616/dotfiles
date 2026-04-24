// @lat: [[extensions#Working spinner customization]]

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

let lastWorkingMessage: string | null = null;

function chooseWorkingMessage(): string {
  const candidates = WORKING_MESSAGES.filter((message) => message !== lastWorkingMessage);
  const next = candidates[Math.floor(Math.random() * candidates.length)] ?? WORKING_MESSAGES[0] ?? "Working...";
  lastWorkingMessage = next;
  return next;
}

function applyWorkingMessage(ctx: UiContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingMessage(chooseWorkingMessage());
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applyWorkingMessage(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applyWorkingMessage(ctx);
  });
}
