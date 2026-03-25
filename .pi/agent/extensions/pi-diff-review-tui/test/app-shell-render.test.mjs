import test from "node:test";
import assert from "node:assert/strict";

import { renderAppShell } from "../lib/app-shell-render.ts";

const FG = {
  accent: "\x1b[38;5;33m",
  border: "\x1b[38;5;244m",
  borderAccent: "\x1b[38;5;39m",
  muted: "\x1b[38;5;245m",
  dim: "\x1b[38;5;240m",
  success: "\x1b[38;5;40m",
  warning: "\x1b[38;5;214m",
  error: "\x1b[38;5;160m",
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

test("renderAppShell stacks a comments panel under files", () => {
  const theme = createTheme();
  const rendered = renderAppShell({
    theme,
    width: 110,
    terminalRows: 30,
    repoRoot: "/repo",
    scope: "u",
    headLabel: "abcdef0",
    scopedCommentCount: 3,
    staleCount: 1,
    lastReload: "2026-03-24T01:02:03Z",
    focusMode: "files",
    diffTitle: "src/example.ts",
    perfEnabled: false,
    perfSummary: "",
    selectionSummary: null,
    filePanePreferredBodyHeight: 2,
    renderFileList: (_width, height) => Array.from({ length: height }, (_, index) => `file ${index + 1}`),
    renderCommentPanel: (_width, height) => Array.from({ length: height }, (_, index) => `comment panel ${index + 1}`),
    renderDiffRows: (_width, height) => Array.from({ length: height }, (_, index) => `diff ${index + 1}`),
  });

  const plain = stripAnsi(rendered.join("\n"));
  assert.match(plain, /Files/);
  assert.match(plain, /Comments/);
  assert.match(plain, /comment panel 1/);
  assert.match(plain, /diff 1/);
  assert.ok(plain.indexOf("Comments") > plain.indexOf("Files"));
});
