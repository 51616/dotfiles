import type { Theme, WorkingIndicatorOptions } from "@mariozechner/pi-coding-agent";

export const OPENCODE_SCANNER_WIDTH = 8;
export const OPENCODE_SCANNER_INTERVAL_MS = 50;

const OPENCODE_HOLD_START_FRAMES = 30;
const OPENCODE_HOLD_END_FRAMES = 9;
const OPENCODE_TRAIL_LENGTH = 6;
const OPENCODE_SCANNER_FRAME_COUNT = OPENCODE_SCANNER_WIDTH + OPENCODE_HOLD_END_FRAMES + OPENCODE_SCANNER_WIDTH - 1 + OPENCODE_HOLD_START_FRAMES;

type ScannerTheme = Pick<Theme, "bold" | "fg" | "italic">;

type ScannerState = {
	activePosition: number;
	isHolding: boolean;
	holdProgress: number;
	holdTotal: number;
	movementProgress: number;
	movementTotal: number;
	isMovingForward: boolean;
};

function normalizeFrameIndex(frameIndex: number): number {
	if (!Number.isFinite(frameIndex)) return 0;
	const wholeFrame = Math.floor(frameIndex);
	return ((wholeFrame % OPENCODE_SCANNER_FRAME_COUNT) + OPENCODE_SCANNER_FRAME_COUNT) % OPENCODE_SCANNER_FRAME_COUNT;
}

export function getOpencodeScannerFrameIndex(nowMs: number): number {
	if (!Number.isFinite(nowMs)) return 0;
	return normalizeFrameIndex(Math.floor(Math.max(0, nowMs) / OPENCODE_SCANNER_INTERVAL_MS));
}

function getScannerState(frameIndex: number, totalChars: number): ScannerState {
	const normalizedFrameIndex = normalizeFrameIndex(frameIndex);
	const forwardFrames = totalChars;
	const backwardFrames = totalChars - 1;

	if (normalizedFrameIndex < forwardFrames) {
		return {
			activePosition: normalizedFrameIndex,
			isHolding: false,
			holdProgress: 0,
			holdTotal: 0,
			movementProgress: normalizedFrameIndex,
			movementTotal: forwardFrames,
			isMovingForward: true,
		};
	}

	if (normalizedFrameIndex < forwardFrames + OPENCODE_HOLD_END_FRAMES) {
		return {
			activePosition: totalChars - 1,
			isHolding: true,
			holdProgress: normalizedFrameIndex - forwardFrames,
			holdTotal: OPENCODE_HOLD_END_FRAMES,
			movementProgress: 0,
			movementTotal: 0,
			isMovingForward: true,
		};
	}

	if (normalizedFrameIndex < forwardFrames + OPENCODE_HOLD_END_FRAMES + backwardFrames) {
		const backwardIndex = normalizedFrameIndex - forwardFrames - OPENCODE_HOLD_END_FRAMES;
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
		holdProgress: normalizedFrameIndex - forwardFrames - OPENCODE_HOLD_END_FRAMES - backwardFrames,
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

function styleScannerGlyph(theme: ScannerTheme, glyph: string): string {
	return theme.italic(glyph);
}

function renderScannerCell(theme: ScannerTheme, trailIndex: number): string {
	if (trailIndex === 0) return styleScannerGlyph(theme, theme.bold(theme.fg("borderAccent", "■")));
	if (trailIndex === 1 || trailIndex === 2) return styleScannerGlyph(theme, theme.fg("borderAccent", "■"));
	if (trailIndex > 2 && trailIndex < OPENCODE_TRAIL_LENGTH) {
		return styleScannerGlyph(theme, dim(theme.fg("borderAccent", "■")));
	}
	return styleScannerGlyph(theme, theme.fg("muted", "⬝"));
}

function renderPlainScannerCell(trailIndex: number): string {
	return trailIndex >= 0 && trailIndex < OPENCODE_TRAIL_LENGTH ? "■" : "⬝";
}

export function renderPlainOpencodeScanner(frameIndex: number): string {
	const state = getScannerState(frameIndex, OPENCODE_SCANNER_WIDTH);
	return Array.from({ length: OPENCODE_SCANNER_WIDTH }, (_cell, charIndex) =>
		renderPlainScannerCell(calculateTrailIndex(charIndex, state)),
	).join("");
}

export function renderOpencodeScanner(theme: ScannerTheme, frameIndex: number): string {
	const state = getScannerState(frameIndex, OPENCODE_SCANNER_WIDTH);
	return Array.from({ length: OPENCODE_SCANNER_WIDTH }, (_cell, charIndex) =>
		renderScannerCell(theme, calculateTrailIndex(charIndex, state)),
	).join("");
}

export function renderOpencodeScannerLabelFrame(theme: ScannerTheme, label: string, frameIndex: number): string {
	return `${theme.bold(theme.fg("muted", label))} ${renderOpencodeScanner(theme, frameIndex)}`;
}

export function buildOpencodeScannerIndicator(theme: ScannerTheme, label: string): WorkingIndicatorOptions {
	const frames = Array.from({ length: OPENCODE_SCANNER_FRAME_COUNT }, (_unused, frameIndex) =>
		renderOpencodeScannerLabelFrame(theme, label, frameIndex),
	);

	return {
		frames,
		intervalMs: OPENCODE_SCANNER_INTERVAL_MS,
	};
}
