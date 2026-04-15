import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tuiBroker from "../index.ts";
import doNotStop from "../../do-not-stop/index.ts";
import { applyFffEditorMode } from "/home/tan/.pi/agent/git/github.com/SamuelLHuber/pi-fff/src/editor-mode.ts";
import {
  __resetTuiBrokerRuntimeForTests,
  getTuiBrokerRuntimeSnapshot,
  isTuiBrokerInstalled,
  registerTuiBrokerAutocompleteProviderWrapper,
  registerTuiBrokerFooterPathProvider,
  requestTuiBrokerEditorReinstall,
  unregisterTuiBrokerAutocompleteProviderWrapper,
} from "../lib/runtime.ts";
import { __resetDoNotStopRuntimeStoreForTests } from "../../do-not-stop/lib/do-not-stop-runtime.ts";
import { buildPiSshFooterLabel } from "../../pi-ssh/lib/pi-ssh-footer-runtime.ts";

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
    sendUserMessage() {},
  };
}

function createFakeCtx(options = {}) {
  const sessionId = options.sessionId ?? "session-1";
  const contextUsage =
    Object.prototype.hasOwnProperty.call(options, "contextUsage")
      ? options.contextUsage
      : { percent: 12.2, contextWindow: 272000, tokens: 33123 };
  const model =
    Object.prototype.hasOwnProperty.call(options, "model")
      ? options.model
      : { id: "gpt-5.4", provider: "openai-codex", reasoning: true, contextWindow: 272000 };
  const branch = options.branch ?? [];
  const modelRegistry =
    options.modelRegistry ?? {
      find(provider, modelId) {
        return provider === "openai-codex" && modelId === "gpt-5.4"
          ? { id: "gpt-5.4", provider: "openai-codex", contextWindow: 272000, reasoning: true }
          : undefined;
      },
      getAvailable() {
        return [{ id: "gpt-5.4", provider: "openai-codex", contextWindow: 272000, reasoning: true }];
      },
    };

  const calls = [];
  return {
    calls,
    hasUI: true,
    ui: {
      theme: { fg: (_color, text) => text },
      setEditorComponent(value) {
        calls.push({ type: "editor", value });
      },
      setFooter(value) {
        calls.push({ type: "footer", value });
      },
      setStatus(key, text) {
        calls.push({ type: "status", key, text });
      },
      notify() {},
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getCwd() {
        return "/home/tan/vault";
      },
      getSessionName() {
        return "";
      },
      getBranch() {
        return branch;
      },
    },
    modelRegistry,
    getContextUsage() {
      return contextUsage;
    },
    get model() {
      return model;
    },
    isIdle() {
      return true;
    },
    hasPendingMessages() {
      return false;
    },
  };
}

function createEditorInstance(ctx, position = "first") {
  const editorCalls = ctx.calls.filter((entry) => entry.type === "editor");
  const editorFactory = (position === "last" ? editorCalls.at(-1) : editorCalls[0])?.value;
  assert.equal(typeof editorFactory, "function");

  return editorFactory(
    {
      terminal: { rows: 40 },
      requestRender() {},
    },
    {
      borderColor: (text) => text,
      textColor: (text) => text,
      placeholderColor: (text) => text,
      cursorColor: (text) => text,
      selectionColor: (text) => text,
      autocompleteBorderColor: (text) => text,
      autocompleteSelectedBackgroundColor: (text) => text,
      autocompleteSelectedTextColor: (text) => text,
      autocompleteTextColor: (text) => text,
      autocompleteMatchColor: (text) => text,
    },
    { matches() { return false; } },
  );
}

function createRenderedEditorLines(ctx, width = 40) {
  return createEditorInstance(ctx).render(width);
}

