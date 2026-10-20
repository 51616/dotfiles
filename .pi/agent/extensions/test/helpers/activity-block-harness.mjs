// Shared fake of the pi 1.3.0 extension surface used by activity-block tests.
//
// It records what activity-block registers and replays the event order that pi 1.3.0 emits for a run
// (agent-session.js `_startRun` / pi-agent-core `runLoop`):
//   agent_start -> turn_start -> message_start/end(trigger) -> message_start(assistant) -> message_update*
//   -> tool_execution_* -> turn_end -> [steer: turn_start -> message_start(user) -> ...] -> agent_end -> agent_settled
// Session entries written with appendEntry are kept in `entries` in the order pi would persist them, so
// tests can assert transcript placement (anchor below trigger, above the reply).

import stripAnsi from "strip-ansi";
import activityBlockExtension from "../../activity-block/index.ts";

export const plainTheme = {
  bold: (text) => text,
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function assistantMessage(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: EMPTY_USAGE,
    api: "faux",
    provider: "faux",
    model: "faux-model",
    timestamp: Date.now(),
    ...extra,
  };
}

export function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * Build a fake pi + ctx, load activity-block, and expose helpers.
 * @param {{ entries?: object[], hasUI?: boolean, contextUsageTokens?: number, clock?: object }} [options]
 */
