// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
// Lifecycle contract of activity-block on the pi 1.3.0 public extension API.
import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantMessage,
  createActivityBlockHarness,
  stateEntries,
  userMessage,
} from "./helpers/activity-block-harness.mjs";

const thinking = (text) => ({ type: "thinking", thinking: text });
const text = (value) => ({ type: "text", text: value });
const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

function entryIndex(harness, predicate) {
  return harness.entries.findIndex(predicate);
}

test("session_start installs one above-editor dock and hands the working row to the block", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();

  const docks = harness.widgetCalls.filter((call) => call.key === "activity-block-live-dock");
  assert.equal(docks.length, 1);
  assert.equal(docks[0].options?.placement, "aboveEditor");
  assert.deepEqual(harness.workingVisible, [false]);
  // Idle dock is height-neutral: no block, no rows.
  assert.deepEqual(harness.renderDock(), []);
});

test("headless sessions do not touch UI surfaces but still persist blocks", async () => {
  const harness = createActivityBlockHarness({ hasUI: false });
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([text("done")]);
  await harness.run.end();
  await harness.run.settle();

  assert.equal(harness.widgetCalls.length, 0);
  assert.deepEqual(harness.workingVisible, []);
  assert.equal(harness.anchors().length, 1);
  assert.equal(stateEntries(harness).length, 1);
});

test("a run shows a live dock and anchors its block between the prompt and the reply", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start(userMessage("inspect"));

  assert.ok(harness.renderDock().some((line) => line.includes("Waiting for the first update")));
  assert.equal(harness.anchors().length, 0, "anchor waits for the first assistant message");

  const reply = await harness.run.assistant([thinking("Checking the repo"), toolCall("t1", "read", { path: "README.md" })], "toolUse");
  const promptIndex = entryIndex(harness, (entry) => entry.message?.role === "user");
  const anchorIndex = entryIndex(harness, (entry) => entry.customType === "activity-block-turn");
  const replyIndex = entryIndex(harness, (entry) => entry.message === reply);
  assert.ok(promptIndex < anchorIndex && anchorIndex < replyIndex, "anchor sits below the prompt and above the reply");

  // While the block is docked, its transcript twin renders nothing (no duplicate block).
  assert.deepEqual(harness.renderAnchor(harness.anchors()[0]), []);
  assert.ok(harness.renderDock().some((line) => line.includes("Checking the repo")));
});

test("dock tracks thinking and tool lifecycle and requests renders", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  const before = harness.renderRequests();
  await harness.run.assistant([thinking("Planning"), toolCall("t1", "read", { path: "README.md", offset: 1, limit: 2 })], "toolUse");
  await harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "README.md", offset: 1, limit: 2 } });
  assert.ok(harness.renderDock().some((line) => line.includes("read README.md:1-2")));
  await harness.emit("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "x" }] }, isError: false });
  assert.ok(harness.renderDock().some((line) => line.includes("✓ read README.md:1-2")));
  assert.ok(harness.renderRequests() > before, "controller asks the TUI to redraw the dock");
});

test("one block spans tool-result continuations and finalizes on agent_settled", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  const first = await harness.run.assistant([toolCall("t1", "bash", { command: "ls" })], "toolUse");
  await harness.run.tool("t1", "bash", { command: "ls" });
  await harness.run.turnEnd(first);
  const second = await harness.run.assistant([text("All done")]);
  await harness.run.turnEnd(second);

  assert.equal(harness.anchors().length, 1, "continuation turns reuse the block");
  assert.equal(stateEntries(harness).length, 0);

  await harness.run.end([first, second]);
  assert.equal(stateEntries(harness).length, 0, "agent_end alone is not final");
  assert.ok(harness.renderDock().length > 0, "dock stays up until the run settles");

  await harness.run.settle();
  const [state] = stateEntries(harness);
  assert.equal(state.data.turnId, harness.anchors()[0].data.turnId);
  assert.equal(state.data.snapshot.runState, "complete");
  assert.equal(state.data.snapshot.totalTools, 1);
  assert.deepEqual(harness.renderDock(), [], "dock clears once settled");
  assert.ok(harness.renderAnchor(harness.anchors()[0]).some((line) => line.includes("COMPLETED!")));
});

