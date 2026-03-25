import test from "node:test";
import assert from "node:assert/strict";

import { renderCommentsOverlay } from "../lib/overlay-views.ts";

const FG = {
  accent: "\x1b[38;5;33m",
  border: "\x1b[38;5;244m",
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

test("renderCommentsOverlay uses accent-colored vertical borders", () => {
  const theme = createTheme();
  const rendered = renderCommentsOverlay({
    theme,
    width: 60,
    terminalRows: 30,
    scope: "u",
    showAllScopes: false,
    comments: [],
    index: 0,
    scroll: 0,
  });

  const firstBodyLine = rendered.lines[1] ?? "";
  assert.match(firstBodyLine, /^\x1b\[0m\x1b\[38;5;33m│\x1b\[39m/);
  assert.match(firstBodyLine, /\x1b\[38;5;33m│\x1b\[39m\x1b\[0m$/);
});

test("renderCommentsOverlay shows a multi-line preview of the selected comment body", () => {
  const theme = createTheme();

  const comment = {
    id: "comment-1",
    ordinal: 1,
    fileKey: "M:src/example.ts->src/example.ts",
    displayPath: "src/example.ts",
    scope: "u",
    originalAnchor: {
      kind: "line",
      side: "new",
      line: 12,
      startLine: 12,
      endLine: 12,
      hunkId: "hunk-1",
      hunkHeader: "@@ -1,1 +1,1 @@",
      targetText: "const after = 2;",
    },
    anchor: {
      kind: "line",
      side: "new",
      line: 12,
      startLine: 12,
      endLine: 12,
      hunkId: "hunk-1",
      hunkHeader: "@@ -1,1 +1,1 @@",
      targetText: "const after = 2;",
    },
    body: "First line\nSecond line\nThird line",
    compactSnippet: "",
    fullHunkText: "",
    status: "ok",
    remapNotes: [],
    candidateRemaps: [],
  };

  const rendered = renderCommentsOverlay({
    theme,
    width: 80,
    terminalRows: 60,
    scope: "u",
    showAllScopes: false,
    comments: [comment],
    index: 0,
    scroll: 0,
  });

  const plain = stripAnsi(rendered.lines.join("\n"));
  assert.match(plain, /selected #1/);
  assert.match(plain, /First line/);
  assert.match(plain, /Second line/);
});
