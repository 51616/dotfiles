import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EXT_ROOT,
  EXPECTED_RUNTIME_EXTENSION_DIRS,
  REGRESSION_MATRIX,
  runtimeExtensionDirs,
} from "./runtime-extension-inventory.mjs";

test("regression matrix stays in sync with the canonical runtime extension inventory", () => {
  assert.deepEqual(runtimeExtensionDirs(), EXPECTED_RUNTIME_EXTENSION_DIRS);
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
