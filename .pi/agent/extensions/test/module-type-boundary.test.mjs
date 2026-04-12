import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(TEST_DIR, "..");

test("canonical extensions workspace package boundary declares ESM module type", () => {
  const pkgPath = path.join(EXT_ROOT, "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);

  assert.equal(pkg?.type, "module");
});
