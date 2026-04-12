import test from "node:test";
import assert from "node:assert/strict";
import {
  markFooterHandled,
  parseFooterDedupeWindowMs,
  shouldSkipDuplicateFooter,
} from "../lib/autockpt/autockpt-footer-dedupe.ts";

test("parseFooterDedupeWindowMs parses/clamps and falls back safely", () => {
  assert.equal(parseFooterDedupeWindowMs("1500", 100), 1500);
  assert.equal(parseFooterDedupeWindowMs("-1", 100), 100);
  assert.equal(parseFooterDedupeWindowMs("abc", 100), 100);
  assert.equal(parseFooterDedupeWindowMs("99999999", 100), 600000);
});

test("shouldSkipDuplicateFooter only blocks same-path records inside dedupe window", () => {
  const nowMs = 1_000_000;
  const record = markFooterHandled("work/log/checkpoints/a.md", nowMs - 2_000);

  assert.equal(
    shouldSkipDuplicateFooter({
      lastHandled: record,
      checkpointPath: "work/log/checkpoints/a.md",
      nowMs,
      dedupeWindowMs: 15_000,
    }),
    true,
  );

  assert.equal(
    shouldSkipDuplicateFooter({
      lastHandled: record,
      checkpointPath: "work/log/checkpoints/b.md",
      nowMs,
      dedupeWindowMs: 15_000,
    }),
    false,
  );

  assert.equal(
    shouldSkipDuplicateFooter({
      lastHandled: record,
      checkpointPath: "work/log/checkpoints/a.md",
      nowMs,
      dedupeWindowMs: 1_000,
    }),
    false,
  );

  assert.equal(
    shouldSkipDuplicateFooter({
      lastHandled: null,
      checkpointPath: "work/log/checkpoints/a.md",
      nowMs,
      dedupeWindowMs: 15_000,
    }),
    false,
  );

  assert.equal(
    shouldSkipDuplicateFooter({
      lastHandled: record,
      checkpointPath: "work/log/checkpoints/a.md",
      nowMs,
      dedupeWindowMs: 0,
    }),
    false,
  );
});
