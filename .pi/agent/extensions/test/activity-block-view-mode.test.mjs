// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { createActivityBlockHarness, plainTheme } from "./helpers/activity-block-harness.mjs";

const theme = plainTheme;

/** Start a block and anchor it (pi anchors on the first assistant message). Returns the anchor entry. */
async function startTurn(harness) {
  await harness.run.start();
  await harness.run.assistant([{ type: "text", text: "" }]);
  return harness.anchors().at(-1);
}

async function startTool(harness, toolCallId, toolName, args) {
  await harness.emit("tool_execution_start", { toolCallId, toolName, args });
}

async function pushThinking(harness, thinking) {
  await harness.run.assistant([{ type: "thinking", thinking }]);
}

/**
 * Render the latest block wherever it is visible: the dock while running, the transcript anchor afterwards.
 * Exactly one surface shows a block at a time, so concatenating both is the visible output.
 */
function renderBlock(harness, width = 96) {
  const anchor = harness.anchors().at(-1);
  return [...harness.renderDock(width), ...(anchor ? harness.renderAnchor(anchor, width) : [])];
}

function countVisibleToolRows(harness) {
  return renderBlock(harness)
    .map((line) => stripAnsi(line))
    .filter((line) => /(▶|✓|!) (\$|read|Wrote|Edited|Writing|Editing|Write failed)/.test(line)).length;
}

test("activity-block view toggle cycles latest, recent, and all tool rows when each view changes output", async () => {
  const harness = createActivityBlockHarness();
  const { shortcuts } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);

  await startTool(harness, "tool-1", "read", { path: "one.md" });
  await startTool(harness, "tool-2", "bash", { command: "printf two" });
  await startTool(harness, "tool-3", "edit", { path: "three.ts" });
  await startTool(harness, "tool-4", "write", { path: "four.ts" });
  await startTool(harness, "tool-5", "read", { path: "five.md" });
  await startTool(harness, "tool-6", "bash", { command: "printf six" });

  assert.equal(countVisibleToolRows(harness), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 5);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 6);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 1);
});

test("activity-block view toggle still visits all view when recent already shows full history", async () => {
  const harness = createActivityBlockHarness();
  const { shortcuts } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);

  await startTool(harness, "tool-1", "read", { path: "one.md" });
  await startTool(harness, "tool-2", "bash", { command: "printf two" });
  await startTool(harness, "tool-3", "edit", { path: "three.ts" });

  assert.equal(countVisibleToolRows(harness), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 3);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 3);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 1);
});

test("activity-block view toggle still moves through recent and all after a single-tool start", async () => {
  const harness = createActivityBlockHarness();
  const { shortcuts } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);

  await startTool(harness, "tool-1", "read", { path: "one.md" });

  assert.equal(countVisibleToolRows(harness), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 1);

  await startTool(harness, "tool-2", "bash", { command: "printf two" });
  assert.equal(countVisibleToolRows(harness), 2);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 2);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 1);
});

test("activity-block view toggle skips full history while expanded thinking is shown", async () => {
  const harness = createActivityBlockHarness();
  const { shortcuts } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);

  await startTool(harness, "tool-1", "read", { path: "one.md" });
  await startTool(harness, "tool-2", "bash", { command: "printf two" });
  await startTool(harness, "tool-3", "edit", { path: "three.ts" });
  await startTool(harness, "tool-4", "write", { path: "four.ts" });
  await startTool(harness, "tool-5", "read", { path: "five.md" });
  await startTool(harness, "tool-6", "bash", { command: "printf six" });
  await pushThinking(harness, "Planning the next step");
  await shortcuts.get("ctrl+alt+t").handler(ctx);

  assert.equal(countVisibleToolRows(harness), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 5);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 1);

  await shortcuts.get("ctrl+alt+a").handler(ctx);
  assert.equal(countVisibleToolRows(harness), 5);
});

test("activity-block command sets an explicit tool history view mode", async () => {
  const harness = createActivityBlockHarness();
  const { commands } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);

  await startTool(harness, "tool-1", "read", { path: "one.md" });
  await startTool(harness, "tool-2", "bash", { command: "printf two" });
  await startTool(harness, "tool-3", "edit", { path: "three.ts" });
  await startTool(harness, "tool-4", "write", { path: "four.ts" });
  await startTool(harness, "tool-5", "read", { path: "five.md" });
  await startTool(harness, "tool-6", "bash", { command: "printf six" });

  await commands.get("activity-block").handler("recent", ctx);
  assert.equal(countVisibleToolRows(harness), 5);

  await commands.get("activity-block").handler("all", ctx);
  assert.equal(countVisibleToolRows(harness), 6);

  await commands.get("activity-block").handler("latest", ctx);
  assert.equal(countVisibleToolRows(harness), 1);
});

test("activity-block zen mode hides the block for the whole turn and announces Zen mode", async () => {
  const harness = createActivityBlockHarness();
  const { commands } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);
  await startTool(harness, "tool-1", "read", { path: "one.md" });

  assert.ok(renderBlock(harness).length > 0);

  await commands.get("activity-block").handler("zen on", ctx);

  assert.deepEqual(harness.notifications, [{
    message: "Zen mode enabled — hiding the activity block while pi is working.",
    level: "info",
  }]);
  assert.deepEqual(renderBlock(harness), []);

  await harness.run.end();
  await harness.run.settle();
  assert.deepEqual(renderBlock(harness), []);
});

test("activity-block zen mode can be turned off to reveal the hidden block", async () => {
  const harness = createActivityBlockHarness();
  const { commands } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);
  await startTool(harness, "tool-1", "read", { path: "one.md" });

  await commands.get("activity-block").handler("zen on", ctx);
  assert.deepEqual(renderBlock(harness), []);

  await harness.run.end();
  await harness.run.settle();
  assert.deepEqual(renderBlock(harness), []);

  await commands.get("activity-block").handler("zen off", ctx);
  assert.ok(renderBlock(harness).length > 0);
});

test("activity-block zen mode shortcut toggles zen mode and announces Zen mode", async () => {
  const harness = createActivityBlockHarness();
  const { shortcuts } = harness;
  const ctx = harness.ctx;

  await harness.startSession();
  await startTurn(harness);
  await startTool(harness, "tool-1", "read", { path: "one.md" });

  await shortcuts.get("ctrl+alt+z").handler(ctx);
  assert.deepEqual(renderBlock(harness), []);
  assert.deepEqual(harness.notifications, [{
    message: "Zen mode enabled — hiding the activity block while pi is working.",
    level: "info",
  }]);

  await shortcuts.get("ctrl+alt+z").handler(ctx);
  assert.ok(renderBlock(harness).length > 0);
  assert.deepEqual(harness.notifications, [
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
