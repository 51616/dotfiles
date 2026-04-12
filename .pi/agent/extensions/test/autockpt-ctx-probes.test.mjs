import test from "node:test";
import assert from "node:assert/strict";
import { probeCtxState } from "../lib/autockpt/autockpt-ctx-probes.ts";

test("probeCtxState defaults to idle=true and hasPendingMessages=false when methods missing", () => {
  const ctx = {};
  assert.deepEqual(probeCtxState(ctx), { isIdle: true, hasPendingMessages: false });
});

test("probeCtxState forwards isIdle/hasPendingMessages when provided", () => {
  const ctx = {
    isIdle: () => false,
    hasPendingMessages: () => true,
  };
  assert.deepEqual(probeCtxState(ctx), { isIdle: false, hasPendingMessages: true });
});
