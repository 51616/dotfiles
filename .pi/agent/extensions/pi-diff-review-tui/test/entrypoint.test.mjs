import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("entrypoint declares /diff-review command", () => {
  const filePath = new URL("../index.ts", import.meta.url);
  const source = fs.readFileSync(filePath, "utf8");
  assert.match(source, /registerCommand\("diff-review"/);
  assert.match(source, /TUI diff review/i);
});
