import test from "node:test";
import assert from "node:assert/strict";

import { parseSingleFilePatch } from "../lib/diff-parser.ts";
import { getLanguageFromPath, highlightCodeLines, highlightFileRows } from "../lib/syntax-highlight.ts";

function createTheme() {
  return {
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };
}

const MULTILINE_PATCH = [
  "diff --git a/src/demo.ts b/src/demo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,4 +1,4 @@",
  " const prefix = `hello",
  "-world`;",
  "+world ${name}`;",
  " const after = 1;",
].join("\n");

test("getLanguageFromPath maps common diff-review files", () => {
  assert.equal(getLanguageFromPath("src/example.tsx"), "typescript");
  assert.equal(getLanguageFromPath("Dockerfile"), "dockerfile");
  assert.equal(getLanguageFromPath("infra/config.yaml"), "yaml");
  assert.equal(getLanguageFromPath("notes/README"), undefined);
});

test("highlightCodeLines preserves line count for multiline snippets", () => {
  const theme = createTheme();
  const code = [
    "const prefix = `hello",
    "world ${name}`;",
    "const after = 1;",
  ].join("\n");

  const lines = highlightCodeLines({ code, language: "typescript", theme });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /syntaxKeyword/);
});

test("highlightFileRows keeps row-aligned output for old/new chunks", () => {
  const file = parseSingleFilePatch({ rawPatch: MULTILINE_PATCH, status: "M", oldPath: "src/demo.ts", newPath: "src/demo.ts" });
  const highlighted = highlightFileRows({
    file,
    language: "typescript",
    theme: createTheme(),
  });

  const changedRows = file.rows.filter((row) => row.kind === "context" || row.kind === "removed" || row.kind === "added");
  assert.equal(highlighted.size, changedRows.length);

  const removedRow = file.rows.find((row) => row.kind === "removed");
  const addedRow = file.rows.find((row) => row.kind === "added");
  const contextRow = file.rows.find((row) => row.kind === "context" && row.text.includes("const prefix"));
  assert.ok(removedRow);
  assert.ok(addedRow);
  assert.ok(contextRow);
  assert.match(highlighted.get(contextRow.rowIndex) ?? "", /syntaxKeyword/);
  assert.match(highlighted.get(removedRow.rowIndex) ?? "", /world`/);
  assert.match(highlighted.get(addedRow.rowIndex) ?? "", /name/);

  const metaRow = file.rows.find((row) => row.kind === "meta");
  assert.ok(metaRow);
  assert.equal(highlighted.has(metaRow.rowIndex), false);
});
