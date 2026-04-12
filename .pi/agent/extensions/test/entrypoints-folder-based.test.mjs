import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  EXT_ROOT,
  EXPECTED_RUNTIME_EXTENSION_DIRS,
  SUPPORT_DIRS,
} from "./runtime-extension-inventory.mjs";

test("extensions workspace keeps runtime code in per-extension folders instead of top-level .ts files", () => {
  const entries = fs.readdirSync(EXT_ROOT, { withFileTypes: true });
  const topLevelTs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(topLevelTs, []);
});

test("expected runtime extension folders expose index.ts entrypoints in the canonical workspace", () => {
  for (const name of EXPECTED_RUNTIME_EXTENSION_DIRS) {
    const dir = path.join(EXT_ROOT, name);
    const entry = path.join(dir, "index.ts");

    assert.ok(fs.existsSync(dir), `missing extension dir: ${dir}`);
    assert.ok(fs.statSync(dir).isDirectory(), `extension path is not a directory: ${dir}`);
    assert.ok(fs.existsSync(entry), `missing extension entrypoint: ${entry}`);
    assert.ok(fs.statSync(entry).isFile(), `extension entrypoint is not a file: ${entry}`);
  }
});

test("workspace support directories remain explicitly non-runtime", () => {
  for (const name of SUPPORT_DIRS) {
    const dir = path.join(EXT_ROOT, name);
    assert.ok(fs.existsSync(dir), `missing support dir: ${dir}`);
    assert.ok(fs.statSync(dir).isDirectory(), `support path is not a directory: ${dir}`);
  }
});
