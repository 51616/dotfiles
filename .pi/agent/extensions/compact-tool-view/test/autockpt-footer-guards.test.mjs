import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  AUTOCHECKPOINT_DONE_MARKER,
  COMPACTION_INSTR_BEGIN,
  COMPACTION_INSTR_END,
} from "../lib/autockpt/autockpt-markers.ts";
import {
  assistantTextFromContent,
  isFreshCheckpointFile,
  isLikelyCheckpointPath,
  parseCheckpointFooter,
  shouldParseFooterGate,
} from "../lib/autockpt/autockpt-footer-guards.ts";

test("shouldParseFooterGate enforces role/threshold guards", () => {
  assert.equal(
    shouldParseFooterGate({
      handledThisTurn: false,
      role: "assistant",
      contextPercent: 72,
      thresholdPercent: 65,
    }),
    true,
  );

  assert.equal(
    shouldParseFooterGate({
      handledThisTurn: true,
      role: "assistant",
      contextPercent: 90,
      thresholdPercent: 65,
    }),
    false,
  );

  assert.equal(
    shouldParseFooterGate({
      handledThisTurn: false,
      role: "assistant",
      contextPercent: 40,
      thresholdPercent: 65,
    }),
    false,
  );

  assert.equal(
    shouldParseFooterGate({
      handledThisTurn: false,
      role: "user",
      contextPercent: 90,
      thresholdPercent: 65,
    }),
    false,
  );
});

test("assistantTextFromContent joins text chunks only", () => {
  const text = assistantTextFromContent([
    { type: "text", text: "line-a" },
    { type: "tool_result", text: "ignore" },
    { type: "text", text: "line-b" },
    { type: "text", text: 123 },
  ]);

  assert.equal(text, "line-a\nline-b");
  assert.equal(assistantTextFromContent(null), "");
});

test("parseCheckpointFooter extracts path + instructions and truncates", () => {
  const longInstr = "x".repeat(120);
  const body = [
    "report",
    COMPACTION_INSTR_BEGIN,
    longInstr,
    COMPACTION_INSTR_END,
    `${AUTOCHECKPOINT_DONE_MARKER} path=work/log/checkpoints/2026-02-18_0000_test.md`,
  ].join("\n");

  const parsed = parseCheckpointFooter(body, 64);
  assert.equal(parsed?.checkpointPath, "work/log/checkpoints/2026-02-18_0000_test.md");
  assert.equal(parsed?.compactionInstructions.length, 64);

  // Also accept indentation and extra blank lines between markers.
  const indented = [
    "report",
    `   ${COMPACTION_INSTR_BEGIN}   `,
    "keep A",
    `\t${COMPACTION_INSTR_END}`,
    "",
    `  ${AUTOCHECKPOINT_DONE_MARKER} path=work/log/checkpoints/2026-02-18_0001_test.md   `,
  ].join("\n");

  const parsed2 = parseCheckpointFooter(indented, 8000);
  assert.equal(parsed2?.checkpointPath, "work/log/checkpoints/2026-02-18_0001_test.md");
  assert.equal(parsed2?.compactionInstructions, "keep A");

  assert.equal(parseCheckpointFooter("no footer"), null);
});

test("checkpoint path guards validate pattern + freshness", () => {
  const rel = "work/log/checkpoints/2026-02-18_0000_guard.md";
  const abs = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "ok", "utf8");

  assert.equal(isLikelyCheckpointPath(rel), true);
  assert.equal(isLikelyCheckpointPath("/tmp/nope.md"), false);
  assert.equal(isLikelyCheckpointPath("work/log/checkpoints/bad.txt"), false);

  assert.equal(isFreshCheckpointFile(rel, 60_000), true);

  const old = new Date(Date.now() - 3_600_000);
  fs.utimesSync(abs, old, old);
  assert.equal(isFreshCheckpointFile(rel, 60_000), false);

  fs.unlinkSync(abs);
});