test("retry and compaction continuations within one prompt keep a single block", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  const failed = await harness.run.assistant([], "error");
  await harness.run.end([failed]);
  // pi retries with agent.continue(): a second agent_start without a new trigger message.
  await harness.emit("agent_start");
  await harness.emit("turn_start", { turnIndex: 0 });
  await harness.run.assistant([text("recovered")]);
  await harness.run.end();
  await harness.run.settle();

  assert.equal(harness.anchors().length, 1);
  const [state] = stateEntries(harness);
  assert.equal(state.data.snapshot.runState, "complete", "the retry's success replaces the earlier error");
});

test("a steering message freezes the current block and anchors a new one under the steer", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start(userMessage("first"));
  const first = await harness.run.assistant([toolCall("t1", "read", { path: "a.md" })], "toolUse");
  await harness.run.tool("t1", "read", { path: "a.md" });
  await harness.run.turnEnd(first);

  const steer = userMessage("actually check b.md");
  await harness.run.steer(steer);
  const [frozen] = stateEntries(harness);
  assert.equal(frozen.data.turnId, harness.anchors()[0].data.turnId);
  assert.equal(frozen.data.snapshot.finalLabel, "Interrupted by steering");
  assert.ok(harness.renderAnchor(harness.anchors()[0]).some((line) => line.includes("Interrupted by steering")));
  assert.ok(harness.renderDock().some((line) => line.includes("Waiting for the first update")), "dock now shows the new block");

  const reply = await harness.run.assistant([text("checked b.md")]);
  const anchors = harness.anchors();
  assert.equal(anchors.length, 2);
  assert.equal(anchors[1].data.turnDisplayId, "2");
  const steerIndex = entryIndex(harness, (entry) => entry.message === steer);
  const secondAnchorIndex = harness.entries.indexOf(anchors[1]);
  const replyIndex = entryIndex(harness, (entry) => entry.message === reply);
  assert.ok(steerIndex < secondAnchorIndex && secondAnchorIndex < replyIndex, "second block sits under the steering message");

  await harness.run.end();
  await harness.run.settle();
  assert.equal(stateEntries(harness).length, 2);
  assert.equal(stateEntries(harness)[1].data.turnId, anchors[1].data.turnId);
});

// Found in tmux E2E: a follow-up (Alt+Enter) arrives after the loop finished its work, so the earlier block
// completed normally and must not be labeled as interrupted.
test("a follow-up after a finished turn completes the earlier block instead of interrupting it", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start(userMessage("slow"));
  const first = await harness.run.assistant([toolCall("t1", "bash", { command: "sleep" })], "toolUse");
  await harness.run.tool("t1", "bash", { command: "sleep" });
  await harness.run.turnEnd(first);
  const done = await harness.run.assistant([text("SLOW-DONE")]);
  await harness.run.turnEnd(done);
  await harness.run.steer(userMessage("follow up"));

  const [frozen] = stateEntries(harness);
  assert.equal(frozen.data.snapshot.runState, "complete");
  assert.equal(frozen.data.snapshot.finalLabel, "Completed");
  assert.equal(frozen.data.snapshot.totalTools, 1);
});

// Regression (found in tmux E2E on pi 1.3.0): agent_end carries every message of the whole run. Tool results
// from the block before a steer must not be adopted by the block after it.
test("a post-steer block does not adopt tool results from the earlier block at agent_end", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start(userMessage("slow"));
  const first = await harness.run.assistant([toolCall("t1", "bash", { command: "sleep 6" })], "toolUse");
  await harness.run.tool("t1", "bash", { command: "sleep 6" });
  await harness.run.turnEnd(first);
  await harness.run.steer(userMessage("steer now"));
  const reply = await harness.run.assistant([text("ECHO: steer now")]);
  const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false };
  await harness.run.end([first, toolResult, userMessage("steer now"), reply]);
  await harness.run.settle();

  const [frozen, second] = stateEntries(harness);
  assert.equal(frozen.data.snapshot.totalTools, 1);
  assert.equal(second.data.snapshot.totalTools, 0, "the steer segment ran no tools");
  assert.equal(second.data.snapshot.finalLabel, "Completed");
});

