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
    statusLetter: (status) => status,
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
    statusLetter: (status) => status,
    fileCommentCount: () => 12,
    fileHasStale: () => true,
  });

  const plain = stripAnsi(out[0] ?? "");
  assert.match(plain, /◇12/);
});
