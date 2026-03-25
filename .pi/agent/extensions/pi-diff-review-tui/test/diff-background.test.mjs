import test from "node:test";
import assert from "node:assert/strict";

import { applyBackgroundAnsi, blendedDiffSelectionBg, brightenedBackgroundAnsi, diffRowBaseBg } from "../lib/diff-background.ts";

const TRUECOLOR_BG = {
  selectedBg: "\x1b[48;2;120;120;120m",
  toolSuccessBg: "\x1b[48;2;0;120;0m",
  toolErrorBg: "\x1b[48;2;120;0;0m",
};

function createTheme(mode = "truecolor") {
  return {
    getBgAnsi: (color) => TRUECOLOR_BG[color],
    getColorMode: () => mode,
  };
}

test("diffRowBaseBg uses success/error tint for changed rows only", () => {
  const theme = createTheme();
  assert.equal(diffRowBaseBg(theme, "added"), TRUECOLOR_BG.toolSuccessBg);
  assert.equal(diffRowBaseBg(theme, "removed"), TRUECOLOR_BG.toolErrorBg);
  assert.equal(diffRowBaseBg(theme, "context"), null);
});

test("blendedDiffSelectionBg mixes diff tint with selectedBg in truecolor mode", () => {
  const theme = createTheme();
  assert.equal(blendedDiffSelectionBg(theme, "added"), "\x1b[48;2;60;120;60m");
  assert.equal(blendedDiffSelectionBg(theme, "removed"), "\x1b[48;2;120;60;60m");
});

test("blendedDiffSelectionBg falls back to 256-color ansi when needed", () => {
  const theme = {
    getBgAnsi: (color) => {
      if (color === "toolSuccessBg") return "\x1b[48;5;34m";
      if (color === "toolErrorBg") return "\x1b[48;5;124m";
      return "\x1b[48;5;250m";
    },
    getColorMode: () => "256color",
  };

  assert.match(blendedDiffSelectionBg(theme, "added") ?? "", /^\x1b\[48;5;\d+m$/);
  assert.match(blendedDiffSelectionBg(theme, "removed") ?? "", /^\x1b\[48;5;\d+m$/);
});

test("brightenedBackgroundAnsi returns a brighter chip background", () => {
  const theme = createTheme();
  assert.equal(brightenedBackgroundAnsi(theme, TRUECOLOR_BG.toolSuccessBg), "\x1b[48;2;15;128;15m");
  assert.equal(brightenedBackgroundAnsi(theme, "\x1b[48;2;60;120;60m"), "\x1b[48;2;72;128;72m");
});

test("applyBackgroundAnsi wraps text and restores the terminal background", () => {
  assert.equal(applyBackgroundAnsi("hello", TRUECOLOR_BG.toolSuccessBg), `${TRUECOLOR_BG.toolSuccessBg}hello\x1b[49m`);
  assert.equal(applyBackgroundAnsi("hello", null), "hello");
});