test("the run's own trigger message and custom triggerTurn starts do not split", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start({ role: "custom", customType: "pi-self-checkpointing", content: "[autockpt]", display: true, timestamp: 0 });
  await harness.run.assistant([text("ok")]);
  await harness.run.end();
  await harness.run.settle();

  assert.equal(harness.anchors().length, 1);
  assert.equal(stateEntries(harness).length, 1);
  assert.equal(stateEntries(harness)[0].data.snapshot.finalLabel, "Completed");
});

test("a displayed custom message delivered mid-run splits like a steer", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "read", { path: "a.md" })], "toolUse");
  await harness.run.steer({ role: "custom", customType: "goal-continue", content: "keep going", display: true, timestamp: 0 });
  await harness.run.assistant([text("continuing")]);
  assert.equal(harness.anchors().length, 2);
});

test("hidden custom messages and tool results never split a block", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "read", { path: "a.md" })], "toolUse");
  await harness.emit("message_start", { message: { role: "custom", customType: "ctx", content: "x", display: false, timestamp: 0 } });
  await harness.run.tool("t1", "read", { path: "a.md" });
  await harness.run.assistant([text("done")]);
  assert.equal(harness.anchors().length, 1);
  assert.equal(stateEntries(harness).length, 0);
});

test("errors before any assistant output leave no orphan block", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.end([assistantMessage([text("")], "error", { errorMessage: "boom" })]);
  await harness.run.settle();

  assert.equal(harness.anchors().length, 0);
  assert.equal(stateEntries(harness).length, 0);
  assert.deepEqual(harness.renderDock(), []);
});

test("terminal states persist error, abort, and dangling tool failures", async () => {
  for (const scenario of [
    { stopReason: "aborted", expected: "Aborted", runState: "aborted" },
    { stopReason: "error", errorMessage: "boom", expected: "Error: boom", runState: "error" },
  ]) {
    const harness = createActivityBlockHarness();
    await harness.startSession();
    await harness.run.start();
    const failed = await harness.run.assistant([text("partial")], scenario.stopReason);
    await harness.run.end([{ ...failed, errorMessage: scenario.errorMessage }]);
    await harness.run.settle(scenario.stopReason === "aborted");
    const [state] = stateEntries(harness);
    assert.equal(state.data.snapshot.runState, scenario.runState);
    assert.equal(state.data.snapshot.finalLabel, scenario.expected);
    assert.ok(harness.renderAnchor(harness.anchors()[0]).some((line) => line.includes(scenario.expected)));
  }

  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "bash", { command: "sleep 60" })], "toolUse");
  await harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "sleep 60" } });
  await harness.run.end();
  await harness.run.settle(true);
  const [state] = stateEntries(harness);
  assert.equal(state.data.snapshot.runState, "error");
  assert.equal(state.data.snapshot.finalLabel, "Error: active command cancelled");
  assert.equal(state.data.snapshot.failedTools, 1);
});

test("nested codemode tool calls are not counted as block tool rows", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "codemode", { script: "x" })], "toolUse");
  await harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "codemode", args: {} });
  await harness.emit("tool_execution_start", { toolCallId: "t1/1", toolName: "read", args: { path: "a" }, parentToolCallId: "t1" });
  await harness.emit("tool_execution_end", { toolCallId: "t1/1", toolName: "read", result: { content: [] }, isError: false, parentToolCallId: "t1" });
  await harness.emit("tool_execution_end", { toolCallId: "t1", toolName: "codemode", result: { content: [] }, isError: false });
  await harness.run.end();
  await harness.run.settle();
  assert.equal(stateEntries(harness)[0].data.snapshot.totalTools, 1);
});

