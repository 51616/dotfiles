import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("turn tracker listens to turn lifecycle hooks without creating follow-up turns", () => {
  const source = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const tracker = fs.readFileSync(new URL("../lib/tracker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pi\.on\("tool_call"/);
  assert.match(source, /pi\.on\("agent_end"/);
  assert.match(source, /turnIdFromInput/);
  assert.match(source, /enableAgentChangeReport:\s*false/);
  assert.doesNotMatch(source, /sendUserMessage|triggerTurn/);
  assert.doesNotMatch(tracker, /sendUserMessage|triggerTurn/);
});
