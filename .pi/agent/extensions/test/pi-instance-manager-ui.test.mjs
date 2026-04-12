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
  assert.match(line, /queue: 3/i);
});

test("instanceManagerStatusLine formats the idle state as on", () => {
  assert.equal(instanceManagerStatusLine("idle", "", 0), "manager: on");
});

test("instanceManagerStatusLine formats discord waiting state distinctly", () => {
  const line = instanceManagerStatusLine("waiting_lock", "pi-discord-bot:prompt:session=s1", 0);
  assert.match(line, /waiting for discord/i);
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

test("ensureManagerSpinnerStatus clears compact status while a turn is already running", () => {
  const statusCalls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        statusCalls.push({ key, value });
      },
    },
  };

  const timer = setInterval(() => {}, 1000);
  const spinner = { timer, index: 0, mode: "waiting_lock" };

  ensureManagerSpinnerStatus(ctx, "in_turn", 1, spinner);

  assert.equal(spinner.mode, "in_turn");
  assert.equal(spinner.timer, null);
  assert.deepEqual(statusCalls, [{ key: "pi-compact", value: undefined }]);
});

test("ensureManagerSpinnerStatus clears the instance-manager compact status while built-in compaction is active", () => {
  const statusCalls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        statusCalls.push({ key, value });
      },
    },
  };

  const timer = setInterval(() => {}, 1000);
  const spinner = { timer, index: 0, mode: "waiting_lock" };

  ensureManagerSpinnerStatus(ctx, "compacting", 0, spinner);

  assert.equal(spinner.mode, "compacting");
  assert.equal(spinner.timer, null);
  assert.deepEqual(statusCalls, [{ key: "pi-compact", value: undefined }]);
});

test("ensureManagerSpinnerStatus suppresses the conversation-lock waiting spinner text", () => {
  const statusCalls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        statusCalls.push({ key, value });
      },
    },
  };

  const timer = setInterval(() => {}, 1000);
  const spinner = { timer, index: 0, mode: "manager_down" };

  ensureManagerSpinnerStatus(ctx, "waiting_lock", 1, spinner);

  assert.equal(spinner.mode, "waiting_lock");
  assert.equal(spinner.timer, null);
  assert.deepEqual(statusCalls, [{ key: "pi-compact", value: undefined }]);
});
