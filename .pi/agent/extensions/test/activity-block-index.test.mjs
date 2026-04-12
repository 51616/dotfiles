// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import activityBlockExtension from "../activity-block/index.ts";

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

function makeCtx(entries = [], options = {}) {
  let abortCalls = 0;
  let terminalInputHandler;
  let unsubscribeCalls = 0;
  const historicalModes = [];
  const liveModes = [];
  const statuses = [];
  let contextUsageTokens = options.contextUsageTokens;
  let idle = options.idle ?? true;

  const ctx = {
    hasUI: true,
    isIdle() {
      return idle;
    },
    abort() {
      abortCalls += 1;
    },
    getContextUsage() {
      if (contextUsageTokens === undefined) return undefined;
      return { tokens: contextUsageTokens, contextWindow: 200_000, percent: contextUsageTokens / 2_000 };
    },
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
    ui: {
      setStatus(_key, text) {
        statuses.push(text);
      },
      setLiveTranscriptMode(mode) {
        liveModes.push(mode);
      },
      setHistoricalTranscriptMode(mode) {
        historicalModes.push(mode);
      },
      notify() {},
      onTerminalInput(handler) {
        terminalInputHandler = handler;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    },
  };

  return {
    ctx,
    setContextUsageTokens(value) {
      contextUsageTokens = value;
    },
    setIdle(value) {
      idle = value;
    },
    getTerminalInputHandler() {
      return terminalInputHandler;
    },
    counts() {
      return { abortCalls, unsubscribeCalls, historicalModes, liveModes, statuses };
    },
  };
}

function triggerTurnResponse(handlers, ctx, text = "hi", options = {}) {
  const role = options.role ?? "user";
  const triggerMessage = role === "custom"
    ? { role: "custom", customType: options.customType ?? "test-custom", content: text }
    : { role: "user", content: [{ type: "text", text }] };

  return handlers.get("before_turn_response")({
    type: "before_turn_response",
    turnIndex: options.turnIndex ?? 0,
    triggerMessages: [triggerMessage],
    systemPrompt: options.systemPrompt ?? "",
  }, ctx);
}

test("activity-block session_start enables historical transcript suppression", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);

  assert.deepEqual(counts().historicalModes, [{ toolRows: "hide", thinking: "hide" }]);
});

test("activity-block escape handler aborts only while a turn is active", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, getTerminalInputHandler, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const handleInput = getTerminalInputHandler();
  assert.equal(typeof handleInput, "function");

  assert.equal(handleInput("x"), undefined);
  assert.equal(handleInput("\u001b"), undefined);
  assert.equal(counts().abortCalls, 0);

  const firstTurn = await triggerTurnResponse(handlers, ctx, "hi");
  assert.equal(firstTurn?.message?.details?.turnDisplayId, "1");

  assert.deepEqual(handleInput("\u001b"), { consume: true });
  assert.equal(counts().abortCalls, 1);
});

test("activity-block keeps historical transcript suppression after a turn finishes", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await triggerTurnResponse(handlers, ctx, "hi");
  await handlers.get("turn_end")({
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [], stopReason: "stop" },
    toolResults: [],
  }, ctx);

  assert.deepEqual(counts().historicalModes, [{ toolRows: "hide", thinking: "hide" }]);
  assert.deepEqual(counts().liveModes, [undefined, { toolRows: "hide", thinking: "hide", working: "show" }]);

  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(counts().liveModes, [undefined, { toolRows: "hide", thinking: "hide", working: "show" }, undefined]);
});

test("activity-block creates a block for custom trigger messages via before_turn_response", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx } = makeCtx();
  activityBlockExtension(pi);

  const turn = await triggerTurnResponse(handlers, ctx, "[autockpt] write checkpoint", {
    role: "custom",
    customType: "pi-self-checkpointing",
  });

  assert.equal(turn?.message?.details?.turnDisplayId, "1");
});

test("activity-block creates a fresh block for each queued turn", async () => {
  const { pi, handlers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx } = makeCtx();
  activityBlockExtension(pi);

  const firstTurn = await triggerTurnResponse(handlers, ctx, "first");
  await handlers.get("turn_end")({
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [], stopReason: "stop" },
    toolResults: [],
  }, ctx);
  const secondTurn = await triggerTurnResponse(handlers, ctx, "second", { turnIndex: 1 });
  await handlers.get("turn_end")({
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [], stopReason: "stop" },
    toolResults: [],
  }, ctx);
  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);

  assert.equal(firstTurn?.message?.details?.turnDisplayId, "1");
  assert.equal(secondTurn?.message?.details?.turnDisplayId, "2");
  assert.equal(appended.length, 2);
  assert.equal(appended[0].type, "activity-block-state");
  assert.equal(appended[1].type, "activity-block-state");
  assert.equal(appended[0].data.turnId, firstTurn?.message?.details?.turnId);
  assert.equal(appended[1].data.turnId, secondTurn?.message?.details?.turnId);
});

