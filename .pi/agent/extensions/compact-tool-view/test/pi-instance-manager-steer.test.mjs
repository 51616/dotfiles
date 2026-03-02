import test from "node:test";
import assert from "node:assert/strict";
import { handleSteerCommand, normalizeSteerMessage } from "../pi-instance-manager/lib/pi-instance-manager-steer.ts";

test("normalizeSteerMessage trims whitespace", () => {
  assert.equal(normalizeSteerMessage("  hello  "), "hello");
  assert.equal(normalizeSteerMessage("\n\t"), "");
});

test("handleSteerCommand: empty args warns and does not send", async () => {
  const sent = [];
  const notices = [];

  const pi = {
    sendUserMessage: (content, options) => {
      sent.push({ content, options });
    },
  };

  const ctx = {
    hasUI: true,
    ui: {
      notify: (text, level) => notices.push({ text, level }),
    },
  };

  const result = await handleSteerCommand({ args: "   ", ctx, pi });

  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.text || ""), /Usage: \/steer <message>/);
});

test("handleSteerCommand: sends steer message via native steering queue", async () => {
  const sent = [];
  const notices = [];

  const pi = {
    sendUserMessage: (content, options) => {
      sent.push({ content, options });
    },
  };

  const ctx = {
    hasUI: true,
    ui: {
      notify: (text, level) => notices.push({ text, level }),
    },
  };

  const result = await handleSteerCommand({ args: "Stop and do this instead", ctx, pi });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ content: "Stop and do this instead", options: { deliverAs: "steer" } }]);
  assert.equal(notices.length, 1);
  assert.match(String(notices[0]?.text || ""), /bypasses instance-manager queue/);
});
