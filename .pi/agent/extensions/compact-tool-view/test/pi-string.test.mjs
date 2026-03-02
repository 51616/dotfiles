import test from "node:test";
import assert from "node:assert/strict";
import { asString } from "../lib/shared/pi-string.ts";

test("asString returns only string values", () => {
  assert.equal(asString("ok"), "ok");
  assert.equal(asString(""), "");
  assert.equal(asString(1), "");
  assert.equal(asString(false), "");
  assert.equal(asString(null), "");
  assert.equal(asString(undefined), "");
});
