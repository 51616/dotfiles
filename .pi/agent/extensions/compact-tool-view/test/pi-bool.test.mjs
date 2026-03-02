import test from "node:test";
import assert from "node:assert/strict";
import { parseBool } from "../lib/shared/pi-bool.ts";

test("parseBool parses common truthy/falsy values with fallback", () => {
  assert.equal(parseBool("1", false), true);
  assert.equal(parseBool("true", false), true);
  assert.equal(parseBool("YES", false), true);
  assert.equal(parseBool("on", false), true);

  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool("false", true), false);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool(undefined, true), true);
});