test("tool rows are hidden in block mode and restored in default mode", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  const base = { renderShell: "default", renderCall: () => ({ render: () => ["base"] }) };

  const hidden = harness.resolveToolRenderers("bash", base);
  assert.equal(hidden.renderShell, "self");
  assert.deepEqual(hidden.renderCall({}, {}, {}).render(80), []);
  assert.deepEqual(hidden.renderResult({ content: [] }, { expanded: false, isPartial: false }, {}, {}).render(80), []);

  await harness.commands.get("activity-block").handler("mode default", harness.ctx);
  assert.equal(harness.resolveToolRenderers("bash", base), base);
  assert.deepEqual(harness.workingVisible.at(-1), true, "default mode gives the working row back to pi");

  await harness.commands.get("activity-block").handler("mode block", harness.ctx);
  assert.equal(harness.resolveToolRenderers("bash", base).renderShell, "self");
  assert.deepEqual(harness.workingVisible.at(-1), false);
});

test("default mode stops new blocks and finalizes a running block instead of dropping it", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "read", { path: "a.md" })], "toolUse");

  await harness.commands.get("activity-block").handler("mode default", harness.ctx);
  const [state] = stateEntries(harness);
  assert.equal(state.data.snapshot.finalLabel, "Switched to default view");
  assert.deepEqual(harness.renderDock(), []);
  assert.deepEqual(harness.renderAnchor(harness.anchors()[0]), [], "default mode hides blocks");
  assert.match(harness.notifications.at(-1).message, /Default pi tool-call view/);

  await harness.run.end();
  await harness.run.settle();
  await harness.run.start();
  await harness.run.assistant([text("plain")]);
  assert.equal(harness.anchors().length, 1, "no new block while in default mode");
});

test("zen mode hides the dock and transcript blocks and restores them", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([toolCall("t1", "read", { path: "a.md" })], "toolUse");
  assert.ok(harness.renderDock().length > 0);

  await harness.commands.get("activity-block").handler("zen on", harness.ctx);
  assert.deepEqual(harness.renderDock(), []);
  assert.deepEqual(harness.renderAnchor(harness.anchors()[0]), []);
  assert.match(harness.notifications.at(-1).message, /Zen mode enabled/);

  await harness.shortcuts.get("ctrl+alt+z").handler(harness.ctx);
  assert.ok(harness.renderDock().length > 0);
  assert.deepEqual(harness.renderAnchor(harness.anchors()[0]), [], "running block is still owned by the dock");
  assert.match(harness.notifications.at(-1).message, /Zen mode disabled/);
});

test("resume restores snapshots and continues the turn counter for new and legacy anchors", async () => {
  const persisted = {
    runState: "complete", startedAt: 100, endedAt: 120, finalLabel: "Completed",
    latestThinking: "", latestThinkingFull: "", thinkingSummaries: [], isResponding: false,
    tools: [], totalTools: 0, activeTools: 0, completedTools: 0, failedTools: 0,
  };
  const entries = [
    { type: "custom_message", customType: "activity-block-turn", content: "activity block", display: true, details: { turnId: "turn-100-6", turnDisplayId: "6" }, timestamp: "2026-05-23T00:00:00.000Z" },
    { type: "custom", customType: "activity-block-state", data: { turnId: "turn-100-6", snapshot: persisted } },
    { type: "custom", customType: "activity-block-turn", data: { turnId: "turn-200-7", turnDisplayId: "7" }, timestamp: "2026-10-20T00:00:00.000Z" },
    { type: "custom", customType: "activity-block-state", data: { turnId: "turn-200-7", snapshot: persisted } },
  ];
  const harness = createActivityBlockHarness({ entries });
  await harness.startSession("resume");

  assert.ok(harness.renderLegacyAnchor({ turnId: "turn-100-6", turnDisplayId: "6" }).some((line) => line.includes("COMPLETED!")));
  assert.ok(harness.renderAnchor(entries[2]).some((line) => line.includes("COMPLETED!")));

  await harness.run.start();
  await harness.run.assistant([text("next")]);
  assert.equal(harness.anchors().at(-1).data.turnDisplayId, "8");
});