export function createActivityBlockHarness(options = {}) {
  const handlers = new Map();
  const entryRenderers = new Map();
  const messageRenderers = new Map();
  const toolRendererResolvers = [];
  const commands = new Map();
  const shortcuts = new Map();
  /** Session branch, in persistence order. Seeded entries model a resumed session. */
  const entries = [...(options.entries ?? [])];
  const appended = [];
  const widgets = new Map();
  const widgetCalls = [];
  const workingVisible = [];
  const notifications = [];
  let renderRequests = 0;
  let contextUsageTokens = options.contextUsageTokens;

  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerEntryRenderer(customType, renderer) {
      entryRenderers.set(customType, renderer);
    },
    registerMessageRenderer(customType, renderer) {
      messageRenderers.set(customType, renderer);
    },
    registerToolRenderer(resolver) {
      toolRendererResolvers.push(resolver);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerShortcut(key, shortcut) {
      shortcuts.set(key, shortcut);
    },
    appendEntry(customType, data) {
      const entry = { type: "custom", customType, data, id: `e${entries.length + 1}`, timestamp: new Date().toISOString() };
      entries.push(entry);
      appended.push({ type: customType, data });
    },
  };

  const tui = {
    requestRender() {
      renderRequests += 1;
    },
  };

  const ui = {
    setWidget(key, content, widgetOptions) {
      widgetCalls.push({ key, content, options: widgetOptions });
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, { component: typeof content === "function" ? content(tui, plainTheme) : content, options: widgetOptions });
    },
    setWorkingVisible(visible) {
      workingVisible.push(visible);
    },
    notify(message, level) {
      notifications.push({ message, level });
    },
    setStatus() {},
  };

  const ctx = {
    hasUI: options.hasUI ?? true,
    ui,
    getContextUsage() {
      return contextUsageTokens === undefined ? undefined : { tokens: contextUsageTokens, contextWindow: 200_000, percent: contextUsageTokens / 2_000 };
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
    abort() {},
    isIdle: () => true,
  };

  activityBlockExtension(pi, options.clock ?? {});

  async function emit(name, event = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler({ type: name, ...event }, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }

  /** pi persists messages on message_end, after extension handlers ran for message_start. */
  async function messageStart(message) {
    await emit("message_start", { message });
  }
  async function messageEnd(message) {
    await emit("message_end", { message });
    entries.push({ type: message.role === "custom" ? "custom_message" : "message", message, id: `e${entries.length + 1}`, timestamp: new Date().toISOString() });
  }

  const run = {
    /** Starts a run triggered by a user prompt (or a custom triggerTurn message). */
    async start(trigger = userMessage("hi")) {
      await emit("agent_start");
      await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
      await messageStart(trigger);
      await messageEnd(trigger);
    },
    /** Streams one assistant message. `content` is the final content. */
    async assistant(content, stopReason = "stop") {
      const message = assistantMessage([], stopReason);
      await messageStart(message);
      for (let index = 0; index < content.length; index += 1) {
        const block = content[index];
        const partial = assistantMessage(content.slice(0, index + 1), stopReason);
        const assistantMessageEvent = block.type === "thinking"
          ? { type: "thinking_delta", contentIndex: index, delta: block.thinking, partial }
          : block.type === "toolCall"
            ? { type: "toolcall_end", contentIndex: index, toolCall: block, partial }
            : { type: "text_delta", contentIndex: index, delta: block.text, partial };
        await emit("message_update", { message: partial, assistantMessageEvent });
      }
      const finalMessage = assistantMessage(content, stopReason);
      await messageEnd(finalMessage);
      return finalMessage;
    },
    async tool(toolCallId, toolName, args, { isError = false, output = "ok" } = {}) {
      await emit("tool_execution_start", { toolCallId, toolName, args });
      const result = { content: [{ type: "text", text: output }], details: undefined };
      await emit("tool_execution_end", { toolCallId, toolName, result, isError });
      const toolResult = { role: "toolResult", toolCallId, toolName, content: result.content, isError, timestamp: Date.now() };
      await messageStart(toolResult);
      await messageEnd(toolResult);
    },
    async turnEnd(message, toolResults = []) {
      await emit("turn_end", { turnIndex: 0, message, toolResults });
    },
    /** A steering or follow-up message injected inside the same agent loop. */
    async steer(message = userMessage("steer")) {
      await emit("turn_start", { turnIndex: 1, timestamp: Date.now() });
      await messageStart(message);
      await messageEnd(message);
    },
    async end(messages = []) {
      await emit("agent_end", { messages });
    },
    async settle(aborted = false) {
      await emit("agent_settled", { aborted });
    },
  };

  function dock() {
    return widgets.get("activity-block-live-dock")?.component;
  }

  function renderDock(width = 80) {
    const component = dock();
    return component ? component.render(width).map((line) => stripAnsi(line)) : [];
  }

  function anchors() {
    return entries.filter((entry) => entry.type === "custom" && entry.customType === "activity-block-turn");
  }

  /** Render the transcript block for an anchor entry exactly as pi's CustomEntryComponent would. */
  function renderAnchor(entry, width = 80) {
    const component = entryRenderers.get("activity-block-turn")(entry, { expanded: false }, plainTheme);
    return component ? component.render(width).map((line) => stripAnsi(line)) : [];
  }

  function renderLegacyAnchor(details, width = 80) {
    const message = { role: "custom", customType: "activity-block-turn", content: "activity block", display: true, details, timestamp: 0 };
    const component = messageRenderers.get("activity-block-turn")(message, { expanded: false }, plainTheme);
    return component ? component.render(width).map((line) => stripAnsi(line)) : [];
  }

  /** Resolve renderers for a tool row like pi's InteractiveMode.getRegisteredToolDefinition. */
  function resolveToolRenderers(toolName, base = { renderShell: "default" }) {
    const resolve = (index) => (index < toolRendererResolvers.length ? toolRendererResolvers[index](toolName, () => resolve(index + 1)) : base);
    return resolve(0);
  }

  return {
    pi,
    ctx,
    handlers,
    commands,
    shortcuts,
    entries,
    appended,
    widgetCalls,
    workingVisible,
    notifications,
    emit,
    run,
    dock,
    renderDock,
    anchors,
    renderAnchor,
    renderLegacyAnchor,
    resolveToolRenderers,
    renderRequests: () => renderRequests,
    setContextUsageTokens(value) {
      contextUsageTokens = value;
    },
    async startSession(reason = "startup") {
      await emit("session_start", { reason });
    },
  };
}

export function stateEntries(harness) {
  return harness.appended.filter((entry) => entry.type === "activity-block-state");
}
