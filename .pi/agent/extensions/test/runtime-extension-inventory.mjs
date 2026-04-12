import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

export const EXT_ROOT = path.resolve(TEST_DIR, "..");
export const SUPPORT_DIRS = ["lat-md", "lib", "node_modules", "test", "work"];
const SUPPORT_DIR_SET = new Set(SUPPORT_DIRS);

// This file is the migration checklist for the live extension workspace.
// If an extension is added, removed, or renamed, update this map and point it
// at the regression tests that make the extension's intended behavior obvious.
export const REGRESSION_MATRIX = {
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
    "test/runtime-entrypoint-imports.test.mjs",
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
    "test/runtime-entrypoint-imports.test.mjs",
    "pi-ssh/test/footer.test.mjs",
    "pi-ssh/test/remote-context.test.mjs",
  ],
  "self-checkpointing": [
    "test/self-checkpointing-entrypoint.test.mjs",
    "self-checkpointing/test/compaction-ui.test.mjs",
  ],
  "session-naming": [
    "test/session-naming-index.test.mjs",
    "test/session-naming-lib.test.mjs",
  ],
  "skill-uri": [
    "test/runtime-entrypoint-imports.test.mjs",
    "skill-uri/test/local-skill-uri-tools.test.mjs",
    "skill-uri/test/run-skill-script.test.mjs",
  ],
  "startup-demo": [
    "test/startup-demo.test.mjs",
  ],
  "tui-broker": [
    "test/runtime-entrypoint-imports.test.mjs",
    "tui-broker/test/interop.test.mjs",
    "tui-broker/test/surface-ownership-guard.test.mjs",
  ],
};

export const EXPECTED_RUNTIME_EXTENSION_DIRS = Object.keys(REGRESSION_MATRIX).sort();

export function runtimeExtensionDirs() {
  return fs
    .readdirSync(EXT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SUPPORT_DIR_SET.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}
