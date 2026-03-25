import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("turn tracker listens to tool_call and agent_end lifecycle hooks", () => {
  const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.on\("tool_call"/);
  assert.match(source, /pi\.on\("agent_end"/);
  assert.match(source, /turnIdFromInput/);
});
