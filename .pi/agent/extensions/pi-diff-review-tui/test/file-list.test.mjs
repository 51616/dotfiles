// @lat: [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]]

import test from "node:test";
import assert from "node:assert/strict";

import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { renderFileList } from "../lib/diff-render.ts";

const FG = {
  accent: "\x1b[38;5;33m",
  muted: "\x1b[38;5;245m",
  warning: "\x1b[38;5;214m",
};

function createTheme() {
  return {
    fg: (color, text) => `${FG[color] ?? "\x1b[39m"}${text}\x1b[39m`,
  };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,1 +1,1 @@",
  "-const before = 1;",
  "+const after = 2;",
].join("\n");

test("renderFileList shows a comment badge with count", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });

  const out = renderFileList({
    theme,
    files: [file],
    width: 40,
    height: 10,
    fileScroll: 0,
    selectedFileIndex: 0,
    statusLetter: (entry) => entry.status,
    fileCommentCount: () => 3,
    fileHasStale: () => false,
  });

  const plain = stripAnsi(out[0] ?? "");
  assert.match(plain, /◆3/);
});

test("renderFileList uses a stale badge when file has unresolved stale comments", () => {
  const theme = createTheme();
  const file = parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" });

  const out = renderFileList({
    theme,
    files: [file],
    width: 40,
    height: 10,
    fileScroll: 0,
    selectedFileIndex: 0,
    statusLetter: (entry) => entry.status,
    fileCommentCount: () => 12,
    fileHasStale: () => true,
  });

  const plain = stripAnsi(out[0] ?? "");
  assert.match(plain, /◇12/);
});

test("renderFileList marks reported-only and missing-agent files explicitly", () => {
  const theme = createTheme();
  const observed = {
    ...parseSingleFilePatch({ rawPatch: PATCH, status: "M", oldPath: "src/example.ts", newPath: "src/example.ts" }),
    agentMismatch: "missing_from_agent_report",
  };
  const reportedOnly = {
    ...parseSingleFilePatch({ rawPatch: PATCH.replaceAll("src/example.ts", "docs/notes.md"), status: "M", oldPath: "docs/notes.md", newPath: "docs/notes.md" }),
    displayPath: "docs/notes.md",
    reviewProvenance: "reported_only",
  };

  const out = renderFileList({
    theme,
    files: [observed, reportedOnly],
    width: 48,
    height: 10,
    fileScroll: 0,
    selectedFileIndex: 1,
    statusLetter: (entry) => entry.reviewProvenance === "reported_only" ? "?" : entry.status,
    fileCommentCount: () => 0,
    fileHasStale: () => false,
  });

  const plain = stripAnsi(out.join("\n"));
  assert.match(plain, /src\/example\.ts\s+∅/);
  assert.match(plain, /\? docs\/notes\.md\s+\?/);
});
