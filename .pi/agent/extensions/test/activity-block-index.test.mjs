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

function makeCtx(entries = [], options = {}) {
  let abortCalls = 0;
  let terminalInputHandler;
  let unsubscribeCalls = 0;
  const historicalModes = [];
  const liveModes = [];
  const statuses = [];
  const widgetCalls = [];
  let contextUsageTokens = options.contextUsageTokens;
  let idle = options.idle ?? true;

  const ui = {
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
  };

  if (options.widgets) {
    ui.setWidget = (key, content, widgetOptions) => {
      widgetCalls.push({ key, content, options: widgetOptions });
    };
  }

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
    ui,
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
      return { abortCalls, unsubscribeCalls, historicalModes, liveModes, statuses, widgetCalls };
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

function latestWidgetCall(widgetCalls, key = "activity-block-live-dock") {
  return widgetCalls.filter((call) => call.key === key).at(-1);
}

function latestVisibleWidgetCall(widgetCalls, key = "activity-block-live-dock") {
  return widgetCalls.filter((call) => call.key === key && call.content !== undefined).at(-1);
}

function renderWidgetCall(call, width = 80) {
  assert.equal(typeof call?.content, "function");
  const component = call.content({}, theme);
  return component.render(width).map((line) => stripAnsi(line));
}

test("activity-block session_start enables historical transcript suppression", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);

  assert.deepEqual(counts().historicalModes, [{ toolRows: "hide", thinking: "hide" }]);
});

test("activity-block no longer installs a terminal escape handler and relies on turn lifecycle events instead", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, getTerminalInputHandler, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  assert.equal(getTerminalInputHandler(), undefined);
  assert.equal(counts().abortCalls, 0);

  const firstTurn = await triggerTurnResponse(handlers, ctx, "hi");
  assert.equal(firstTurn?.message?.details?.turnDisplayId, "1");
  assert.equal(getTerminalInputHandler(), undefined);
  assert.equal(counts().abortCalls, 0);
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

test("activity-block docks the active block above the editor and hides the active transcript duplicate", async () => {
  const { pi, handlers, renderers } = makePiStub();
  const { ctx, counts } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "dock me");
  const widgetCall = latestVisibleWidgetCall(counts().widgetCalls);

  assert.equal(widgetCall?.options?.placement, "aboveEditor");
  assert.ok(renderWidgetCall(widgetCall).some((line) => line.includes("Waiting for the first update")));

  const renderer = renderers.get("activity-block-turn");
  const activeTranscript = renderer({ details: turn.message.details }, {}, theme);
  assert.deepEqual(activeTranscript.render(80), []);
});

test("activity-block live dock reflects thinking and tool lifecycle updates", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await triggerTurnResponse(handlers, ctx, "update dock");
  const beforeThinkingRefreshes = counts().statuses.length;

  await handlers.get("message_update")({
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Checking the repo before using a tool" }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: "anthropic-messages",
      provider: "faux",
      model: "faux-model",
      timestamp: Date.now(),
    },
    assistantMessageEvent: { type: "thinking_delta", delta: "Checking the repo before using a tool", contentIndex: 0, partial: {} },
  }, ctx);

  assert.ok(counts().statuses.length > beforeThinkingRefreshes);
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("Checking the repo before using a tool")));
  const beforeToolStartRefreshes = counts().statuses.length;

  await handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md", offset: 1, limit: 2 },
  }, ctx);

  assert.ok(counts().statuses.length > beforeToolStartRefreshes);
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("read README.md:1-2")));
  const beforeToolUpdateRefreshes = counts().statuses.length;

  await handlers.get("tool_execution_update")({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "NOTES.md", offset: 3, limit: 2 },
    partialResult: { content: [{ type: "text", text: "partial" }] },
  }, ctx);

  assert.ok(counts().statuses.length > beforeToolUpdateRefreshes);
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("read NOTES.md:3-4")));
  const beforeToolEndRefreshes = counts().statuses.length;

  await handlers.get("tool_execution_end")({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  }, ctx);

  assert.ok(counts().statuses.length > beforeToolEndRefreshes);
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("✓ read NOTES.md:3-4")));
});

test("activity-block keeps the terminal block docked until the next input", async () => {
  const { pi, handlers, renderers } = makePiStub();
  const { ctx, counts } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "finish docked");
  const renderer = renderers.get("activity-block-turn");
  const transcript = renderer({ details: turn.message.details }, {}, theme);

  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);

  assert.deepEqual(transcript.render(80), []);
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("COMPLETED!")));

  await handlers.get("input")({ type: "input", text: "next", source: "interactive" }, ctx);

  assert.equal(latestWidgetCall(counts().widgetCalls)?.content, undefined);
  assert.ok(transcript.render(80).map((line) => stripAnsi(line)).some((line) => line.includes("COMPLETED!")));
});

