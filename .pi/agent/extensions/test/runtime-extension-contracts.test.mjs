import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(TEST_DIR, "..");

// This file is the migration checklist for the live extension workspace.
// If an extension is added, removed, or renamed, update this map and point it
// at the regression tests that make the extension's intended behavior obvious.
const REGRESSION_MATRIX = {
  "activity-block": [
    "test/activity-block-index.test.mjs",
    "activity-block/test/tool-order.test.mjs",
  ],
  "command-context-for-tools": [
    "test/command-context-for-tools.test.mjs",
  ],
  "command-palette": [
    "test/command-palette.test.mjs",
    "test/command-palette-overlay.test.mjs",
  ],
  "do-not-stop": [
    "test/do-not-stop.test.mjs",
    "test/do-not-stop-runtime.test.mjs",
  ],
  "pi-diff-review-tui": [
    "pi-diff-review-tui/test/app.test.mjs",
    "pi-diff-review-tui/test/review-session.test.mjs",
  ],
  "pi-diff-review-turn-tracker": [
    "pi-diff-review-turn-tracker/test/entrypoint.test.mjs",
    "pi-diff-review-turn-tracker/test/artifacts.test.mjs",
  ],
  "pi-instance-manager": [
    "test/pi-instance-manager-entrypoint-import.test.mjs",
    "test/pi-instance-manager-queue.test.mjs",
  ],
  "pi-slash": [
    "test/pi-slash-aliases.test.mjs",
  ],
  "pi-ssh": [
    "pi-ssh/test/skill-uris.test.mjs",
    "pi-ssh/test/run-skill-script.test.mjs",
  ],
  "self-checkpointing": [
    "test/self-checkpointing-entrypoint.test.mjs",
    "self-checkpointing/test/compaction-ui.test.mjs",
  ],
  "session-naming": [
    "test/session-naming-index.test.mjs",
    "test/session-naming-lib.test.mjs",
  ],
  "startup-demo": [
    "test/startup-demo.test.mjs",
  ],
  "tui-broker": [
    "tui-broker/test/interop.test.mjs",
    "tui-broker/test/surface-ownership-guard.test.mjs",
  ],
};

const SUPPORT_DIRS = new Set(["lat-md", "lib", "node_modules", "test", "work"]);

function runtimeExtensionDirs() {
  return fs
    .readdirSync(EXT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SUPPORT_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

test("regression matrix stays in sync with the canonical runtime extension inventory", () => {
  assert.deepEqual(runtimeExtensionDirs(), Object.keys(REGRESSION_MATRIX).sort());
});

test("every runtime extension has at least one explicit regression test file", () => {
  for (const [extensionName, proofFiles] of Object.entries(REGRESSION_MATRIX)) {
    assert.ok(proofFiles.length > 0, `missing proof files for ${extensionName}`);

    for (const relativePath of proofFiles) {
      const absolutePath = path.join(EXT_ROOT, relativePath);
      assert.equal(fs.existsSync(absolutePath), true, `${extensionName} proof file is missing: ${relativePath}`);
      assert.equal(fs.statSync(absolutePath).isFile(), true, `${extensionName} proof path is not a file: ${relativePath}`);
    }
  }
});
