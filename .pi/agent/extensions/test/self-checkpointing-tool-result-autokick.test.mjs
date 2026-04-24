import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import selfCheckpointing from "../self-checkpointing/index.ts";
import { resetCheckpointCycleState } from "../lib/autockpt/autockpt-runtime-state.ts";

function makeFakePi() {
  const handlers = new Map();
  const sentCustomMessages = [];

  return {
    handlers,
    sentCustomMessages,
    api: {
      on(event, handler) {
        const arr = handlers.get(event) || [];
        arr.push(handler);
        handlers.set(event, arr);
      },
      registerCommand() {},
      sendUserMessage() {},
      sendMessage(message, options) {
        sentCustomMessages.push({ message, options });
      },
    },
  };
}

function callAll(handlers, eventName, event, ctx) {
  const fns = handlers.get(eventName) || [];
  return fns.map((fn) => fn(event, ctx));
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      resetCheckpointCycleState();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

function makeCtx(percent, tokens = Math.round(percent), contextWindow = 100) {
  return {
    hasUI: false,
    getContextUsage: () => ({ tokens, contextWindow, percent }),
    ui: {
      setStatus: () => {},
      notify: () => {},
      setWidget: () => {},
    },
  };
}

test("tool_result above threshold auto-kicks without mutating the transcript", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-tool-result-"));

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: "65",
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
      },
      async () => {
        const { api, handlers, sentCustomMessages } = makeFakePi();
        selfCheckpointing(api);

        const ctx = makeCtx(90);
        callAll(handlers, "session_start", {}, ctx);
        callAll(handlers, "turn_start", {}, ctx);

        const [result] = callAll(
          handlers,
          "tool_result",
          { content: [{ type: "text", text: "tool ok" }] },
          ctx,
        );

        assert.equal(result, undefined);
        assert.equal(sentCustomMessages.length, 1);
        assert.equal(sentCustomMessages[0]?.message?.customType, "pi-self-checkpointing");

        const text = String(sentCustomMessages[0]?.message?.content || "");
        assert.match(text, /\[autockpt\]/);
        assert.match(text, /Read the `checkpointing` skill/);

        callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tool_result above token threshold auto-kicks even when percent is below threshold", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-tool-result-"));

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT: "65",
        PI_SELF_CHECKPOINT_THRESHOLD_TOKENS: "192000",
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: undefined,
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
      },
      async () => {
        const { api, handlers, sentCustomMessages } = makeFakePi();
        selfCheckpointing(api);

        const ctx = makeCtx(48, 192000, 400000);
        callAll(handlers, "session_start", {}, ctx);
        callAll(handlers, "turn_start", {}, ctx);
        const [result] = callAll(
          handlers,
          "tool_result",
          { content: [{ type: "text", text: "tool ok" }] },
          ctx,
        );

        assert.equal(result, undefined);
        assert.equal(sentCustomMessages.length, 1);
        assert.equal(sentCustomMessages[0]?.message?.customType, "pi-self-checkpointing");

        callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("tool_result below threshold does not auto-kick", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autockpt-tool-result-"));

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: "65",
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
      },
      async () => {
        const { api, handlers, sentCustomMessages } = makeFakePi();
        selfCheckpointing(api);

        const ctx = makeCtx(40);
        callAll(handlers, "session_start", {}, ctx);
        callAll(handlers, "turn_start", {}, ctx);
        const [result] = callAll(
          handlers,
          "tool_result",
          { content: [{ type: "text", text: "tool ok" }] },
          ctx,
        );

        assert.equal(result, undefined);
        assert.equal(sentCustomMessages.length, 0);

        callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