test("activity-block keeps aborted and errored terminal blocks docked until the next input", async () => {
  for (const terminal of [
    { stopReason: "aborted", expected: "Aborted" },
    { stopReason: "error", errorMessage: "boom", expected: "Error: boom" },
  ]) {
    const { pi, handlers, renderers } = makePiStub();
    const { ctx, counts } = makeCtx([], { widgets: true });
    activityBlockExtension(pi);

    await handlers.get("session_start")({}, ctx);
    const turn = await triggerTurnResponse(handlers, ctx, terminal.stopReason);
    const renderer = renderers.get("activity-block-turn");
    const transcript = renderer({ details: turn.message.details }, {}, theme);

    await handlers.get("agent_end")({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [],
        stopReason: terminal.stopReason,
        errorMessage: terminal.errorMessage,
      }],
    }, ctx);

    assert.deepEqual(transcript.render(80), []);
    assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes(terminal.expected)));

    await handlers.get("input")({ type: "input", text: "next", source: "interactive" }, ctx);
    assert.equal(latestWidgetCall(counts().widgetCalls)?.content, undefined);
    assert.ok(transcript.render(80).map((line) => stripAnsi(line)).some((line) => line.includes(terminal.expected)));
  }
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

test("activity-block queued steering replaces the docked block with the next active turn", async () => {
  const { pi, handlers, renderers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx, counts, setIdle } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const firstTurn = await triggerTurnResponse(handlers, ctx, "first");
  const renderer = renderers.get("activity-block-turn");
  const firstTranscript = renderer({ details: firstTurn.message.details }, {}, theme);
  setIdle(false);

  await handlers.get("input")({ type: "input", text: "steer now", source: "interactive" }, ctx);
  await handlers.get("message_start")({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: "steer now" }] },
  }, ctx);

  assert.equal(appended[0].data.snapshot.finalLabel, "Interrupted by steering");
  assert.ok(firstTranscript.render(80).map((line) => stripAnsi(line)).some((line) => line.includes("Interrupted by steering")));
  assert.ok(renderWidgetCall(latestVisibleWidgetCall(counts().widgetCalls)).some((line) => line.includes("Waiting for the first update")));

  const secondTurn = await triggerTurnResponse(handlers, ctx, "steer now", { turnIndex: 1 });
  const secondTranscript = renderer({ details: secondTurn.message.details }, {}, theme);

  assert.equal(secondTurn?.message?.details?.turnDisplayId, "2");
  assert.deepEqual(secondTranscript.render(80), []);
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

test("activity-block fails dangling running tools on bare agent_end", async () => {
  const { pi, handlers } = makePiStub();
  const appended = [];
  pi.appendEntry = (type, data) => appended.push({ type, data });
  const { ctx } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await triggerTurnResponse(handlers, ctx, "run command");
  await handlers.get("tool_execution_start")({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "sleep 60" },
  }, ctx);
  await handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].data.snapshot.runState, "error");
  assert.equal(appended[0].data.snapshot.finalLabel, "Error: active command cancelled");
  assert.equal(appended[0].data.snapshot.activeTools, 0);
  assert.equal(appended[0].data.snapshot.failedTools, 1);
  assert.equal(appended[0].data.snapshot.tools[0]?.state, "error");
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

test("activity-block resume reconstructs historical tool rows when snapshot state is missing", async () => {
  const { pi, handlers, renderers } = makePiStub();
  const details = { turnId: "turn-100-1", turnDisplayId: "1" };
  const persistedEntries = [
    {
      type: "message",
      timestamp: "2026-05-23T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 100 },
    },
    {
      type: "custom_message",
      customType: "activity-block-turn",
      content: "activity block",
      display: true,
      details,
      timestamp: "2026-05-23T00:00:01.000Z",
    },
    {
      type: "message",
      timestamp: "2026-05-23T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md", offset: 1, limit: 10 } }],
        stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: "anthropic-messages",
        provider: "faux",
        model: "faux-model",
        timestamp: 200,
      },
    },
    {
      type: "message",
      timestamp: "2026-05-23T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "hello" }],
        isError: false,
        timestamp: 300,
      },
    },
    {
      type: "message",
      timestamp: "2026-05-23T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: "anthropic-messages",
        provider: "faux",
        model: "faux-model",
        timestamp: 400,
      },
    },
  ];
  const { ctx } = makeCtx(persistedEntries);
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details }, {}, theme);
  const rendered = component.render(80).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("✓ read README.md:1-10")));
  assert.ok(rendered.some((line) => line.includes("1 tool calls")));

  const nextTurn = await triggerTurnResponse(handlers, ctx, "after resume");
  assert.equal(nextTurn?.message?.details?.turnDisplayId, "2");
});

