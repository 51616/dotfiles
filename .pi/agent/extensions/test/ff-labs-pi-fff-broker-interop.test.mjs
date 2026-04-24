import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tuiBroker from "../tui-broker/index.ts";
import { __resetTuiBrokerRuntimeForTests } from "../tui-broker/lib/runtime.ts";

const PI_FFF_ENTRYPOINT = "/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@ff-labs/pi-fff/src/index.ts";

function createJitiImporter() {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("@mariozechner/jiti");
  return createJiti(import.meta.url, { moduleCache: false });
}

async function loadPiFff() {
  const jiti = createJitiImporter();
  return jiti.import(PI_FFF_ENTRYPOINT, { default: true });
}

function createFakePi() {
  const events = new Map();
  return {
    events,
    on(name, handler) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(handler);
    },
    registerCommand() {},
    registerFlag() {},
    registerTool() {},
    getFlag() {
      return undefined;
    },
    getThinkingLevel() {
      return "high";
    },
  };
}

function createFakeCtx(cwd) {
  const calls = [];
  return {
    calls,
    cwd,
    hasUI: true,
    ui: {
      theme: { fg: (_color, text) => text },
      setEditorComponent(value) {
        calls.push({ type: "editor", value });
      },
      addAutocompleteProvider(value) {
        calls.push({ type: "autocomplete", value });
      },
      setFooter(value) {
        calls.push({ type: "footer", value });
      },
      notify(message, level) {
        calls.push({ type: "notify", message, level });
      },
    },
    sessionManager: {
      getCwd() {
        return cwd;
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
      return { id: "gpt-5.4", provider: "openai-codex", reasoning: true, contextWindow: 272000 };
    },
  };
}

test("active @ff-labs/pi-fff contributes autocomplete without replacing tui-broker editor", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-fff-broker-test-"));
  writeFileSync(join(cwd, "README.md"), "hello\n");

  __resetTuiBrokerRuntimeForTests();
  const pi = createFakePi();
  tuiBroker(pi);
  const piFff = await loadPiFff();
  piFff(pi);

  const ctx = createFakeCtx(cwd);
  for (const handler of pi.events.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const editorCalls = ctx.calls.filter((entry) => entry.type === "editor");
  const autocompleteCalls = ctx.calls.filter((entry) => entry.type === "autocomplete");
  const notifications = ctx.calls.filter((entry) => entry.type === "notify");

  assert.equal(editorCalls.length, 1, "tui-broker should remain the sole editor owner");
  assert.equal(autocompleteCalls.length, 1, "pi-fff should stack an autocomplete provider");
  assert.deepEqual(notifications, []);

  const editor = editorCalls[0].value(
    { terminal: { rows: 40 }, requestRender() {} },
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
  assert.equal(editor.constructor.name, "ContextUsageEditor");
  assert.match(editor.render(60).at(-1) ?? "", /12\.2%\/272k/);
});
