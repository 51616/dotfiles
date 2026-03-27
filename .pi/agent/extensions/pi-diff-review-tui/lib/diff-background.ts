import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ParsedRowKind } from "./types.ts";

type Rgb = { r: number; g: number; b: number };
type TintColorName = "toolSuccessBg" | "toolErrorBg" | "selectedBg";

const TRUECOLOR_BG = /\x1b\[48;2;(\d+);(\d+);(\d+)m/;
const ANSI256_BG = /\x1b\[48;5;(\d+)m/;
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, index) => 8 + index * 10);
const ANSI16_RGB: Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

function tintColorForRow(kind: ParsedRowKind): Exclude<TintColorName, "selectedBg"> | null {
  if (kind === "added") return "toolSuccessBg";
  if (kind === "removed") return "toolErrorBg";
  return null;
}

function findClosestCubeIndex(value: number): number {
  let minDistance = Infinity;
  let minIndex = 0;
  for (let index = 0; index < CUBE_VALUES.length; index += 1) {
    const distance = Math.abs(value - CUBE_VALUES[index]);
    if (distance < minDistance) {
      minDistance = distance;
      minIndex = index;
    }
  }
  return minIndex;
}

function findClosestGrayIndex(value: number): number {
  let minDistance = Infinity;
  let minIndex = 0;
  for (let index = 0; index < GRAY_VALUES.length; index += 1) {
    const distance = Math.abs(value - GRAY_VALUES[index]);
    if (distance < minDistance) {
      minDistance = distance;
      minIndex = index;
    }
  }
  return minIndex;
}

function colorDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function ansi256ToRgb(index: number): Rgb {
  if (index >= 0 && index <= 15) return ANSI16_RGB[index] ?? ANSI16_RGB[0];
  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const r = CUBE_VALUES[Math.floor(cubeIndex / 36) % 6] ?? 0;
    const g = CUBE_VALUES[Math.floor(cubeIndex / 6) % 6] ?? 0;
    const b = CUBE_VALUES[cubeIndex % 6] ?? 0;
    return { r, g, b };
  }
  if (index >= 232 && index <= 255) {
    const gray = GRAY_VALUES[index - 232] ?? 0;
    return { r: gray, g: gray, b: gray };
  }
  return ANSI16_RGB[0];
}

function rgbToAnsi256(rgb: Rgb): number {
  const rIndex = findClosestCubeIndex(rgb.r);
  const gIndex = findClosestCubeIndex(rgb.g);
  const bIndex = findClosestCubeIndex(rgb.b);
  const cubeRgb = {
    r: CUBE_VALUES[rIndex] ?? 0,
    g: CUBE_VALUES[gIndex] ?? 0,
    b: CUBE_VALUES[bIndex] ?? 0,
  };
  const cubeValue = 16 + 36 * rIndex + 6 * gIndex + bIndex;
  const cubeDistance = colorDistance(rgb, cubeRgb);

  const grayApprox = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
  const grayIndex = findClosestGrayIndex(grayApprox);
  const grayValue = GRAY_VALUES[grayIndex] ?? 0;
  const grayDistance = colorDistance(rgb, { r: grayValue, g: grayValue, b: grayValue });

  const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  if (spread < 10 && grayDistance < cubeDistance) return 232 + grayIndex;
  return cubeValue;
}

function parseBgAnsi(ansi: string): Rgb | null {
  const truecolor = ansi.match(TRUECOLOR_BG);
  if (truecolor) {
    return {
      r: Number.parseInt(truecolor[1] ?? "0", 10),
      g: Number.parseInt(truecolor[2] ?? "0", 10),
      b: Number.parseInt(truecolor[3] ?? "0", 10),
    };
  }

  const ansi256 = ansi.match(ANSI256_BG);
  if (ansi256) {
    return ansi256ToRgb(Number.parseInt(ansi256[1] ?? "0", 10));
  }

  return null;
}

function blendRgb(base: Rgb, overlay: Rgb, ratio: number): Rgb {
  return {
    r: Math.round(base.r * (1 - ratio) + overlay.r * ratio),
    g: Math.round(base.g * (1 - ratio) + overlay.g * ratio),
    b: Math.round(base.b * (1 - ratio) + overlay.b * ratio),
  };
}

function rgbToBgAnsi(rgb: Rgb, mode: ReturnType<Theme["getColorMode"]>): string {
  if (mode === "truecolor") return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  return `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
}

function brightenRgb(rgb: Rgb, ratio: number): Rgb {
  return blendRgb(rgb, { r: 255, g: 255, b: 255 }, ratio);
}

function darkenRgb(rgb: Rgb, ratio: number): Rgb {
  return blendRgb(rgb, { r: 0, g: 0, b: 0 }, ratio);
}

export function applyBackgroundAnsi(text: string, ansi: string | null | undefined): string {
  if (!ansi) return text;
  return `${ansi}${text}\x1b[49m`;
}

export function blendedDiffSelectionBg(theme: Pick<Theme, "getBgAnsi" | "getColorMode">, kind: ParsedRowKind, ratio = 0.5): string | null {
  const tintColor = tintColorForRow(kind);
  if (!tintColor) return null;

  const base = parseBgAnsi(theme.getBgAnsi(tintColor));
  const selected = parseBgAnsi(theme.getBgAnsi("selectedBg"));
  if (!base || !selected) return theme.getBgAnsi("selectedBg");
  return rgbToBgAnsi(blendRgb(base, selected, ratio), theme.getColorMode());
}

export function brightenedBackgroundAnsi(theme: Pick<Theme, "getColorMode">, ansi: string | null | undefined, ratio = 0.06): string | null {
  if (!ansi) return null;
  const rgb = parseBgAnsi(ansi);
  if (!rgb) return null;
  return rgbToBgAnsi(brightenRgb(rgb, ratio), theme.getColorMode());
}

export function darkenedBackgroundAnsi(theme: Pick<Theme, "getColorMode">, ansi: string | null | undefined, ratio = 0.35): string | null {
  if (!ansi) return null;
  const rgb = parseBgAnsi(ansi);
  if (!rgb) return null;
  return rgbToBgAnsi(darkenRgb(rgb, ratio), theme.getColorMode());
}

export function diffRowBaseBg(theme: Pick<Theme, "getBgAnsi">, kind: ParsedRowKind): string | null {
  const tintColor = tintColorForRow(kind);
  return tintColor ? theme.getBgAnsi(tintColor) : null;
}
