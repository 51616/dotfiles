import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDiscordServiceStatusController,
  discordBadge,
  startDiscordServiceStatusRefresh,
} from "../pi-instance-manager/lib/pi-instance-manager-discord-service.ts";

function withStubbedTimers(fn) {
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  let unrefCalled = false;
  globalThis.setInterval = () => {
    return {
      unref() {
        unrefCalled = true;
      },
    };
  };

  globalThis.clearInterval = () => {};

  try {
    fn({ getUnrefCalled: () => unrefCalled });
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
}

test("pi-instance-manager discord badge refresh unrefs the timer", () => {
  const oldPath = process.env.PATH;
  process.env.PATH = "";

  const calls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        calls.push([key, value]);
      },
    },
  };

  try {
    withStubbedTimers(({ getUnrefCalled }) => {
      const stop = startDiscordServiceStatusRefresh(ctx);
      assert.equal(getUnrefCalled(), true);
      assert.equal(calls.at(-1)?.[0], "pi-services");
      assert.match(String(calls.at(-1)?.[1] || ""), /^\| 󰙯 /);
      stop();
    });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("discordBadge uses glyph wording for online and offline states", () => {
  assert.equal(
    discordBadge({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      result: "success",
      restarts: 0,
      error: "",
    }),
    "| 󰙯 online",
  );
  assert.equal(
    discordBadge({
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      result: "success",
      restarts: 2,
      error: "",
    }),
    "| 󰙯 offline (restarts: 2)",
  );
});

test("discord service status controller clears the last UI status on headless teardown", () => {
  const oldPath = process.env.PATH;
  process.env.PATH = "";

  const calls = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        calls.push([key, value]);
      },
    },
  };

  const controller = createDiscordServiceStatusController();

  try {
    withStubbedTimers(() => {
      controller.start(ctx);
      controller.stop({ hasUI: false, ui: ctx.ui });
      assert.deepEqual(calls.at(-1), ["pi-services", undefined]);
    });
  } finally {
    process.env.PATH = oldPath;
  }
});
