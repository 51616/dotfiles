import assert from "node:assert/strict";
import test from "node:test";

import { registerLowEffortCompaction } from "../index.ts";

function createHarness({
  activeModel = { provider: "test-provider", id: "test-model" },
  knownModels = [],
  authResult = { ok: false, error: "missing test key" },
  authError,
  compactResult = { summary: "summary", firstKeptEntryId: "kept-entry", tokensBefore: 123 },
  compactErrors = [],
} = {}) {
  const handlers = new Map();
  const statusCalls = [];
  const notifications = [];
  const authCalls = [];
  const compactCalls = [];
  const delayCalls = [];
  const model = { ...activeModel };

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    async setModel(nextModel) {
      model.provider = nextModel.provider;
      model.id = nextModel.id;
    },
  };

  const ctx = {
    hasUI: true,
    model,
    modelRegistry: {
      find(provider, modelId) {
        return knownModels.find((m) => m.provider === provider && m.id === modelId);
      },
      async getApiKeyAndHeaders(target) {
        authCalls.push({ provider: target.provider, id: target.id });
        if (authError) throw authError;
        return authResult;
      },
    },
    ui: {
      setStatus(key, text) {
        statusCalls.push({ key, text });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  async function compactImpl(...args) {
    compactCalls.push(args);
    const error = compactErrors[compactCalls.length - 1];
    if (error) throw error;
    return compactResult;
  }

  async function delayImpl(delayMs, signal) {
    delayCalls.push({ delayMs, aborted: signal?.aborted === true });
  }

  registerLowEffortCompaction(pi, { compact: compactImpl, delay: delayImpl });

  return {
    handlers,
    statusCalls,
    notifications,
    authCalls,
    compactCalls,
    delayCalls,
    compactResult,
    ctx,
  };
}

test("session_before_compact shows stacked-pages compacting footer without thinking-level suffix", async () => {
  const harness = createHarness();

  await harness.handlers.get("session_before_compact")(
    {
      preparation: { messages: [] },
      customInstructions: "",
      signal: undefined,
    },
    harness.ctx,
  );

  assert.deepEqual(harness.statusCalls[0], {
    key: "low-effort-compaction",
    text: "⧉ compacting |",
  });
  assert.equal(harness.statusCalls[0].text.includes("(low)"), false);
  assert.deepEqual(harness.statusCalls.at(-1), {
    key: "low-effort-compaction",
    text: undefined,
  });
});

test("session_compact clears stacked-pages compacting footer", async () => {
  const harness = createHarness();

  await harness.handlers.get("session_compact")({}, harness.ctx);

  assert.deepEqual(harness.statusCalls, [
    {
      key: "low-effort-compaction",
      text: undefined,
    },
  ]);
});

test("session_before_compact retries low-effort compaction before returning success", async () => {
  const harness = createHarness({
    authResult: { ok: true, apiKey: "test-key", headers: {} },
    compactErrors: [new Error("WebSocket error"), new Error("WebSocket error")],
  });
  const signal = new AbortController().signal;

  const result = await harness.handlers.get("session_before_compact")(
    { preparation: { messages: [] }, customInstructions: "", signal },
    harness.ctx,
  );

  assert.deepEqual(result, { compaction: harness.compactResult });
  assert.equal(harness.compactCalls.length, 3);
  assert.deepEqual(harness.delayCalls, [
    { delayMs: 2_000, aborted: false },
    { delayMs: 2_000, aborted: false },
  ]);
  assert.deepEqual(harness.statusCalls, [
    {
      key: "low-effort-compaction",
      text: "⧉ compacting |",
    },
    {
      key: "low-effort-compaction",
      text: "⧉ compacting | retry 2/3",
    },
    {
      key: "low-effort-compaction",
      text: "⧉ compacting | retry 3/3",
    },
    {
      key: "low-effort-compaction",
      text: undefined,
    },
  ]);
  assert.equal(harness.notifications.length, 2);
  assert.match(harness.notifications[0].message, /attempt 1\/3 failed/);
  assert.match(harness.notifications[1].message, /attempt 2\/3 failed/);
});

test("session_before_compact falls back and clears footer after retry exhaustion", async () => {
  const harness = createHarness({
    authResult: { ok: true, apiKey: "test-key", headers: {} },
    compactErrors: [
      new Error("WebSocket error"),
      new Error("WebSocket error"),
      new Error("WebSocket error"),
    ],
  });
  const signal = new AbortController().signal;

  const result = await harness.handlers.get("session_before_compact")(
    { preparation: { messages: [] }, customInstructions: "", signal },
    harness.ctx,
  );

  assert.equal(result, undefined);
  assert.equal(harness.compactCalls.length, 3);
  assert.deepEqual(harness.delayCalls, [
    { delayMs: 2_000, aborted: false },
    { delayMs: 2_000, aborted: false },
  ]);
  assert.deepEqual(harness.statusCalls.at(-1), {
    key: "low-effort-compaction",
    text: undefined,
  });
  assert.match(harness.notifications.at(-1).message, /WebSocket error/);
  assert.match(harness.notifications.at(-1).message, /Falling back to default compaction/);
});

test("session_before_compact swaps sakana/fugu-ultra to sakana/fugu-mini for compaction", async () => {
  const harness = createHarness({
    activeModel: { provider: "sakana", id: "fugu-ultra" },
    knownModels: [{ provider: "sakana", id: "fugu-mini" }],
  });

  await harness.handlers.get("session_before_compact")(
    { preparation: { messages: [] }, customInstructions: "", signal: undefined },
    harness.ctx,
  );

  assert.deepEqual(harness.authCalls, [{ provider: "sakana", id: "fugu-mini" }]);
  // Session model itself should be untouched by the substitution.
  assert.equal(harness.ctx.model.provider, "sakana");
  assert.equal(harness.ctx.model.id, "fugu-ultra");
});

test("session_before_compact falls back to active model when fugu-mini is not registered", async () => {
  const harness = createHarness({
    activeModel: { provider: "sakana", id: "fugu-ultra" },
    knownModels: [], // fugu-mini not in registry
  });

  await harness.handlers.get("session_before_compact")(
    { preparation: { messages: [] }, customInstructions: "", signal: undefined },
    harness.ctx,
  );

  assert.deepEqual(harness.authCalls, [{ provider: "sakana", id: "fugu-ultra" }]);
});

test("session_before_compact does not substitute for unrelated models", async () => {
  const harness = createHarness({
    activeModel: { provider: "openai-codex", id: "gpt-5.5" },
    knownModels: [{ provider: "sakana", id: "fugu-mini" }],
  });

  await harness.handlers.get("session_before_compact")(
    { preparation: { messages: [] }, customInstructions: "", signal: undefined },
    harness.ctx,
  );

  assert.deepEqual(harness.authCalls, [{ provider: "openai-codex", id: "gpt-5.5" }]);
});
