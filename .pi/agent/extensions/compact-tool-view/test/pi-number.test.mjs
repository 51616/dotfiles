import test from "node:test";
import assert from "node:assert/strict";
import { parsePositiveInt } from "../lib/shared/pi-number.ts";

test("parsePositiveInt parses positive ints and falls back safely", () => {
  assert.equal(parsePositiveInt("10", 3), 10);
  assert.equal(parsePositiveInt("0012", 3), 12);
  assert.equal(parsePositiveInt("0", 3), 3);
  assert.equal(parsePositiveInt("-4", 3), 3);
  assert.equal(parsePositiveInt("abc", 3), 3);
  assert.equal(parsePositiveInt(undefined, 3), 3);
});
