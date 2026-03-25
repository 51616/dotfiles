import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@mariozechner/pi-tui";
import { topBorder } from "../lib/ui-helpers.ts";

const FG = {
  accent: "\x1b[38;5;33m",
  border: "\x1b[38;5;244m",
  muted: "\x1b[38;5;245m",
};

function createTheme() {
  return {
    fg: (color, text) => `${FG[color] ?? "\x1b[39m"}${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("topBorder renders a real border segment after the title", () => {
  const rendered = topBorder(createTheme(), "Files", 20, "accent");
  const plain = stripAnsi(rendered);

  assert.equal(visibleWidth(rendered), 22);
  assert.match(plain, /^╭─ Files ─+╮$/);
  assert.match(rendered, /Files\x1b\[22m\x1b\[39m\x1b\[38;5;33m /);
  assert.match(rendered, /\x1b\[38;5;33m╮\x1b\[39m\x1b\[0m$/);
});

test("topBorder keeps the trailing border and corner colored when the title is truncated", () => {
  const rendered = topBorder(createTheme(), "very/long/path/name.ts", 20, "accent");
  const plain = stripAnsi(rendered);

  assert.equal(visibleWidth(rendered), 22);
  assert.match(plain, /^╭─ .+… ─╮$/);
  assert.doesNotMatch(rendered, /\x1b\[0m…/);
  assert.match(rendered, /\x1b\[38;5;33m \x1b\[39m\x1b\[38;5;33m─\x1b\[39m\x1b\[38;5;33m╮\x1b\[39m\x1b\[0m$/);
});