test("resume reconstructs tool rows from the transcript when the snapshot is missing", async () => {
  const anchor = { type: "custom", customType: "activity-block-turn", data: { turnId: "turn-100-1", turnDisplayId: "1" }, timestamp: "2026-10-20T00:00:01.000Z" };
  const entries = [
    { type: "message", timestamp: "2026-10-20T00:00:00.000Z", message: userMessage("inspect") },
    anchor,
    { type: "message", timestamp: "2026-10-20T00:00:02.000Z", message: assistantMessage([toolCall("t1", "read", { path: "README.md", offset: 1, limit: 10 })], "toolUse") },
    { type: "message", timestamp: "2026-10-20T00:00:03.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "hi" }], isError: false, timestamp: 300 } },
    { type: "message", timestamp: "2026-10-20T00:00:04.000Z", message: assistantMessage([text("done")]) },
  ];
  const harness = createActivityBlockHarness({ entries });
  await harness.startSession("resume");

  const rendered = harness.renderAnchor(anchor);
  assert.ok(rendered.some((line) => line.includes("✓ read README.md:1-10")));
  assert.ok(rendered.some((line) => line.includes("1 tool calls")));
});

test("legacy custom_message anchors are filtered out of model context", async () => {
  const harness = createActivityBlockHarness();
  const messages = [
    userMessage("hi"),
    { role: "custom", customType: "activity-block-turn", content: "activity block", display: true, timestamp: 0 },
    { role: "custom", customType: "other", content: "keep", display: true, timestamp: 0 },
  ];
  const result = await harness.emit("context", { messages });
  assert.deepEqual(result.messages.map((message) => message.customType ?? message.role), ["user", "other"]);
});

test("session_tree re-hydrates the branch and drops the active block", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([text("x")]);
  await harness.emit("session_tree", { newLeafId: null, oldLeafId: null });
  assert.deepEqual(harness.renderDock(), []);
});

test("block token count is scoped to the block via the context-usage baseline", async () => {
  const ticks = [];
  const harness = createActivityBlockHarness({
    contextUsageTokens: 1200,
    clock: { setInterval: (callback) => { ticks.push(callback); return {}; }, clearInterval() {} },
  });
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([thinking("x")]);
  assert.ok(!harness.renderDock(56).some((line) => line.includes("tokens")));

  harness.setContextUsageTokens(1700);
  for (const tick of ticks) tick();
  assert.ok(harness.renderDock(56).some((line) => line.includes("< 1K tokens")));

  harness.setContextUsageTokens(2300);
  for (const tick of ticks) tick();
  const lines = harness.renderDock(56);
  assert.ok(lines.some((line) => line.includes(" 1K tokens")));
  assert.ok(!lines.some((line) => line.includes("< 1K tokens")));
});

test("timers stop when the block finishes and on shutdown", async () => {
  const live = new Set();
  const harness = createActivityBlockHarness({
    clock: {
      setInterval: (callback) => { const handle = { callback }; live.add(handle); return handle; },
      clearInterval: (handle) => live.delete(handle),
    },
  });
  await harness.startSession();
  await harness.run.start();
  await harness.run.assistant([thinking("x")]);
  assert.ok(live.size > 0);
  await harness.run.end();
  await harness.run.settle();
  assert.equal(live.size, 0);

  await harness.run.start();
  await harness.run.assistant([thinking("y")]);
  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(live.size, 0);
});

test("controls: thinking toggle, view cycle, and no status-bar output", async () => {
  const harness = createActivityBlockHarness();
  await harness.startSession();
  assert.ok(harness.shortcuts.has("ctrl+alt+t"));
  assert.ok(harness.shortcuts.has("ctrl+alt+a"));
  assert.ok(harness.commands.has("activity-block-thinking"));
  assert.ok(!harness.commands.has("activity-block-tool"));

  await harness.commands.get("activity-block-thinking").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /No activity block/);
});
