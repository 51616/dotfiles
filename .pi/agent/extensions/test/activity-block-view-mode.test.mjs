// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import activityBlockExtension from "../activity-block/index.ts";

const theme = {
  bold: (text) => text,
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

function makePiStub() {
  const handlers = new Map();
  const renderers = new Map();
  const shortcuts = new Map();
  const commands = new Map();

  return {
    handlers,
    renderers,
    shortcuts,
    commands,
    pi: {
      on(name, handler) {
        handlers.set(String(name), handler);
      },
      registerMessageRenderer(customType, renderer) {
        renderers.set(String(customType), renderer);
      },
      registerCommand(name, options) {
        commands.set(String(name), options);
      },
      registerShortcut(shortcut, options) {
        shortcuts.set(String(shortcut), options);
      },
      appendEntry() {},
    },
  };
}

function makeCtx() {
  let terminalInputHandler;
  const notifications = [];
  return {
    hasUI: true,
    getContextUsage() {
      return undefined;
    },
    sessionManager: {
      getBranch() {
        return [];
      },
    },
    ui: {
      setStatus() {},
      setLiveTranscriptMode() {},
      setHistoricalTranscriptMode() {},
      notify(message, level) {
        notifications.push({ message, level });
      },
      onTerminalInput(handler) {
        terminalInputHandler = handler;
        return () => {
          terminalInputHandler = undefined;
        };
      },
    },
    abort() {},
    getTerminalInputHandler() {
      return terminalInputHandler;
    },
    getNotifications() {
      return notifications;
    },
  };
}

async function startTurn(handlers, ctx, text = "hi", turnIndex = 0) {
  return handlers.get("before_turn_response")({
    type: "before_turn_response",
    turnIndex,
    triggerMessages: [{ role: "user", content: [{ type: "text", text }] }],
    systemPrompt: "",
  }, ctx);
}

async function startTool(handlers, ctx, toolCallId, toolName, args) {
  await handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  }, ctx);
}

async function pushThinking(handlers, ctx, thinking) {
  await handlers.get("message_update")({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: "anthropic-messages",
      provider: "faux",
      model: "faux-model",
      timestamp: Date.now(),
    },
    assistantMessageEvent: { type: "thinking_delta", delta: thinking, contentIndex: 0, partial: {} },
  }, ctx);
}

function countVisibleToolRows(component) {
  return component
    .render(96)
    .map((line) => stripAnsi(line))
    .filter((line) => /(▶|✓|!) (\$|read|write|edit)/.test(line)).length;
}

test("activity-block view toggle cycles latest, recent, and all tool rows when each view changes output", async () => {
  const { pi, handlers, renderers, shortcuts } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);

  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });
  await startTool(handlers, ctx, "tool-2", "bash", { command: "printf two" });
  await startTool(handlers, ctx, "tool-3", "edit", { path: "three.ts" });
  await startTool(handlers, ctx, "tool-4", "write", { path: "four.ts" });
  await startTool(handlers, ctx, "tool-5", "read", { path: "five.md" });
  await startTool(handlers, ctx, "tool-6", "bash", { command: "printf six" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  assert.equal(countVisibleToolRows(component), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 5);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 6);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 1);
});

test("activity-block view toggle still visits all view when recent already shows full history", async () => {
  const { pi, handlers, renderers, shortcuts } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);

  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });
  await startTool(handlers, ctx, "tool-2", "bash", { command: "printf two" });
  await startTool(handlers, ctx, "tool-3", "edit", { path: "three.ts" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  assert.equal(countVisibleToolRows(component), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 3);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 3);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 1);
});

test("activity-block view toggle still moves through recent and all after a single-tool start", async () => {
  const { pi, handlers, renderers, shortcuts } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);

  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  assert.equal(countVisibleToolRows(component), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 1);

  await startTool(handlers, ctx, "tool-2", "bash", { command: "printf two" });
  assert.equal(countVisibleToolRows(component), 2);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 2);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 1);
});


test("activity-block view toggle skips full history while expanded thinking is shown", async () => {
  const { pi, handlers, renderers, shortcuts } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);

  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });
  await startTool(handlers, ctx, "tool-2", "bash", { command: "printf two" });
  await startTool(handlers, ctx, "tool-3", "edit", { path: "three.ts" });
  await startTool(handlers, ctx, "tool-4", "write", { path: "four.ts" });
  await startTool(handlers, ctx, "tool-5", "read", { path: "five.md" });
  await startTool(handlers, ctx, "tool-6", "bash", { command: "printf six" });
  await pushThinking(handlers, ctx, "Planning the next step");
  await shortcuts.get("ctrl+alt+t").handler(ctx);

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  assert.equal(countVisibleToolRows(component), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 5);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(component), 5);
});

test("activity-block command sets an explicit tool history view mode", async () => {
  const { pi, handlers, renderers, commands } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);

  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });
  await startTool(handlers, ctx, "tool-2", "bash", { command: "printf two" });
  await startTool(handlers, ctx, "tool-3", "edit", { path: "three.ts" });
  await startTool(handlers, ctx, "tool-4", "write", { path: "four.ts" });
  await startTool(handlers, ctx, "tool-5", "read", { path: "five.md" });
  await startTool(handlers, ctx, "tool-6", "bash", { command: "printf six" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  await commands.get("activity-block").handler("recent", ctx);
  assert.equal(countVisibleToolRows(component), 5);

  await commands.get("activity-block").handler("all", ctx);
  assert.equal(countVisibleToolRows(component), 6);

  await commands.get("activity-block").handler("latest", ctx);
  assert.equal(countVisibleToolRows(component), 1);
});

test("activity-block zen mode hides the block for the whole turn and announces Zen mode", async () => {
  const { pi, handlers, renderers, commands } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);
  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  assert.ok(component.render(96).length > 0);

  await commands.get("activity-block").handler("zen on", ctx);

  assert.deepEqual(ctx.getNotifications(), [{
    message: "Zen mode enabled — hiding the activity block while pi is working.",
    level: "info",
  }]);
  assert.deepEqual(component.render(96), []);

  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(component.render(96), []);
});

test("activity-block zen mode can be turned off to reveal the hidden block", async () => {
  const { pi, handlers, renderers, commands } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);
  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  await commands.get("activity-block").handler("zen on", ctx);
  assert.deepEqual(component.render(96), []);

  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
  assert.deepEqual(component.render(96), []);

  await commands.get("activity-block").handler("zen off", ctx);
  assert.ok(component.render(96).length > 0);
});

test("activity-block zen mode shortcut toggles zen mode and announces Zen mode", async () => {
  const { pi, handlers, renderers, shortcuts } = makePiStub();
  const ctx = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await startTurn(handlers, ctx);
  await startTool(handlers, ctx, "tool-1", "read", { path: "one.md" });

  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details: turn.message.details }, {}, theme);

  await shortcuts.get("ctrl+alt+z").handler(ctx);
  assert.deepEqual(component.render(96), []);
  assert.deepEqual(ctx.getNotifications(), [{
    message: "Zen mode enabled — hiding the activity block while pi is working.",
    level: "info",
  }]);

  await shortcuts.get("ctrl+alt+z").handler(ctx);
  assert.ok(component.render(96).length > 0);
  assert.deepEqual(ctx.getNotifications(), [
    {
      message: "Zen mode enabled — hiding the activity block while pi is working.",
      level: "info",
    },
    {
      message: "Zen mode disabled — showing the activity block again.",
      level: "info",
    },
  ]);
});
