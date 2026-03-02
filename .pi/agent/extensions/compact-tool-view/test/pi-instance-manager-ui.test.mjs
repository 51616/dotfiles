import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureManagerSpinnerStatus,
  instanceManagerStatusLine,
  isDiscordPromptOwner,
} from "../pi-instance-manager/lib/pi-instance-manager-ui.ts";

test("isDiscordPromptOwner matches discord prompt owners", () => {
  assert.equal(isDiscordPromptOwner("pi-discord-bot:prompt:session=s1"), true);
  assert.equal(isDiscordPromptOwner("pi-discord-bot:other"), false);
});

test("instanceManagerStatusLine includes queue suffix for combined queue depth", () => {
  const line = instanceManagerStatusLine("waiting_lock", "", 3);
  assert.match(line, /q=3/);
});

test("instanceManagerStatusLine formats discord waiting state distinctly", () => {
  const line = instanceManagerStatusLine("waiting_lock", "pi-discord-bot:prompt:session=s1", 0);
  assert.match(line, /waiting for discord turn/i);
});

test("ensureManagerSpinnerStatus keeps compact status untouched when idle but remote queue exists", () => {
  const statusCalls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        statusCalls.push({ key, value });
      },
    },
  };

  const spinner = { timer: null, index: 0, mode: "waiting_lock" };

  ensureManagerSpinnerStatus(ctx, "idle", 2, spinner);

  assert.equal(spinner.mode, "idle");
  assert.equal(statusCalls.length, 0);
});