test("do-not-stop contributes through tui-broker when the broker is installed", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const pi = createFakePi();
  doNotStop(pi);
  tuiBroker(pi);

  assert.equal(isTuiBrokerInstalled(), true);

  const ctx = createFakeCtx();

  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const editorCallsAfterStartup = ctx.calls.filter((entry) => entry.type === "editor").length;
  assert.equal(editorCallsAfterStartup, 1);

  const dnsCommand = pi.commands.get("do-not-stop");
  assert.ok(dnsCommand);
  await dnsCommand.handler("toggle", ctx);

  const activeEditorLines = createRenderedEditorLines(ctx, 60);
  assert.match(activeEditorLines[0] ?? "", /↻ repeat 0\/1/);
  assert.match(activeEditorLines.at(-1) ?? "", /12\.2%\/272k/);

  await dnsCommand.handler("toggle", ctx);

  const inactiveEditorLines = createRenderedEditorLines(ctx, 60);
  assert.doesNotMatch(inactiveEditorLines[0] ?? "", /↻ repeat/);
});

test("tui-broker registers fresh handlers for later runtimes even when runtime state is already active", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const firstPi = createFakePi();
  tuiBroker(firstPi);

  const firstCtx = createFakeCtx({ sessionId: "session-1" });
  for (const handler of firstPi.events.get("session_start") ?? []) {
    await handler({}, firstCtx);
  }
  assert.equal(firstCtx.calls.filter((entry) => entry.type === "editor").length, 1);
  assert.equal(firstCtx.calls.filter((entry) => entry.type === "footer").length, 1);

  const secondPi = createFakePi();
  tuiBroker(secondPi);
  assert.equal((secondPi.events.get("session_start") ?? []).length, 1);

  const secondCtx = createFakeCtx({ sessionId: "session-2" });
  for (const handler of secondPi.events.get("session_start") ?? []) {
    await handler({}, secondCtx);
  }

  assert.equal(secondCtx.calls.filter((entry) => entry.type === "editor").length, 1);
  assert.equal(secondCtx.calls.filter((entry) => entry.type === "footer").length, 1);
});

test("tui-broker does not reinstall on input or agent lifecycle noise", () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const pi = createFakePi();
  tuiBroker(pi);

  assert.equal(pi.events.has("input"), false);
  assert.equal(pi.events.has("before_agent_start"), false);
  assert.equal(pi.events.has("agent_end"), false);
});

test("tui-broker exposes a reinstall hook so late editor augmenters can reapply it", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const pi = createFakePi();
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const editorCallsAfterStartup = ctx.calls.filter((entry) => entry.type === "editor").length;
  const footerCallsAfterStartup = ctx.calls.filter((entry) => entry.type === "footer").length;
  assert.equal(editorCallsAfterStartup, 1);
  assert.equal(footerCallsAfterStartup, 1);

  requestTuiBrokerEditorReinstall();

  const editorCallsAfterReinstall = ctx.calls.filter((entry) => entry.type === "editor").length;
  const footerCallsAfterReinstall = ctx.calls.filter((entry) => entry.type === "footer").length;
  assert.equal(editorCallsAfterReinstall, 2);
  assert.equal(footerCallsAfterReinstall, 2);
});

test("tui-broker applies registered autocomplete-provider wrappers", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  let wrappedProvider = null;
  registerTuiBrokerAutocompleteProviderWrapper("test-wrapper", (provider) => {
    wrappedProvider = { provider, wrapped: true };
    return wrappedProvider;
  });

  const pi = createFakePi();
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const editor = createEditorInstance(ctx);
  const baseProvider = {
    getSuggestions() {
      return null;
    },
    applyCompletion() {
      return null;
    },
  };

  editor.setAutocompleteProvider(baseProvider);

  assert.deepEqual(wrappedProvider, { provider: baseProvider, wrapped: true });
});

