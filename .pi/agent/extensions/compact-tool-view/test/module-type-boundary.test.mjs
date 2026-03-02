import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

test("extensions package boundary declares ESM module type", () => {
  const pkgPath = path.resolve(process.cwd(), "agents/extensions/package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);

  assert.equal(pkg?.type, "module");
});
