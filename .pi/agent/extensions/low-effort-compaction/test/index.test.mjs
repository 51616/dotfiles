import assert from "node:assert/strict";
import test from "node:test";

import lowEffortCompaction from "../index.ts";

function createHarness() {
  const handlers = new Map();
  const statusCalls = [];
  const notifications = [];
  const model = { provider: "test-provider", id: "test-model" };

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
      async getApiKeyAndHeaders() {
        return { ok: false, error: "missing test key" };
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

  return { handlers, statusCalls, notifications, ctx };
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
