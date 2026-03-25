import test from "node:test";
import assert from "node:assert/strict";

import { renderCommentPanel } from "../lib/comment-panel.ts";

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

function makeComment({
  ordinal,
  scope = "u",
  kind = "line",
  status = "ok",
  body = "Example body",
  displayPath = "src/example.ts",
  line = 12,
  originalLine = line,
} = {}) {
  return {
    id: `comment-${ordinal}`,
    ordinal,
    fileKey: `M:${displayPath}->${displayPath}`,
    fileStatus: "M",
    oldPath: displayPath,
    newPath: displayPath,
    editablePath: displayPath,
    displayPath,
    scope,
    originalAnchor: {
      kind,
      origin: kind === "range" ? "user_range" : null,
      side: kind === "file" ? "file" : "new",
      line: kind === "file" ? null : originalLine,
      startLine: kind === "range" ? originalLine : (kind === "file" ? null : originalLine),
      endLine: kind === "range" ? originalLine + 1 : (kind === "file" ? null : originalLine),
      applyLine: kind === "file" ? null : originalLine,
      applyStartLine: kind === "range" ? originalLine : (kind === "file" ? null : originalLine),
      applyEndLine: kind === "range" ? originalLine + 1 : (kind === "file" ? null : originalLine),
      hunkId: kind === "file" ? null : "hunk-1",
      hunkHeader: kind === "file" ? null : "@@ -1,1 +1,1 @@",
      targetText: "const after = 2;",
      contextBefore: [],
      contextAfter: [],
      normalizedTargetHash: "hash",
      searchText: "after",
    },
    anchor: {
      kind,
      origin: kind === "range" ? "user_range" : null,
      side: kind === "file" ? "file" : "new",
      line: kind === "file" ? null : line,
      startLine: kind === "range" ? line : (kind === "file" ? null : line),
      endLine: kind === "range" ? line + 1 : (kind === "file" ? null : line),
      applyLine: kind === "file" ? null : line,
      applyStartLine: kind === "range" ? line : (kind === "file" ? null : line),
      applyEndLine: kind === "range" ? line + 1 : (kind === "file" ? null : line),
      hunkId: kind === "file" ? null : "hunk-1",
      hunkHeader: kind === "file" ? null : "@@ -1,1 +1,1 @@",
      targetText: "const after = 2;",
      contextBefore: [],
      contextAfter: [],
      normalizedTargetHash: "hash",
      searchText: "after",
    },
    body,
    compactSnippet: "",
    fullHunkText: "",
    status,
    remapNotes: [],
    candidateRemaps: [],
  };
}

test("renderCommentPanel shows session-wide counts when files pane is active", () => {
  const theme = createTheme();
  const rendered = renderCommentPanel({
    theme,
    width: 32,
    height: 8,
    view: {
      kind: "session",
      scope: "u",
      comments: [
        makeComment({ ordinal: 1, scope: "u", kind: "line", status: "ok" }),
        makeComment({ ordinal: 2, scope: "s", kind: "range", status: "moved", line: 22, originalLine: 20 }),
        makeComment({ ordinal: 3, scope: "a", kind: "file", status: "stale_unresolved", line: null, originalLine: null }),
      ],
      overallComments: { u: "Overall note", s: "", a: "Another note" },
    },
  });

  const plain = stripAnsi(rendered.join("\n"));
  assert.match(plain, /session comments/);
  assert.match(plain, /total 3/);
  assert.match(plain, /kinds l1 r1 f1/);
  assert.match(plain, /status ok1 mv1 st1/);
  assert.match(plain, /scopes u1 i1 a1/);
  assert.match(plain, /overall notes 2/);
});

test("renderCommentPanel shows the hovered comment preview and extra-count hint", () => {
  const theme = createTheme();
  const rendered = renderCommentPanel({
    theme,
    width: 32,
    height: 8,
    view: {
      kind: "preview",
      scope: "u",
      comments: [
        makeComment({ ordinal: 1, body: "First line\nSecond line", line: 14, originalLine: 10, status: "moved" }),
        makeComment({ ordinal: 2, body: "Another comment", line: 14 }),
      ],
    },
  });

  const plain = stripAnsi(rendered.join("\n"));
  assert.match(plain, /comment at cursor/);
  assert.match(plain, /#1 moved/);
  assert.match(plain, /src\/example.ts:14 \(new\)/);
  assert.match(plain, /original src\/example.ts:10 \(new\)/);
  assert.match(plain, /First line/);
  assert.match(plain, /\+1 more here · v list/);
});
