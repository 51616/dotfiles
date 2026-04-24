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

const RESET_FG = "\x1b[39m";
const BLUE_TRAIL_COLORS: readonly string[] = [
  "\x1b[38;2;96;165;250m",
  "\x1b[38;2;59;130;246m",
  "\x1b[38;2;37;99;235m",
  "\x1b[38;2;30;64;175m",
  "\x1b[38;2;30;58;138m",
  "\x1b[38;2;23;37;84m",
];
const BLUE_INACTIVE_COLOR = "\x1b[38;2;30;41;59m";

function colorize(color: string, glyph: string): string {
  return `${color}${glyph}${RESET_FG}`;
}

function renderScannerCell(ctx: UiContext, trailIndex: number): string {
  if (trailIndex === 0) return ctx.ui.theme.bold(colorize(BLUE_TRAIL_COLORS[0] ?? BLUE_INACTIVE_COLOR, "■"));
  if (trailIndex > 0 && trailIndex < OPENCODE_TRAIL_LENGTH) {
    return colorize(BLUE_TRAIL_COLORS[trailIndex] ?? BLUE_INACTIVE_COLOR, "■");
  }
  return colorize(BLUE_INACTIVE_COLOR, "⬝");
}

function buildOpencodeScannerIndicator(ctx: UiContext): WorkingIndicatorOptions {
  const totalFrames =
    OPENCODE_SPINNER_WIDTH + OPENCODE_HOLD_END_FRAMES + OPENCODE_SPINNER_WIDTH - 1 + OPENCODE_HOLD_START_FRAMES;
  const frames = Array.from({ length: totalFrames }, (_unused, frameIndex) => {
    const state = getScannerState(frameIndex, OPENCODE_SPINNER_WIDTH);
    return Array.from({ length: OPENCODE_SPINNER_WIDTH }, (_cell, charIndex) =>
      renderScannerCell(ctx, calculateTrailIndex(charIndex, state)),
    ).join("");
  });

  return {
    frames,
    intervalMs: OPENCODE_SPINNER_INTERVAL_MS,
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
  ctx.ui.setWorkingIndicator(buildOpencodeScannerIndicator(ctx));
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applySpinner(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applySpinner(ctx);
  });
}
