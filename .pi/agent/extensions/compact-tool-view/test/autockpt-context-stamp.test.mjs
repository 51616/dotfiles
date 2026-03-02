import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECKPOINT_NOW_MARKER, CONTEXT_STAMP_MARKER } from "../lib/autockpt/autockpt-markers.ts";
import { hasTrailingCheckpointNowStamp, isContextStampLine } from "../lib/autockpt/autockpt-context-stamp.ts";

test("isContextStampLine matches the expected context-stamp format", () => {
  const line = `${CONTEXT_STAMP_MARKER} used=123 (65.0%) left=456 window=1024 ${CHECKPOINT_NOW_MARKER}`;
  assert.equal(isContextStampLine(line), true);

  assert.equal(isContextStampLine(`${CONTEXT_STAMP_MARKER} no numbers ${CHECKPOINT_NOW_MARKER}`), false);
  assert.equal(isContextStampLine(`${CONTEXT_STAMP_MARKER} used=1 left=2 ${CHECKPOINT_NOW_MARKER}`), false); // missing window=
  assert.equal(isContextStampLine(`used=123 window=456 ${CHECKPOINT_NOW_MARKER}`), false); // missing prefix
});

test("hasTrailingCheckpointNowStamp only matches when the stamp is the last non-empty line", () => {
  const stamp = `${CONTEXT_STAMP_MARKER} used=7 (99.9%) left=0 window=7 ${CHECKPOINT_NOW_MARKER}`;

  assert.equal(hasTrailingCheckpointNowStamp(`tool output\n${stamp}\n`), true);
  assert.equal(hasTrailingCheckpointNowStamp(`tool output\n${stamp}\n\n`), true);

  // Marker in the middle should NOT trigger.
  assert.equal(hasTrailingCheckpointNowStamp(`${stamp}\nmore output`), false);

  // Raw marker string (e.g. printing source code) should NOT trigger.
  assert.equal(hasTrailingCheckpointNowStamp(`export const CHECKPOINT_NOW_MARKER = \"${CHECKPOINT_NOW_MARKER}\";`), false);
});
