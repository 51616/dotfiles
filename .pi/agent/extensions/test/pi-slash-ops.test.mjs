import test from "node:test";
import assert from "node:assert/strict";
import piSlash from "../pi-slash/index.ts";

function makePiStub(options = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const setModelCalls = [];
  const setThinkingLevelCalls = [];

  const pi = {
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
    },
    registerTool(spec) {
      tools.set(String(spec.name), spec);
    },
    getCommands() {
      return options.commands ?? [];
    },
    async setModel(model) {
      setModelCalls.push(model);
      return options.setModelResult ?? true;
    },
    setThinkingLevel(level) {
      setThinkingLevelCalls.push(level);
    },
  };

  return { pi, commands, tools, handlers, setModelCalls, setThinkingLevelCalls };
}

function makeCtx(overrides = {}) {
  const compactCalls = [];
  const registryCalls = [];

  const ctx = {
    hasUI: true,
    isIdle: () => true,
    shutdown() {},
    compact(options) {
      compactCalls.push(options);
      options.onComplete?.({ summary: "Compacted summary", tokensBefore: 321 });
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionName: () => "Session 1",
      getSessionFile: () => "/tmp/session-1.jsonl",
      getCwd: () => process.cwd(),
      getSessionDir: () => ".pi/sessions",
      getHeader: () => ({ timestamp: "2026-03-25T00:00:00.000Z" }),
      getLeafId: () => "assistant-1",
      getTree: () => [],
    },
    modelRegistry: {
      refresh() {
        registryCalls.push("refresh");
      },
      find(provider, modelId) {
        registryCalls.push([provider, modelId]);
        if (typeof overrides.findModel === "function") {
          return overrides.findModel(provider, modelId);
        }
        return { provider, id: modelId };
      },
    },
    ui: {
      notify() {},
      async confirm() {
        return true;
      },
      async select() {
        return "";
      },
    },
    ...overrides,
  };

  return {
    ctx,
    compactCalls,
    registryCalls,
  };
}

test("pi_slash model.set refreshes the registry and applies thinking level", async () => {
  const { pi, tools, setModelCalls, setThinkingLevelCalls } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);

  const { ctx, registryCalls } = makeCtx();
  const result = await tool.execute(
    "tool-model-set",
    {
      op: "model.set",
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "high",
    },
    new AbortController().signal,
    undefined,
    ctx,
  );

  assert.equal(result.details.ok, true);
  assert.deepEqual(registryCalls, ["refresh", ["openai-codex", "gpt-5.3-codex"]]);
  assert.deepEqual(setModelCalls, [{ provider: "openai-codex", id: "gpt-5.3-codex" }]);
  assert.deepEqual(setThinkingLevelCalls, ["high"]);
  assert.match(result.content[0].text, /OK: model set to openai-codex\/gpt-5\.3-codex/);
});

test("pi_slash thinking.set validates levels before mutating the session", async () => {
  const { pi, tools, setThinkingLevelCalls } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);
  const { ctx } = makeCtx();

  const invalid = await tool.execute(
    "tool-thinking-invalid",
    { op: "thinking.set", level: "turbo" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(invalid.details.ok, false);
  assert.deepEqual(setThinkingLevelCalls, []);

  const valid = await tool.execute(
    "tool-thinking-valid",
    { op: "thinking.set", level: "medium" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(valid.details.ok, true);
  assert.deepEqual(setThinkingLevelCalls, ["medium"]);
});

test("pi_slash slash.run carries compact instructions across deferred execution", async () => {
  const { pi, tools, handlers } = makePiStub();
  piSlash(pi);

  const tool = tools.get("pi_slash");
  assert.ok(tool);
  assert.ok(handlers.has("agent_end"));

  const { ctx, compactCalls } = makeCtx({ isIdle: () => false });
  const result = await tool.execute(
    "tool-compact-scheduled",
    { op: "slash.run", command: "/compact keep only the current branch", force: true },
    new AbortController().signal,
    undefined,
    ctx,
  );

  assert.equal(result.details.ok, true);
  assert.equal(compactCalls.length, 0);
  assert.match(result.content[0].text, /Scheduled: \/compact/);

  await handlers.get("agent_end")({}, ctx);

  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].customInstructions, "keep only the current branch");
});
