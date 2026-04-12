// @lat: [[tests#Session naming auto-title flow stays one-shot and respects manual overrides]]
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionNamingExtension,
} from "../session-naming/index.ts";
import {
  fingerprintNamingSourceText,
  SESSION_NAMING_MODEL_ID,
  SESSION_NAMING_STATE_TYPE,
} from "../session-naming/lib/session-naming.ts";

function makeHarness(options = {}) {
  const handlers = new Map();
  let entries = [...(options.entries ?? [])];
  const setSessionNameCalls = [];
  const appendEntryCalls = [];
  const modelRegistryCalls = [];
  let currentSessionName = options.currentSessionName;
  let completeCalls = 0;
  let nextEntryId = entries.length + 1;
  const ctxAbortController = new AbortController();

  function appendSessionInfo(name) {
    entries.push({
      type: "session_info",
      id: `session-info-${nextEntryId++}`,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      name: name?.trim?.() ?? name,
    });
  }

  const pi = {
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    appendEntry(customType, data) {
      appendEntryCalls.push({ customType, data });
      entries.push({ type: "custom", customType, data });
    },
    setSessionName(name) {
      currentSessionName = name;
      appendSessionInfo(name);
      setSessionNameCalls.push(name);
    },
    getSessionName() {
      return currentSessionName;
    },
  };

  const ctx = {
    signal: ctxAbortController.signal,
    sessionManager: {
      getBranch() {
        return entries;
      },
      getEntries() {
        return entries;
      },
      getSessionName() {
        return currentSessionName;
      },
    },
    modelRegistry: {
      find(provider, modelId) {
        modelRegistryCalls.push(["find", provider, modelId]);
        if (options.disableModel) return undefined;
        if (provider === "openai-codex") return options.codexModel === false ? undefined : { provider, id: modelId };
        if (provider === "openai") return options.openaiModel === false ? undefined : { provider, id: modelId };
        return undefined;
      },
      async getApiKeyAndHeaders(model) {
        modelRegistryCalls.push(["auth", model.provider, model.id]);
        if (options.authFailure) return { ok: false, error: "auth-failed" };
        if (options.missingApiKey) return { ok: true, apiKey: undefined, headers: {} };
        return { ok: true, apiKey: "test-key", headers: { "x-test": "1" } };
      },
    },
  };

  const extension = createSessionNamingExtension({
    async completeModel(model, payload, requestOptions) {
      completeCalls += 1;
      if (options.completeThrows) throw new Error("boom");
      if (typeof options.onCompleteModel === "function") {
        await options.onCompleteModel(model, payload, requestOptions);
      }
      return {
        content: [{ type: "text", text: options.completeText ?? "Discord Bot Compaction Failure" }],
      };
    },
  });

  extension(pi);

  return {
    handlers,
    ctx,
    setSessionNameCalls,
    appendEntryCalls,
    modelRegistryCalls,
    getCurrentSessionName() {
      return currentSessionName;
    },
    setCurrentSessionName(name) {
      currentSessionName = name;
    },
    renameSession(name) {
      currentSessionName = name;
      appendSessionInfo(name);
    },
    clearSessionName() {
      currentSessionName = undefined;
      appendSessionInfo("");
    },
    abortCtxSignal() {
      ctxAbortController.abort();
    },
    getSessionEntries() {
      return entries;
    },
    setSessionEntries(nextEntries) {
      entries = nextEntries;
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    getCompleteCalls() {
      return completeCalls;
    },
  };
}

function lastState(harness) {
  const match = [...harness.appendEntryCalls]
    .reverse()
    .find((entry) => entry.customType === SESSION_NAMING_STATE_TYPE);
  return match?.data;
}

test("session naming sets a provisional name on first input and upgrades it after agent_end", async () => {
  const harness = makeHarness({
    async onCompleteModel(model, payload, requestOptions) {
      assert.equal(model.provider, "openai-codex");
      assert.equal(model.id, SESSION_NAMING_MODEL_ID);
      assert.equal(requestOptions.apiKey, "test-key");
      assert.match(payload.systemPrompt, /concise session names/);
      assert.match(payload.messages[0].content[0].text, /Conversation:/);
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "  debug   why\nDiscord bot compaction resumes badly  ", source: "interactive" }, harness.ctx);

  assert.deepEqual(harness.setSessionNameCalls, ["debug why Discord bot compact…"]);
  assert.equal(lastState(harness).stage, "pending-semantic");
  assert.match(lastState(harness).firstInputHash, /^[a-f0-9]{16}$/);

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "debug why Discord bot compaction resumes badly" }] },
      { role: "assistant", content: [{ type: "text", text: "I will inspect the resume path." }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.deepEqual(harness.setSessionNameCalls, [
    "debug why Discord bot compact…",
    "Discord Bot Compaction Failure",
  ]);
  assert.equal(harness.getCurrentSessionName(), "Discord Bot Compaction Failure");
  assert.equal(lastState(harness).stage, "done");
  assert.equal(lastState(harness).finalName, "Discord Bot Compaction Failure");
});

test("extension-sourced input is ignored for provisional naming", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "extension follow-up", source: "extension" }, harness.ctx);

  assert.deepEqual(harness.setSessionNameCalls, []);
  assert.equal(lastState(harness), undefined);
});