test("activity-block keeps one block across tool-result continuation boundaries until agent_end", async () => {
  const { pi, handlers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const firstTurn = await triggerTurnResponse(handlers, ctx, "inspect");
  await handlers.get("turn_end")({
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [], stopReason: "stop" },
    toolResults: [{ role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [], isError: false }],
  }, ctx);

  assert.equal(firstTurn?.message?.details?.turnDisplayId, "1");
  assert.equal(appended.length, 0);
  assert.deepEqual(counts().liveModes, [undefined, { toolRows: "hide", thinking: "hide", working: "show" }]);

  const continuationTurn = await handlers.get("before_turn_response")({
    type: "before_turn_response",
    turnIndex: 1,
    triggerMessages: [],
    systemPrompt: "",
  }, ctx);

  assert.equal(continuationTurn, undefined);
  assert.equal(appended.length, 0);
  assert.deepEqual(counts().liveModes, [
    undefined,
    { toolRows: "hide", thinking: "hide", working: "show" },
    { toolRows: "hide", thinking: "hide", working: "show" },
  ]);

  await handlers.get("turn_end")({
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [], stopReason: "stop" },
    toolResults: [],
  }, ctx);

  assert.equal(appended.length, 0);
  assert.deepEqual(counts().liveModes, [
    undefined,
    { toolRows: "hide", thinking: "hide", working: "show" },
    { toolRows: "hide", thinking: "hide", working: "show" },
  ]);

  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.turnId, firstTurn?.message?.details?.turnId);
  assert.deepEqual(counts().liveModes, [
    undefined,
    { toolRows: "hide", thinking: "hide", working: "show" },
    { toolRows: "hide", thinking: "hide", working: "show" },
    undefined,
  ]);
});

test("activity-block freezes the current block when a queued steering message starts processing", async () => {
  const { pi, handlers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx, counts, setIdle } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const firstTurn = await triggerTurnResponse(handlers, ctx, "first");
  setIdle(false);

  await handlers.get("input")({ type: "input", text: "steer now", source: "interactive" }, ctx);

  assert.equal(appended.length, 0);
  assert.deepEqual(counts().liveModes, [undefined, { toolRows: "hide", thinking: "hide", working: "show" }]);

  await handlers.get("message_start")({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "steer now" }] },
  }, ctx);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.turnId, firstTurn?.message?.details?.turnId);
  assert.equal(appended[0].data.snapshot.finalLabel, "Interrupted by steering");
  assert.deepEqual(counts().liveModes, [
    undefined,
    { toolRows: "hide", thinking: "hide", working: "show" },
    { toolRows: "hide", thinking: "hide", working: "show" },
  ]);

  const secondTurn = await triggerTurnResponse(handlers, ctx, "steer now", { turnIndex: 1 });
  assert.equal(secondTurn?.message?.details?.turnDisplayId, "2");
  assert.equal(appended.length, 1);
});

test("activity-block agent_end without turn_end persists the terminal error state", async () => {
  const { pi, handlers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await triggerTurnResponse(handlers, ctx, "hi");
  await handlers.get("agent_end")({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "boom" }],
  }, ctx);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.snapshot.runState, "error");
  assert.equal(appended[0].data.snapshot.finalLabel, "Error: boom");
});

test("activity-block resume continues the persisted turn counter", async () => {
  const { pi, handlers } = makePiStub();
  const persistedEntries = [
    {
      type: "custom",
      customType: "activity-block-state",
      data: {
        turnId: "turn-100-7",
        snapshot: {
          runState: "complete",
          startedAt: 100,
          endedAt: 120,
          finalLabel: "complete",
          latestThinking: "",
          thinkingSummaries: [],
          isResponding: false,
          tools: [],
          totalTools: 0,
          activeTools: 0,
          completedTools: 0,
          failedTools: 0,
        },
      },
    },
  ];
  const { ctx } = makeCtx(persistedEntries);
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "after resume");

  assert.equal(turn?.message?.details?.turnDisplayId, "8");
});

test("activity-block keeps only the thinking expansion control", () => {
  const { pi, shortcuts, commands } = makePiStub();
  activityBlockExtension(pi);

  assert.ok(shortcuts.has("ctrl+alt+t"));
  assert.ok(!shortcuts.has("ctrl+alt+o"));
  assert.ok(!shortcuts.has("ctrl+t"));
  assert.ok(!shortcuts.has("ctrl+o"));
  assert.ok(commands.has("activity-block-thinking"));
  assert.ok(!commands.has("activity-block-tool"));
});

test("activity-block does not publish a status-bar hint", async () => {
  const { pi, handlers, shortcuts } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await triggerTurnResponse(handlers, ctx, "hi");
  await shortcuts.get("ctrl+alt+a")?.handler(ctx);
  await shortcuts.get("ctrl+alt+t")?.handler(ctx);

  const statuses = counts().statuses.filter(Boolean);
  assert.deepEqual(statuses, []);
});

test("activity-block context token counts stay scoped to the active block", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let tick;
  globalThis.setInterval = (callback) => {
    tick = callback;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};

  try {
    const { pi, handlers, renderers } = makePiStub();
    const { ctx, setContextUsageTokens } = makeCtx([], { contextUsageTokens: 1200 });
    activityBlockExtension(pi);

    await handlers.get("session_start")({}, ctx);
    const turn = await triggerTurnResponse(handlers, ctx, "token test");
    const renderer = renderers.get("activity-block-turn");
    const component = renderer({ details: turn.message.details }, {}, {
      bold: (text) => text,
      fg: (_name, text) => text,
      bg: (_name, text) => text,
      italic: (text) => text,
      underline: (text) => text,
      strikethrough: (text) => text,
    });

    let rendered = component.render(56).map((line) => stripAnsi(line));
    assert.ok(!rendered.some((line) => line.includes("tokens")));

    setContextUsageTokens(1700);
    tick?.();
    rendered = component.render(56).map((line) => stripAnsi(line));
    assert.ok(rendered.some((line) => line.includes("< 1K tokens")));

    setContextUsageTokens(2300);
    tick?.();
    rendered = component.render(56).map((line) => stripAnsi(line));
    assert.ok(rendered.some((line) => line.includes(" 1K tokens")));
    assert.ok(!rendered.some((line) => line.includes("< 1K tokens")));
    assert.ok(!rendered.some((line) => line.includes(" 2K tokens")));
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("activity-block session shutdown unsubscribes terminal input listener", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);

  assert.equal(counts().unsubscribeCalls, 1);
});
