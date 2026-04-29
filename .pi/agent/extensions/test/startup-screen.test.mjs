import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import startupScreen, { discoverExtensions, discoverPromptFiles } from "../startup-screen/index.ts";

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createPiStub() {
  const handlers = new Map();
  const commands = new Map();

  return {
    handlers,
    commands,
    pi: {
      on(name, handler) {
        handlers.set(String(name), handler);
      },
      registerCommand(name, spec) {
        commands.set(String(name), spec);
      },
    },
  };
}

function createCtx(cwd) {
  const calls = [];

  return {
    calls,
    hasUI: true,
    cwd,
    ui: {
      setHeader(value) {
        calls.push({ type: "setHeader", value });
      },
      notify(message, level) {
        calls.push({ type: "notify", message, level });
      },
    },
  };
}

test("discoverExtensions merges project and user extension inventories and tags their scopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-screen-exts-"));
  const projectRoot = path.join(root, "project");
  const agentDir = path.join(root, "agent");

  try {
    writeFile(path.join(projectRoot, ".pi", "extensions", "project-folder", "index.ts"), "export default 1;\n");
    writeFile(path.join(projectRoot, ".pi", "extensions", "project-file.mts"), "export default 1;\n");
    writeFile(path.join(projectRoot, ".pi", "extensions", "shared", "index.ts"), "export default 1;\n");
    writeFile(path.join(projectRoot, ".pi", "extensions", ".hidden.ts"), "export default 1;\n");
    writeFile(path.join(projectRoot, ".pi", "extensions", "docs-only", "README.md"), "not an extension\n");

    writeFile(path.join(agentDir, "extensions", "shared", "package.json"), "{}\n");
    writeFile(path.join(agentDir, "extensions", "user-folder", "index.ts"), "export default 1;\n");
    writeFile(path.join(agentDir, "extensions", "user-file.js"), "export default 1;\n");

    assert.deepEqual(discoverExtensions(projectRoot, agentDir), [
      { name: "project-file", scopes: ["project"] },
      { name: "project-folder", scopes: ["project"] },
      { name: "shared", scopes: ["project", "user"] },
      { name: "user-file", scopes: ["user"] },
      { name: "user-folder", scopes: ["user"] },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverPromptFiles lists active prompt inputs in load order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-screen-prompt-files-"));
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(workspaceRoot, "apps", "demo");
  const agentDir = path.join(root, "agent");

  try {
    writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "global append\n");
    writeFile(path.join(agentDir, "AGENTS.md"), "global agents\n");
    writeFile(path.join(workspaceRoot, "CLAUDE.md"), "workspace rules\n");
    writeFile(path.join(projectRoot, "AGENTS.md"), "project rules\n");
    writeFile(path.join(projectRoot, ".pi", "SYSTEM.md"), "project system\n");

    assert.deepEqual(discoverPromptFiles(projectRoot, agentDir), [
      { name: path.join(projectRoot, ".pi", "SYSTEM.md"), scopes: ["project"] },
      { name: path.join(agentDir, "APPEND_SYSTEM.md"), scopes: ["user"] },
      { name: path.join(agentDir, "AGENTS.md"), scopes: ["user"] },
      { name: path.join(workspaceRoot, "CLAUDE.md"), scopes: ["project"] },
      { name: path.join(projectRoot, "AGENTS.md"), scopes: ["project"] },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup-screen registers refresh and toggle commands that own the startup header", async () => {
  const { pi, handlers, commands } = createPiStub();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "startup-screen-cwd-"));

  try {
    writeFile(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "project append\n");

    startupScreen(pi);

    assert.ok(handlers.has("session_start"));
    assert.ok(commands.has("startup-screen"));
    assert.ok(commands.has("startup-screen-off"));
    assert.ok(commands.has("startup-screen-on"));

    const ctx = createCtx(cwd);
    await handlers.get("session_start")({}, ctx);

    const firstHeaderCall = ctx.calls.find((entry) => entry.type === "setHeader");
    assert.equal(typeof firstHeaderCall?.value, "function");

    const header = firstHeaderCall.value({}, {
      fg(_token, text) {
        return text;
      },
      bold(text) {
        return text;
      },
    });
    const renderedHeader = header.render(80).join("\n");
    assert.match(renderedHeader, /Startup Screen/);
    assert.match(renderedHeader, /Prompt Files/);
    assert.match(renderedHeader, /APPEND_SYSTEM\.md/);

    await commands.get("startup-screen-off").handler("", ctx);
    assert.deepEqual(ctx.calls.at(-2), { type: "setHeader", value: undefined });
    assert.deepEqual(ctx.calls.at(-1), {
      type: "notify",
      message: "Built-in startup header restored.",
      level: "info",
    });

    await commands.get("startup-screen-on").handler("", ctx);
    assert.equal(typeof ctx.calls.at(-2)?.value, "function");
    assert.deepEqual(ctx.calls.at(-1), {
      type: "notify",
      message: "Startup screen header enabled.",
      level: "info",
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