test("manual rename wins over delayed semantic naming", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "debug bot shutdown", source: "interactive" }, harness.ctx);
  harness.renameSession("Manual Choice");

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "debug bot shutdown" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
  assert.equal(harness.getCurrentSessionName(), "Manual Choice");
  assert.equal(lastState(harness).stage, "manual-override");
});

test("manual clear wins over delayed semantic naming", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "debug bot shutdown", source: "interactive" }, harness.ctx);
  harness.clearSessionName();

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "debug bot shutdown" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
  assert.equal(harness.getCurrentSessionName(), undefined);
  assert.equal(lastState(harness).stage, "manual-override");
});

test("existing named sessions are left untouched", async () => {
  const harness = makeHarness({ currentSessionName: "Existing Name" });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "new question", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.deepEqual(harness.setSessionNameCalls, []);
  assert.equal(harness.getCompleteCalls(), 0);
  assert.equal(harness.getCurrentSessionName(), "Existing Name");
});

test("semantic naming failure keeps the provisional title and marks the state failed", async () => {
  const harness = makeHarness({ authFailure: true });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "investigate session naming regression", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "investigate session naming regression" }] },
      { role: "assistant", content: [{ type: "text", text: "Checking the issue" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCurrentSessionName(), "investigate session naming re…");
  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "auth-failed");
});

test("semantic naming falls back to the openai provider when openai-codex is unavailable", async () => {
  const harness = makeHarness({
    codexModel: false,
    async onCompleteModel(model) {
      assert.equal(model.provider, "openai");
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 1);
  assert.equal(harness.getCurrentSessionName(), "Discord Bot Compaction Failure");
});

test("model-unavailable, missing-api-key, empty-response, abort, and thrown-call paths fail without clearing the provisional title", async () => {
  const unavailable = makeHarness({ disableModel: true });

  await unavailable.handlers.get("session_start")({ type: "session_start", reason: "startup" }, unavailable.ctx);
  await unavailable.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, unavailable.ctx);
  await unavailable.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, unavailable.ctx);
  await unavailable.flush();

  assert.equal(unavailable.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(unavailable).failureReason, "model-unavailable");

  const missingApiKey = makeHarness({ missingApiKey: true });
  await missingApiKey.handlers.get("session_start")({ type: "session_start", reason: "startup" }, missingApiKey.ctx);
  await missingApiKey.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, missingApiKey.ctx);
  await missingApiKey.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, missingApiKey.ctx);
  await missingApiKey.flush();

  assert.equal(missingApiKey.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(missingApiKey).failureReason, "missing-api-key");

  const empty = makeHarness({ completeText: "   \n   " });
  await empty.handlers.get("session_start")({ type: "session_start", reason: "startup" }, empty.ctx);
  await empty.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, empty.ctx);
  await empty.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, empty.ctx);
  await empty.flush();

  assert.equal(empty.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(empty).failureReason, "empty-response");

  const aborted = makeHarness({
    async onCompleteModel() {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await aborted.handlers.get("session_start")({ type: "session_start", reason: "startup" }, aborted.ctx);
  await aborted.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, aborted.ctx);
  await aborted.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, aborted.ctx);
  await aborted.flush();

  assert.equal(aborted.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(aborted).failureReason, "aborted");

  const thrown = makeHarness({ completeThrows: true });
  await thrown.handlers.get("session_start")({ type: "session_start", reason: "startup" }, thrown.ctx);
  await thrown.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, thrown.ctx);
  await thrown.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, thrown.ctx);
  await thrown.flush();

  assert.equal(thrown.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(thrown).failureReason, "request-failed");
});

