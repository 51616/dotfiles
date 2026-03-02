import test from "node:test";
import assert from "node:assert/strict";
import { parseNonNegativeInt } from "../lib/autockpt/autockpt-env.ts";

test("parseNonNegativeInt returns fallback on invalid or negative", () => {
  assert.equal(parseNonNegativeInt("", 5), 5);
  assert.equal(parseNonNegativeInt("nope", 5), 5);
  assert.equal(parseNonNegativeInt("-1", 5), 5);
});

test("parseNonNegativeInt parses base10 integers", () => {
  assert.equal(parseNonNegativeInt("0", 5), 0);
  assert.equal(parseNonNegativeInt("12", 5), 12);
});
