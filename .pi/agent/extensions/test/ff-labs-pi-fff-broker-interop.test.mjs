import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import tuiBroker from "../tui-broker/index.ts";
import { __resetTuiBrokerRuntimeForTests } from "../tui-broker/lib/runtime.ts";

function discoverPiFffEntrypoints() {
  const candidates = [];

  try {
    const globalNpmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    if (globalNpmRoot) {
      candidates.push({ label: "global npm", path: join(globalNpmRoot, "@ff-labs/pi-fff/src/index.ts") });
    }
  } catch {
    // The agent package cache below is the runtime-critical target, so keep this
    // test usable even if npm is unavailable in a minimal environment.
  }

  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  candidates.push({
    label: "agent package cache",
    path: join(agentDir, "npm/node_modules/@ff-labs/pi-fff/src/index.ts"),
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path) || !existsSync(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

const PI_FFF_ENTRYPOINTS = discoverPiFffEntrypoints();

function createJitiImporter() {
  const require = createRequire(import.meta.url);
  const { createJiti } = require("@mariozechner/jiti");
  return createJiti(import.meta.url, { moduleCache: false });
}

async function loadPiFff(entrypoint) {
  const jiti = createJitiImporter();
  return jiti.import(entrypoint, { default: true });
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

test("discovers at least one @ff-labs/pi-fff runtime target", () => {
  assert.ok(PI_FFF_ENTRYPOINTS.length > 0, "expected global npm or agent package-cache @ff-labs/pi-fff");
});

for (const target of PI_FFF_ENTRYPOINTS) {
  test(`${target.label} @ff-labs/pi-fff contributes autocomplete without replacing tui-broker editor`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-fff-broker-test-"));
    writeFileSync(join(cwd, "README.md"), "hello\n");

    __resetTuiBrokerRuntimeForTests();
    const pi = createFakePi();
    tuiBroker(pi);
    const piFff = await loadPiFff(target.path);
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
}
