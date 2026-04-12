import test from "node:test";
import assert from "node:assert/strict";
import { shouldTimeoutAutoKick } from "../lib/autockpt/autockpt-auto-kick-timeout.ts";

test("shouldTimeoutAutoKick: does not timeout when canTimeout=false", () => {
  const nowMs = 10_000;
  assert.equal(
    shouldTimeoutAutoKick({
      nowMs,
      startedAtMs: 0,
      maxAgeMs: 1,
      canTimeout: false,
    }),
    false,
  );

  assert.equal(
    shouldTimeoutAutoKick({
      nowMs,
      startedAtMs: 1,
      maxAgeMs: 1,
      canTimeout: false,
    }),
    false,
  );
});

test("shouldTimeoutAutoKick: uses lastActivityAtMs when present", () => {
  const startedAtMs = 0;
  const nowMs = 10_000;

  // startedAt could be very old (or unknown), but recent activity should keep it alive.
  assert.equal(
    shouldTimeoutAutoKick({
      nowMs,
      startedAtMs,
      lastActivityAtMs: nowMs - 100,
      maxAgeMs: 1000,
      canTimeout: true,
    }),
    false,
  );
});

test("shouldTimeoutAutoKick: falls back to startedAtMs when lastActivityAtMs missing", () => {
  const startedAtMs = 10_000;
  const nowMs = startedAtMs + 1201;

  assert.equal(
    shouldTimeoutAutoKick({
      nowMs,
      startedAtMs,
      maxAgeMs: 1200,
      canTimeout: true,
    }),
    true,
  );
});

test("shouldTimeoutAutoKick: disables timeout when maxAgeMs<=0", () => {
  assert.equal(
    shouldTimeoutAutoKick({
      nowMs: 10_000,
      startedAtMs: 1,
      lastActivityAtMs: 1,
      maxAgeMs: 0,
      canTimeout: true,
    }),
    false,
  );
});