test("ctx.signal aborts an in-flight semantic naming request", async () => {
  let sawAbort = false;
  const harness = makeHarness({
    async onCompleteModel(_model, _payload, requestOptions) {
      await new Promise((_, reject) => {
        requestOptions.signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  harness.abortCtxSignal();
  await harness.flush();

  assert.equal(sawAbort, true);
  assert.equal(lastState(harness).failureReason, "aborted");
  assert.equal(harness.getCurrentSessionName(), "trace resume bug");
});

test("manual rename during the semantic call still blocks the final overwrite", async () => {
  const harness = makeHarness({
    async onCompleteModel() {
      harness.renameSession("Renamed During Call");
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCurrentSessionName(), "Renamed During Call");
  assert.equal(lastState(harness).stage, "manual-override");
});

test("manual rename to the same visible provisional title still blocks semantic overwrite", async () => {
  const harness = makeHarness({
    async onCompleteModel() {
      harness.renameSession("trace resume bug");
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(harness).stage, "manual-override");
});

test("persisted done state prevents duplicate work after reload", async () => {
  const harness = makeHarness({
    currentSessionName: "Discord Bot Compaction Failure",
    entries: [
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "done",
          eligible: false,
          provisionalName: "debug why Discord bot compact…",
          finalName: "Discord Bot Compaction Failure",
        },
      },
    ],
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "reload" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "another prompt", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.deepEqual(harness.setSessionNameCalls, []);
  assert.equal(harness.getCompleteCalls(), 0);
});

test("persisted pending state survives reload while only the first user message is committed", async () => {
  const harness = makeHarness({
    currentSessionName: "debug bot shutdown quickly",
    entries: [
      {
        type: "session_info",
        id: "session-info-1",
        name: "debug bot shutdown quickly",
      },
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "debug bot shutdown quickly",
          provisionalNameEntryId: "session-info-1",
          firstInputHash: fingerprintNamingSourceText("debug bot shutdown quickly"),
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "debug bot shutdown quickly" }] },
      },
    ],
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "reload" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "debug bot shutdown quickly" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 1);
  assert.equal(harness.getCurrentSessionName(), "Discord Bot Compaction Failure");
  assert.equal(lastState(harness).stage, "done");
});


test("new user input while pending semantic naming fails closed before a later turn can rename from the wrong conversation", async () => {
  const harness = makeHarness({
    currentSessionName: "debug bot shutdown quickly",
    entries: [
      {
        type: "session_info",
        id: "session-info-1",
        name: "debug bot shutdown quickly",
      },
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "debug bot shutdown quickly",
          provisionalNameEntryId: "session-info-1",
          firstInputHash: fingerprintNamingSourceText("debug bot shutdown quickly"),
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "debug bot shutdown quickly" }] },
      },
    ],
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "reload" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "later unrelated prompt", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "debug bot shutdown quickly" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "later answer" }] },
    ],
  }, harness.ctx);

  assert.equal(harness.getCompleteCalls(), 0);
  assert.equal(harness.getCurrentSessionName(), "debug bot shutdown quickly");
  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
});

test("input mismatch prevents semantic rename after interruption/reload window", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "later unrelated prompt" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "later answer" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
  assert.equal(harness.getCurrentSessionName(), "trace resume bug");
  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "input-mismatch");
});

