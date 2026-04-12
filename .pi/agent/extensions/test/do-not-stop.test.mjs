import test from "node:test";
import assert from "node:assert/strict";
import {
  DO_NOT_STOP_PROMPT,
  parseDoNotStopCommand,
  shouldArmDoNotStopFollowUp,
  shouldDispatchDoNotStopFollowUp,
  normalizeDoNotStopRepeats,
  brightRed,
  buildDoNotStopBorderLabel,
} from "../do-not-stop/lib/do-not-stop.ts";

test("brightRed wraps text with ANSI bright-red sequence", () => {
  assert.equal(brightRed("abc"), "\x1b[91mabc\x1b[0m");
});

test("normalizeDoNotStopRepeats bounds and falls back safely", () => {
  assert.equal(normalizeDoNotStopRepeats("10", 1), 10);
  assert.equal(normalizeDoNotStopRepeats("-2", 1), 1);
  assert.equal(normalizeDoNotStopRepeats("abc", 3), 3);
  assert.equal(normalizeDoNotStopRepeats("1200", 1), 999);
});

test("parseDoNotStopCommand handles toggle/set/status/repeats/help", () => {
  assert.deepEqual(parseDoNotStopCommand(""), { kind: "toggle" });
  assert.deepEqual(parseDoNotStopCommand("toggle"), { kind: "toggle" });
  assert.deepEqual(parseDoNotStopCommand("on"), { kind: "set", enabled: true });
  assert.deepEqual(parseDoNotStopCommand("off"), { kind: "set", enabled: false });
  assert.deepEqual(parseDoNotStopCommand("status"), { kind: "status" });
  assert.deepEqual(parseDoNotStopCommand("repeats 10"), { kind: "setRepeats", repeats: 10 });
  assert.deepEqual(parseDoNotStopCommand("set 7"), { kind: "setRepeats", repeats: 7 });
  assert.deepEqual(parseDoNotStopCommand("help"), { kind: "help" });
  assert.deepEqual(parseDoNotStopCommand("repeats"), { kind: "help", invalid: "repeats" });
  assert.deepEqual(parseDoNotStopCommand("weird"), { kind: "help", invalid: "weird" });
});

test("shouldArmDoNotStopFollowUp only arms for non-extension non-command input", () => {
  assert.equal(
    shouldArmDoNotStopFollowUp({
      enabled: true,
      text: "Implement the TODO list",
      source: "interactive",
    }),
    true,
  );

  assert.equal(shouldArmDoNotStopFollowUp({ enabled: false, text: "hello", source: "interactive" }), false);
  assert.equal(shouldArmDoNotStopFollowUp({ enabled: true, text: "/session", source: "interactive" }), false);
  assert.equal(shouldArmDoNotStopFollowUp({ enabled: true, text: DO_NOT_STOP_PROMPT, source: "interactive" }), false);
  assert.equal(shouldArmDoNotStopFollowUp({ enabled: true, text: "hello", source: "extension" }), false);
});

test("shouldDispatchDoNotStopFollowUp requires pending+idle+no-pending-messages", () => {
  assert.equal(
    shouldDispatchDoNotStopFollowUp({
      enabled: true,
      pendingRepeats: 3,
      isIdle: true,
      hasPendingMessages: false,
    }),
    true,
  );

  assert.equal(
    shouldDispatchDoNotStopFollowUp({
      enabled: true,
      pendingRepeats: 0,
      isIdle: true,
      hasPendingMessages: false,
    }),
    false,
  );

  assert.equal(
    shouldDispatchDoNotStopFollowUp({
      enabled: true,
      pendingRepeats: 3,
      isIdle: false,
      hasPendingMessages: false,
    }),
    false,
  );

  assert.equal(
    shouldDispatchDoNotStopFollowUp({
      enabled: true,
      pendingRepeats: 3,
      isIdle: true,
      hasPendingMessages: true,
    }),
    false,
  );
});

test("buildDoNotStopBorderLabel renders repeat badge text", () => {
  assert.equal(buildDoNotStopBorderLabel({ step: 5, total: 10 }), "↻ repeat 5/10");
});


