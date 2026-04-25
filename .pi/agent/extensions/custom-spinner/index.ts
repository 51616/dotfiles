// @lat: [[extensions#Working spinner customization]]

import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

const WORKING_MESSAGES: readonly string[] = [
  "Cooking",
  "Thinking",
  "Working",
  "Brewing",
  "Crunching",
  "Weaving",
  "Forging",
  "Simmering",
  "Booping",
  "Channelling",
  "Computing",
  "Concocting",
  "Contemplating",
  "Crafting",
  "Cultivating",
  "Deliberating",
  "Discombobulating",
  "Doodling",
  "Embellishing",
  "Enchanting",
  "Generating",
];

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

type ScannerState = {
  activePosition: number;
  isHolding: boolean;
  holdProgress: number;
  holdTotal: number;
  movementProgress: number;
  movementTotal: number;
  isMovingForward: boolean;
};

const OPENCODE_SPINNER_WIDTH = 8;
const OPENCODE_HOLD_START_FRAMES = 30;
const OPENCODE_HOLD_END_FRAMES = 9;
const OPENCODE_TRAIL_LENGTH = 6;
const OPENCODE_SPINNER_INTERVAL_MS = 50;

function getScannerState(frameIndex: number, totalChars: number): ScannerState {
  const forwardFrames = totalChars;
  const backwardFrames = totalChars - 1;

  if (frameIndex < forwardFrames) {
    return {
      activePosition: frameIndex,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: frameIndex,
      movementTotal: forwardFrames,
      isMovingForward: true,
    };
  }

  if (frameIndex < forwardFrames + OPENCODE_HOLD_END_FRAMES) {
    return {
      activePosition: totalChars - 1,
      isHolding: true,
      holdProgress: frameIndex - forwardFrames,
      holdTotal: OPENCODE_HOLD_END_FRAMES,
      movementProgress: 0,
      movementTotal: 0,
      isMovingForward: true,
    };
  }

  if (frameIndex < forwardFrames + OPENCODE_HOLD_END_FRAMES + backwardFrames) {
    const backwardIndex = frameIndex - forwardFrames - OPENCODE_HOLD_END_FRAMES;
    return {
      activePosition: totalChars - 2 - backwardIndex,
      isHolding: false,
      holdProgress: 0,
      holdTotal: 0,
      movementProgress: backwardIndex,
      movementTotal: backwardFrames,
      isMovingForward: false,
    };
  }

  return {
    activePosition: 0,
    isHolding: true,
    holdProgress: frameIndex - forwardFrames - OPENCODE_HOLD_END_FRAMES - backwardFrames,
    holdTotal: OPENCODE_HOLD_START_FRAMES,
    movementProgress: 0,
    movementTotal: 0,
    isMovingForward: false,
  };
}

function calculateTrailIndex(charIndex: number, state: ScannerState): number {
  const directionalDistance = state.isMovingForward
    ? state.activePosition - charIndex
    : charIndex - state.activePosition;

  if (state.isHolding) {
    return directionalDistance + state.holdProgress;
  }

  if (directionalDistance > 0 && directionalDistance < OPENCODE_TRAIL_LENGTH) {
    return directionalDistance;
  }

  if (directionalDistance === 0) {
    return 0;
  }

  return -1;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function styleScannerGlyph(ctx: UiContext, glyph: string): string {
  return ctx.ui.theme.italic(glyph);
}

function renderScannerCell(ctx: UiContext, trailIndex: number): string {
  if (trailIndex === 0) return styleScannerGlyph(ctx, ctx.ui.theme.bold(ctx.ui.theme.fg("borderAccent", "■")));
  if (trailIndex === 1 || trailIndex === 2) return styleScannerGlyph(ctx, ctx.ui.theme.fg("borderAccent", "■"));
  if (trailIndex > 2 && trailIndex < OPENCODE_TRAIL_LENGTH) {
    return styleScannerGlyph(ctx, dim(ctx.ui.theme.fg("borderAccent", "■")));
  }
  return styleScannerGlyph(ctx, ctx.ui.theme.fg("muted", "⬝"));
}

const INVISIBLE_WORKING_MESSAGE = "\u200B";

function buildOpencodeScannerFrame(ctx: UiContext, workingMessage: string, frameIndex: number): string {
  const state = getScannerState(frameIndex, OPENCODE_SPINNER_WIDTH);
  const scanner = Array.from({ length: OPENCODE_SPINNER_WIDTH }, (_cell, charIndex) =>
    renderScannerCell(ctx, calculateTrailIndex(charIndex, state)),
  ).join("");

  return `${ctx.ui.theme.bold(ctx.ui.theme.fg("muted", workingMessage))} ${scanner}`;
}

function buildOpencodeScannerIndicator(ctx: UiContext, workingMessage: string): WorkingIndicatorOptions {
  const totalFrames =
    OPENCODE_SPINNER_WIDTH + OPENCODE_HOLD_END_FRAMES + OPENCODE_SPINNER_WIDTH - 1 + OPENCODE_HOLD_START_FRAMES;
  const frames = Array.from({ length: totalFrames }, (_unused, frameIndex) =>
    buildOpencodeScannerFrame(ctx, workingMessage, frameIndex),
  );

  return {
    frames,
    intervalMs: OPENCODE_SPINNER_INTERVAL_MS,
  };
}

let lastWorkingMessage: string | null = null;

function chooseWorkingMessage(): string {
  const candidates = WORKING_MESSAGES.filter((message) => message !== lastWorkingMessage);
  const next = candidates[Math.floor(Math.random() * candidates.length)] ?? WORKING_MESSAGES[0] ?? "Working";
  lastWorkingMessage = next;
  return next;
}

function applySpinner(ctx: UiContext): void {
  if (!ctx.hasUI) return;
  const workingMessage = chooseWorkingMessage();

  // pi's Loader always renders indicator frames before the working message and
  // treats an empty message as a request to restore the default. Put the label
  // in each verbatim indicator frame, then keep the built-in message invisible.
  ctx.ui.setWorkingMessage(INVISIBLE_WORKING_MESSAGE);
  ctx.ui.setWorkingIndicator(buildOpencodeScannerIndicator(ctx, workingMessage));
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applySpinner(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applySpinner(ctx);
  });
}