test("activity-block resume recovers tool rows when persisted snapshot has stale empty tools", async () => {
  const { pi, handlers, renderers } = makePiStub();
  const details = { turnId: "turn-100-1", turnDisplayId: "1" };
  const persistedEntries = [
    {
      type: "custom_message",
      customType: "activity-block-turn",
      content: "activity block",
      display: true,
      details,
      timestamp: "2026-05-23T00:00:01.000Z",
    },
    {
      type: "message",
      timestamp: "2026-05-23T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf hi" } }],
        stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: "anthropic-messages",
        provider: "faux",
        model: "faux-model",
        timestamp: 200,
      },
    },
    {
      type: "message",
      timestamp: "2026-05-23T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        timestamp: 300,
      },
    },
    {
      type: "custom",
      customType: "activity-block-state",
      data: {
        turnId: "turn-100-1",
        snapshot: {
          runState: "complete",
          startedAt: 100,
          endedAt: 400,
          finalLabel: "Completed",
          latestThinking: "",
          latestThinkingFull: "",
          thinkingSummaries: [],
          isResponding: false,
          tools: [],
          totalTools: 0,
          activeTools: 0,
          completedTools: 0,
          failedTools: 0,
        },
      },
      timestamp: "2026-05-23T00:00:05.000Z",
    },
  ];
  const { ctx } = makeCtx(persistedEntries);
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const renderer = renderers.get("activity-block-turn");
  const component = renderer({ details }, {}, theme);
  const rendered = component.render(80).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("✓ $ printf hi")));
  assert.ok(rendered.some((line) => line.includes("1 tool calls")));
});

test("activity-block mode default restores core transcript modes and stops inserting new blocks", async () => {
  const { pi, handlers, commands } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await commands.get("activity-block").handler("mode default", ctx);

  assert.deepEqual(counts().historicalModes, [{ toolRows: "hide", thinking: "hide" }, undefined]);
  assert.deepEqual(counts().liveModes, [undefined, undefined]);
  assert.equal(await triggerTurnResponse(handlers, ctx, "default view"), undefined);

  await commands.get("activity-block").handler("mode block", ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "block view");

  assert.equal(turn?.message?.details?.turnDisplayId, "1");
  assert.deepEqual(counts().historicalModes.slice(-2), [undefined, { toolRows: "hide", thinking: "hide" }]);
  assert.deepEqual(counts().liveModes.slice(-2), [undefined, { toolRows: "hide", thinking: "hide", working: "show" }]);
});

test("activity-block mode default clears the live dock when processed", async () => {
  const { pi, handlers, commands, renderers } = makePiStub();
  const { ctx, counts } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "default clears dock");
  const renderer = renderers.get("activity-block-turn");
  const transcript = renderer({ details: turn.message.details }, {}, theme);

  assert.deepEqual(transcript.render(80), []);
  assert.ok(latestVisibleWidgetCall(counts().widgetCalls));

  await commands.get("activity-block").handler("mode default", ctx);

  assert.equal(latestWidgetCall(counts().widgetCalls)?.content, undefined);
  assert.deepEqual(transcript.render(80), []);
  assert.deepEqual(counts().historicalModes.slice(-1), [undefined]);
  assert.deepEqual(counts().liveModes.slice(-1), [undefined]);
});

test("activity-block zen mode hides and restores the retained live dock without exposing transcript duplicates", async () => {
  const { pi, handlers, commands, renderers } = makePiStub();
  const { ctx, counts } = makeCtx([], { widgets: true });
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  const turn = await triggerTurnResponse(handlers, ctx, "zen dock");
  const renderer = renderers.get("activity-block-turn");
  const transcript = renderer({ details: turn.message.details }, {}, theme);

  assert.ok(latestVisibleWidgetCall(counts().widgetCalls));
  assert.deepEqual(transcript.render(80), []);

  await commands.get("activity-block").handler("zen on", ctx);

  assert.equal(latestWidgetCall(counts().widgetCalls)?.content, undefined);
  assert.deepEqual(transcript.render(80), []);

  await commands.get("activity-block").handler("zen off", ctx);

  assert.ok(latestVisibleWidgetCall(counts().widgetCalls));
  assert.deepEqual(transcript.render(80), []);
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

test("activity-block session shutdown clears transcript modes without terminal-listener teardown", async () => {
  const { pi, handlers } = makePiStub();
  const { ctx, counts } = makeCtx();
  activityBlockExtension(pi);

  await handlers.get("session_start")({}, ctx);
  await handlers.get("session_shutdown")({}, ctx);

  assert.equal(counts().unsubscribeCalls, 0);
  assert.deepEqual(counts().historicalModes, [{ toolRows: "hide", thinking: "hide" }, undefined]);
  assert.deepEqual(counts().liveModes, [undefined, undefined]);
});
