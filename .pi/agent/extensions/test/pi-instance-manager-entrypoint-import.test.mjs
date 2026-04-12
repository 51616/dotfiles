import assert from "node:assert/strict";
import { test } from "node:test";

// Regression: Node's ESM resolver requires explicit file extensions.
// We want to be able to import the extension entrypoint directly under
// `node --experimental-strip-types` without a custom TS resolver.

test("pi-instance-manager entrypoint imports cleanly", async () => {
  const mod = await import("../pi-instance-manager/index.ts");
  assert.equal(typeof mod.default, "function");
});