test("tui-broker keeps editor ownership when pi-fff uses broker composition hooks", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const pi = createFakePi();
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  let wrappedProvider = null;
  const createWrappedProvider = (provider) => {
    wrappedProvider = { provider, wrapped: true };
    return wrappedProvider;
  };

  applyFffEditorMode({
    mode: "both",
    setEditorComponent: (factory) => ctx.ui.setEditorComponent(factory),
    createEditorFactory: () => ({ constructor: { name: "FffEditor" } }),
    broker: {
      installed: true,
      registerWrapper: () => registerTuiBrokerAutocompleteProviderWrapper("pi-fff", createWrappedProvider),
      unregisterWrapper: () => unregisterTuiBrokerAutocompleteProviderWrapper("pi-fff"),
      requestReinstall: () => requestTuiBrokerEditorReinstall(),
    },
  });

  const editorCalls = ctx.calls.filter((entry) => entry.type === "editor");
  assert.equal(editorCalls.length, 2);

  const finalEditor = createEditorInstance(ctx, "last");
  assert.equal(finalEditor.constructor.name, "ContextUsageEditor");

  const snapshot = getTuiBrokerRuntimeSnapshot({ sessionName: ctx.sessionManager.getSessionName() });
  assert.deepEqual(snapshot.autocompleteWrappers, ["pi-fff"]);

  const baseProvider = {
    getSuggestions() {
      return null;
    },
    applyCompletion() {
      return null;
    },
  };

  finalEditor.setAutocompleteProvider(baseProvider);

  assert.deepEqual(wrappedProvider, { provider: baseProvider, wrapped: true });
  assert.match(finalEditor.render(60).at(-1) ?? "", /12\.2%\/272k/);
});

test("tui-broker renders the context usage label into the editor bottom border", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const pi = createFakePi();
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const lines = createRenderedEditorLines(ctx, 40);
  assert.match(lines.at(-1) ?? "", /12\.2%\/272k/);
});

test("tui-broker falls back to the startup default model context window before the first turn", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  const tempAgentDir = mkdtempSync(join(tmpdir(), "tui-broker-agent-"));
  mkdirSync(tempAgentDir, { recursive: true });
  writeFileSync(
    join(tempAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4" }),
  );

  const previousAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = tempAgentDir;

  try {
    const pi = createFakePi();
    tuiBroker(pi);

    const ctx = createFakeCtx({
      contextUsage: undefined,
      model: undefined,
      modelRegistry: {
        find(provider, modelId) {
          return provider === "openai-codex" && modelId === "gpt-5.4"
            ? { id: "gpt-5.4", provider: "openai-codex", contextWindow: 272000, reasoning: true }
            : undefined;
        },
        getAvailable() {
          return [];
        },
      },
    });

    for (const handler of pi.events.get("session_start") ?? []) {
      await handler({}, ctx);
    }

    const lines = createRenderedEditorLines(ctx, 40);
    assert.match(lines.at(-1) ?? "", /\?\/272k/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
  }
});

test("tui-broker uses the highest-priority footer path contributor without losing its own layout", async () => {
  __resetTuiBrokerRuntimeForTests();
  __resetDoNotStopRuntimeStoreForTests();

  registerTuiBrokerFooterPathProvider("pi-ssh", ({ sessionName }) => ({
    text: buildPiSshFooterLabel(
      {
        remoteDisplayTarget: "tan@example.com",
        remoteHome: "/remote/home",
        remoteCwd: "/remote/home/project",
        remoteBranch: "main",
      },
      sessionName,
    ),
    priority: 200,
  }));

  const pi = createFakePi();
  tuiBroker(pi);

  const ctx = createFakeCtx();
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const footerFactory = ctx.calls.find((entry) => entry.type === "footer")?.value;
  assert.equal(typeof footerFactory, "function");

  const footer = footerFactory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    {
      getGitBranch: () => "ignored-local-branch",
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    },
  );

  const lines = footer.render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("tan@example.com:~/project (main)"));
  assert.ok(lines[0].endsWith("gpt-5.4 • high"));
});
