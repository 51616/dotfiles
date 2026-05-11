import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codexFastMode, {
  readCodexFastModeState,
  shouldUseCodexFastMode,
  withCodexFastServiceTier,
  writeCodexFastModeState,
} from "../index.ts";
import tuiBroker from "../../tui-broker/index.ts";
import { __resetTuiBrokerRuntimeForTests } from "../../tui-broker/lib/runtime.ts";

function createFakePi() {
  const events = new Map();
  const commands = new Map();

  return {
    events,
    commands,
    on(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getThinkingLevel() {
      return "high";
    },
  };
}

function createFakeCtx(model = { id: "gpt-5.4", provider: "openai-codex", reasoning: true, contextWindow: 272000 }) {
  const calls = [];

  return {
    calls,
    hasUI: true,
    ui: {
      theme: {
        fg: (_color, text) => text,
      },
      setEditorComponent(value) {
        calls.push({ type: "editor", value });
      },
      setFooter(value) {
        calls.push({ type: "footer", value });
      },
      notify(text, level) {
        calls.push({ type: "notify", text, level });
      },
    },
    sessionManager: {
      getCwd() {
        return "/home/tan/vault";
      },
      getSessionName() {
        return "";
      },
      getBranch() {
        return [];
      },
    },
    modelRegistry: {
      find() {
        return undefined;
      },
      getAvailable() {
        return [];
      },
    },
    getContextUsage() {
      return { percent: 12.2, contextWindow: 272000, tokens: 33123 };
    },
    get model() {
      return model;
    },
  };
}

function renderFooter(ctx, width = 80) {
  const footerFactory = ctx.calls.find((entry) => entry.type === "footer")?.value;
  assert.equal(typeof footerFactory, "function");

  const footer = footerFactory(
    { requestRender() {} },
    {
      fg: (_color, text) => text,
      bold: (text) => text,
    },
    {
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    },
  );

  return footer.render(width);
}

test("state helpers persist codex-fast-mode as a small explicit JSON contract", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "codex-fast-mode-state-"));

  assert.deepEqual(readCodexFastModeState(agentDir), { enabled: false });

  writeCodexFastModeState({ enabled: true }, agentDir);
  assert.deepEqual(readCodexFastModeState(agentDir), { enabled: true });
  assert.equal(readFileSync(join(agentDir, "codex-fast-mode.json"), "utf8"), "{\n  \"enabled\": true\n}\n");
});

test("codex fast service tier applies only to enabled openai-codex requests", () => {
  assert.equal(shouldUseCodexFastMode({ enabled: false }, { provider: "openai-codex" }), false);
  assert.equal(shouldUseCodexFastMode({ enabled: true }, { provider: "openai" }), false);
  assert.equal(shouldUseCodexFastMode({ enabled: true }, { provider: "openai-codex" }), true);

  assert.deepEqual(withCodexFastServiceTier({ model: "gpt-5.4", service_tier: "default" }), {
    model: "gpt-5.4",
    service_tier: "fast",
  });
  assert.equal(withCodexFastServiceTier(null), null);
});

test("extension toggles service_tier=fast and contributes a footer effort suffix", async (t) => {
  __resetTuiBrokerRuntimeForTests();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "codex-fast-mode-agent-"));
  t.after(() => {
    __resetTuiBrokerRuntimeForTests();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
  });

  const pi = createFakePi();
  codexFastMode(pi);
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  assert.ok(renderFooter(ctx)[0].endsWith("󰚩 GPT-5.4 · 󰧑 High"));

  const command = pi.commands.get("codex-fast-mode");
  const fastCommand = pi.commands.get("fast");
  const normalCommand = pi.commands.get("normal");
  assert.equal(typeof command?.handler, "function");
  assert.equal(typeof fastCommand?.handler, "function");
  assert.equal(typeof normalCommand?.handler, "function");
  await fastCommand.handler("", ctx);

  const beforeProvider = pi.events.get("before_provider_request")?.[0];
  assert.equal(typeof beforeProvider, "function");
  assert.deepEqual(beforeProvider({ payload: { model: "gpt-5.4" } }, ctx), {
    model: "gpt-5.4",
    service_tier: "fast",
  });
  assert.ok(renderFooter(ctx)[0].endsWith("󰚩 GPT-5.4 · 󰧑 High (fast)"));

  await normalCommand.handler("", ctx);
  assert.equal(beforeProvider({ payload: { model: "gpt-5.4" } }, ctx), undefined);
  assert.ok(renderFooter(ctx)[0].endsWith("󰚩 GPT-5.4 · 󰧑 High"));

  await command.handler("on", ctx);
  assert.deepEqual(beforeProvider({ payload: { model: "gpt-5.4" } }, ctx), {
    model: "gpt-5.4",
    service_tier: "fast",
  });
});

test("enabled mode stays dormant on non-Codex models", async (t) => {
  __resetTuiBrokerRuntimeForTests();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "codex-fast-mode-noncodex-"));
  t.after(() => {
    __resetTuiBrokerRuntimeForTests();
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
  });

  const pi = createFakePi();
  codexFastMode(pi);
  tuiBroker(pi);

  const ctx = createFakeCtx({ id: "gpt-4.1", provider: "openai", reasoning: false, contextWindow: 128000 });
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const command = pi.commands.get("codex-fast-mode");
  await command.handler("on", ctx);

  const beforeProvider = pi.events.get("before_provider_request")?.[0];
  assert.equal(beforeProvider({ payload: { model: "gpt-4.1" } }, ctx), undefined);
  assert.ok(renderFooter(ctx)[0].endsWith("󰚩 GPT-4.1"));
});
