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

const RESET_FG = "\x1b[39m";
const EMPTY_BLOCK = "\x1b[38;2;90;90;105m▱";
const FILLED_BLOCKS: readonly string[] = [
  "\x1b[38;2;125;211;252m▰",
  "\x1b[38;2;167;139;250m▰",
  "\x1b[38;2;240;171;252m▰",
];

function frame(filledBlocks: number): string {
  return [0, 1, 2]
    .map((index) => (index < filledBlocks ? FILLED_BLOCKS[index] : EMPTY_BLOCK))
    .join("") + RESET_FG;
}

const WORKING_INDICATOR: WorkingIndicatorOptions = {
  frames: [frame(0), frame(1), frame(2), frame(3), frame(2), frame(1)],
  intervalMs: 110,
};

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

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
  ctx.ui.setWorkingIndicator(WORKING_INDICATOR);
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applySpinner(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applySpinner(ctx);
  });
}
