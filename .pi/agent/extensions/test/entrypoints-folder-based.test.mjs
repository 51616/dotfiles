import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(TEST_DIR, "..");

test("extensions are folder-based (no top-level .ts entrypoints)", () => {
  const entries = fs.readdirSync(EXT_ROOT, { withFileTypes: true });
  const topLevelTs = entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name)
    .sort();

  assert.deepEqual(topLevelTs, []);
});

test("expected extension folders expose index.ts entrypoints", () => {
  const expected = [
    "command-context-for-tools",
    "command-palette",
    "do-not-stop",
    "pi-instance-manager",
    "pi-slash",
    "self-checkpointing",
    "snippets",
    "session-naming",
  ];

  for (const name of expected) {
    const dir = path.join(EXT_ROOT, name);
    const entry = path.join(dir, "index.ts");

    assert.ok(fs.existsSync(dir), `missing extension dir: ${dir}`);
    assert.ok(fs.statSync(dir).isDirectory(), `extension path is not a directory: ${dir}`);
    assert.ok(fs.existsSync(entry), `missing extension entrypoint: ${entry}`);
    assert.ok(fs.statSync(entry).isFile(), `extension entrypoint is not a file: ${entry}`);
  }
});
