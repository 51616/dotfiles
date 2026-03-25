import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openExternalEditor } from "../lib/external-editor.ts";

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-review-editor-"));
  fs.writeFileSync(path.join(dir, "file.ts"), "export const x = 1;\n", "utf8");
  return dir;
}

test("openExternalEditor stops and restarts tui around editor invocation", () => {
  const repoRoot = tmpRepo();
  const calls = [];
  const prev = process.env.EDITOR;
  process.env.EDITOR = "true";
  try {
    const result = openExternalEditor({
      tui: {
        stop() { calls.push("stop"); },
        start() { calls.push("start"); },
        requestRender(force) { calls.push(`render:${String(force)}`); },
      },
      repoRoot,
      relativePath: "file.ts",
      line: 4,
      lineTargeted: true,
    });

    assert.equal(result.status, 0);
    assert.deepEqual(calls, ["stop", "start", "render:true"]);
  } finally {
    if (prev === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = prev;
  }
});
