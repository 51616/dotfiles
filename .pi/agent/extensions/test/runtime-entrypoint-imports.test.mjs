import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  EXT_ROOT,
  EXPECTED_RUNTIME_EXTENSION_DIRS,
} from "./runtime-extension-inventory.mjs";

test("every runtime extension entrypoint imports cleanly and default-exports an extension function", async (t) => {
  for (const extensionName of EXPECTED_RUNTIME_EXTENSION_DIRS) {
    await t.test(extensionName, async () => {
      const entrypointUrl = pathToFileURL(path.join(EXT_ROOT, extensionName, "index.ts")).href;
      const mod = await import(entrypointUrl);
      assert.equal(typeof mod.default, "function");
    });
  }
});