test("session_before_switch fails closed when semantic naming is still pending", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);

  await harness.handlers.get("session_before_switch")({ type: "session_before_switch", reason: "resume", targetSessionFile: "other.jsonl" }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_before_switch aborts an in-flight semantic naming request", async () => {
  let sawAbort = false;
  const harness = makeHarness({
    async onCompleteModel(_model, _payload, requestOptions) {
      await new Promise((_, reject) => {
        requestOptions.signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  await harness.handlers.get("session_before_switch")({ type: "session_before_switch", reason: "resume", targetSessionFile: "other.jsonl" }, harness.ctx);
  await harness.flush();

  assert.equal(sawAbort, true);
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
  assert.equal(harness.getCompleteCalls(), 1);
});

test("session_before_fork fails closed when semantic naming is still pending", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);

  await harness.handlers.get("session_before_fork")({ type: "session_before_fork", entryId: "entry-1" }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_before_fork aborts an in-flight semantic naming request", async () => {
  let sawAbort = false;
  const harness = makeHarness({
    async onCompleteModel(_model, _payload, requestOptions) {
      await new Promise((_, reject) => {
        requestOptions.signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  await harness.handlers.get("session_before_fork")({ type: "session_before_fork", entryId: "entry-1" }, harness.ctx);
  await harness.flush();

  assert.equal(sawAbort, true);
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
  assert.equal(harness.getCompleteCalls(), 1);
});

test("session_before_tree fails closed when semantic naming is still pending", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);

  await harness.handlers.get("session_before_tree")({ type: "session_before_tree", preparation: {}, signal: undefined }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_before_tree aborts an in-flight semantic naming request", async () => {
  let sawAbort = false;
  const harness = makeHarness({
    async onCompleteModel(_model, _payload, requestOptions) {
      await new Promise((_, reject) => {
        requestOptions.signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  await harness.handlers.get("session_before_tree")({ type: "session_before_tree", preparation: {}, signal: undefined }, harness.ctx);
  await harness.flush();

  assert.equal(sawAbort, true);
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
  assert.equal(harness.getCompleteCalls(), 1);
});

test("session_before_compact fails closed when semantic naming is still pending", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);

  await harness.handlers.get("session_before_compact")({ type: "session_before_compact", preparation: {}, branchEntries: [], signal: undefined }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");

  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_before_compact aborts an in-flight semantic naming request", async () => {
  let sawAbort = false;
  const harness = makeHarness({
    async onCompleteModel(_model, _payload, requestOptions) {
      await new Promise((_, reject) => {
        requestOptions.signal?.addEventListener("abort", () => {
          sawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "trace resume bug", source: "interactive" }, harness.ctx);
  await harness.handlers.get("agent_end")({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Looking now" }] },
    ],
  }, harness.ctx);
  await harness.flush();

  await harness.handlers.get("session_before_compact")({ type: "session_before_compact", preparation: {}, branchEntries: [], signal: undefined }, harness.ctx);
  await harness.flush();

  assert.equal(sawAbort, true);
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
  assert.equal(harness.getCompleteCalls(), 1);
});

test("session_switch refreshes state so the new session can be eligible", async () => {
  const harness = makeHarness();

  await harness.handlers.get("session_start")({ type: "session_start", reason: "startup" }, harness.ctx);
  await harness.handlers.get("input")({ type: "input", text: "first task", source: "interactive" }, harness.ctx);

  await harness.handlers.get("session_before_switch")({ type: "session_before_switch", reason: "new" }, harness.ctx);
  harness.setSessionEntries([]);
  harness.setCurrentSessionName(undefined);
  await harness.handlers.get("session_switch")({ type: "session_switch", reason: "new" }, harness.ctx);

  await harness.handlers.get("input")({ type: "input", text: "second task", source: "interactive" }, harness.ctx);

  assert.equal(harness.getCurrentSessionName(), "second task");
});

test("session_tree hydration converts a pending provisional title with manual drift into manual-override", async () => {
  const harness = makeHarness({
    currentSessionName: "Manual Tree Name",
    entries: [
      {
        type: "session_info",
        id: "session-info-1",
        name: "trace resume bug",
      },
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "trace resume bug",
          provisionalNameEntryId: "session-info-1",
        },
      },
    ],
  });

  await harness.handlers.get("session_tree")({ type: "session_tree" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.equal(lastState(harness).stage, "manual-override");
  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_tree fails closed once pending-semantic is rehydrated after an assistant response was already committed", async () => {
  const harness = makeHarness({
    currentSessionName: "trace resume bug",
    entries: [
      {
        type: "session_info",
        id: "session-info-1",
        name: "trace resume bug",
      },
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "trace resume bug",
          provisionalNameEntryId: "session-info-1",
          firstInputHash: fingerprintNamingSourceText("trace resume bug"),
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Looking now" }] },
      },
    ],
  });

  await harness.handlers.get("session_tree")({ type: "session_tree" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "interrupted-pending-semantic");
  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_compact hydration fails closed when the provisional session title is missing from runtime state", async () => {
  const harness = makeHarness({
    currentSessionName: undefined,
    entries: [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "trace resume bug" }] },
      },
      {
        type: "session_info",
        id: "session-info-1",
        name: "trace resume bug",
      },
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "trace resume bug",
          provisionalNameEntryId: "session-info-1",
        },
      },
    ],
  });

  await harness.handlers.get("session_compact")({ type: "session_compact" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "missing-session-name-on-hydrate");
  assert.equal(harness.getCompleteCalls(), 0);
});


test("session_start hydration fails closed when the persisted provisional name is missing", async () => {
  const harness = makeHarness({
    currentSessionName: "trace resume bug",
    entries: [
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          firstInputHash: fingerprintNamingSourceText("trace resume bug"),
        },
      },
    ],
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "reload" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "missing-provisional-name-on-hydrate");
  assert.equal(harness.getCompleteCalls(), 0);
});

test("session_start hydration fails closed when the provisional session_info entry id is missing", async () => {
  const harness = makeHarness({
    currentSessionName: "trace resume bug",
    entries: [
      {
        type: "custom",
        customType: SESSION_NAMING_STATE_TYPE,
        data: {
          version: 1,
          stage: "pending-semantic",
          eligible: true,
          provisionalName: "trace resume bug",
          firstInputHash: fingerprintNamingSourceText("trace resume bug"),
        },
      },
    ],
  });

  await harness.handlers.get("session_start")({ type: "session_start", reason: "reload" }, harness.ctx);
  await harness.handlers.get("agent_end")({ type: "agent_end", messages: [] }, harness.ctx);

  assert.equal(lastState(harness).stage, "failed");
  assert.equal(lastState(harness).failureReason, "missing-provisional-name-entry-id-on-hydrate");
  assert.equal(harness.getCompleteCalls(), 0);
});
