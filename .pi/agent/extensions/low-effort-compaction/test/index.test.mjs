import assert from "node:assert/strict";
import test from "node:test";

import lowEffortCompaction from "../index.ts";

function createHarness({
  activeModel = { provider: "test-provider", id: "test-model" },
  knownModels = [],
  authResult = { ok: false, error: "missing test key" },
} = {}) {
  const handlers = new Map();
  const statusCalls = [];
  const notifications = [];
  const authCalls = [];
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

  lowEffortCompaction(pi);

  return { handlers, statusCalls, notifications, authCalls, ctx };
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
