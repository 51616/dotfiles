// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { ActivityBlockMessageComponent, formatActivityBlock } from "../activity-block/lib/activity-block-widget.ts";

initTheme();

const theme = {
  bold: (text) => text,
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

const resetBoldTheme = {
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

const markerBoldTheme = {
  bold: (text) => `<b>${text}</b>`,
  fg: (_name, text) => text,
  bg: (_name, text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

function createSnapshot(overrides = {}) {
  return {
    runState: "running",
    startedAt: 0,
    endedAt: undefined,
    finalLabel: undefined,
    latestThinking: "checking the latest thinking excerpt for the activity block",
    latestThinkingFull: "checking the latest thinking excerpt for the activity block\n\nwith a second paragraph that should appear once expanded",
    thinkingSummaries: [
      "final thought one",
      "final thought two",
    ],
    lastThinkingAt: 100,
    lastToolSummary: "$ printf hello",
    lastToolUpdateAt: 100,
    currentActivity: {
      kind: "tool",
      summary: "$ printf hello from a surprisingly long command that should truncate safely",
      timestamp: 100,
      toolCallId: "tool-2",
      toolName: "bash",
      toolState: "running",
    },
    previousActivity: {
      kind: "thinking",
      summary: "**previous** thought",
      timestamp: 90,
    },
    isResponding: false,
    tools: [
      {
        id: "tool-2",
        name: "bash",
        summary: "$ printf hello from a surprisingly long command that should truncate safely",
        state: "running",
        startedAt: 0,
        updatedAt: 100,
      },
      {
        id: "tool-3",
        name: "edit",
        summary: "activity-block-widget.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 90,
        completedAt: 90,
      },
      {
        id: "tool-1",
        name: "read",
        summary: "README.md:1-40",
        state: "complete",
        startedAt: 0,
        updatedAt: 80,
        completedAt: 80,
      },
    ],
    totalTools: 3,
    activeTools: 1,
    completedTools: 2,
    failedTools: 0,
    latestActiveTool: {
      id: "tool-2",
      name: "bash",
      summary: "$ printf hello from a surprisingly long command that should truncate safely",
      state: "running",
      startedAt: 0,
      updatedAt: 100,
    },
    latestToolView: {
      toolCallId: "tool-2",
      name: "bash",
      summary: "$ printf hello from a surprisingly long command that should truncate safely",
      state: "running",
      isError: false,
      updatedAt: 100,
      outputPreview: "hello\nworld\nfrom tool output",
    },
    ...overrides,
  };
}

function createComponent(snapshotOverrides = {}, options = {}) {
  const toolHistoryViewMode = options.toolHistoryViewMode ?? (options.expanded ? "all" : "latest");
  return new ActivityBlockMessageComponent(
    options.theme ?? theme,
    () => createSnapshot(snapshotOverrides),
    () => options.now ?? 1500,
    () => toolHistoryViewMode,
    () => options.thinkingExpanded ?? false,
    () => options.compactionCount ?? 0,
  );
}

test("formatActivityBlock keeps a provided turn title", () => {
  const view = formatActivityBlock(createSnapshot({ activeTools: 2 }), 1500, "Activity #abc123");
  assert.equal(view.title, "Activity #abc123");
});

test("formatActivityBlock rounds sub-second timers down to 0s", () => {
  const view = formatActivityBlock(createSnapshot({ startedAt: 1000 }), 1250);
  assert.match(view.secondary, /3 tool calls/);
  assert.equal(view.secondaryRight, "0s");
  assert.doesNotMatch(view.secondary, /0\.\d+s/);
});


test("formatActivityBlock formats token counts in 1K buckets", () => {
  const low = formatActivityBlock(createSnapshot({ startedAt: 1000, latestTokenCount: 999 }), 1250);
  assert.match(low.secondary, /< 1K tokens/);

  const high = formatActivityBlock(createSnapshot({ startedAt: 0, latestTokenCount: 2500 }), 1500);
  assert.match(high.secondary, /2K tokens/);
  assert.doesNotMatch(high.secondary, /2\.5K/);
});

test("formatActivityBlock appends failed tool counts inline", () => {
  const view = formatActivityBlock(createSnapshot({ failedTools: 2 }), 1500);
  assert.match(view.secondary, /3 tool calls \(2 failed\)/);
});

test("formatActivityBlock prefers active tool information over reasoning", () => {
  const view = formatActivityBlock(createSnapshot({ activeTools: 2 }), 1500);
  assert.equal(view.status, "Cooking");
  assert.match(view.spinner ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
  assert.match(view.primary, /^bash \$ printf hello/);
  assert.match(view.tertiary ?? "", /showing the latest update/);
});

test("formatActivityBlock freezes elapsed time once the turn ends", () => {
  const view = formatActivityBlock(
    createSnapshot({ runState: "complete", endedAt: 2200, finalLabel: "Complete", activeTools: 0, latestActiveTool: undefined }),
    12000,
  );
  assert.equal(view.status, "Completed");
  assert.match(view.secondary, /3 tool calls/);
  assert.equal(view.secondaryRight, "2s");
  assert.doesNotMatch(view.secondary, /12/);
});

test("ActivityBlockMessageComponent hides the collapsed thinking header after completion", () => {
  const rendered = createComponent({
    runState: "complete",
    endedAt: 2200,
    finalLabel: "Completed",
    activeTools: 0,
    latestActiveTool: undefined,
  }).render(72).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("Completed!")));
  assert.ok(!rendered.some((line) => line.includes("checking the latest thinking excerpt for the activity block")));
});

test("formatActivityBlock stops the spinner once the final response is streaming", () => {
  const view = formatActivityBlock(
    createSnapshot({
      isResponding: true,
      activeTools: 0,
      latestActiveTool: undefined,
    }),
    1500,
  );
  assert.equal(view.status, "Responding");
  assert.equal(view.spinner, undefined);
  assert.match(view.primary, /Last thought checking the latest thinking excerpt/);
});

test("formatActivityBlock uses Cooking for both tool and thinking states", () => {
  const cookingView = formatActivityBlock(createSnapshot({ activeTools: 0, latestActiveTool: undefined, latestThinking: "", latestThinkingFull: "", lastToolSummary: "$ printf hello" }), 1500);
  assert.equal(cookingView.status, "Cooking");

  const thinkingView = formatActivityBlock(createSnapshot({ activeTools: 0, latestActiveTool: undefined }), 1500);
  assert.equal(thinkingView.status, "Cooking");
});

test("formatActivityBlock uses a waiting status before the first update", () => {
  const waitingView = formatActivityBlock(
    createSnapshot({
      latestThinking: "",
      latestThinkingFull: "",
      lastToolSummary: undefined,
      currentActivity: undefined,
      previousActivity: undefined,
      latestActiveTool: undefined,
      latestToolView: undefined,
      activeTools: 0,
      totalTools: 0,
      completedTools: 0,
      latestTokenCount: 999,
    }),
    1500,
  );
  assert.equal(waitingView.status, "Waiting for the first update");
  assert.equal(waitingView.primary, "");
  assert.match(waitingView.secondary, /0 tool calls · < 1K tokens/);
  assert.equal(waitingView.secondaryRight, "1s");
});


test("ActivityBlockMessageComponent keeps the running title static", () => {
  const overrides = {
    latestThinking: "Planning",
    latestThinkingFull: "Planning\n\nwith more detail below",
    currentActivity: {
      kind: "thinking",
      summary: "Planning",
      timestamp: 100,
    },
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  };

  for (const now of [0, 350, 1050]) {
    const rendered = createComponent(overrides, { now }).render(48).map((line) => stripAnsi(line));
    assert.ok(rendered[1]?.includes("Planning"));
    assert.ok(!rendered[1]?.includes("Planning."));
  }
});

test("ActivityBlockMessageComponent does not animate Responding", () => {
  const rendered = createComponent(
    { isResponding: true, activeTools: 0, latestActiveTool: undefined },
    { now: 1050 },
  ).render(48).map((line) => stripAnsi(line));
  assert.ok(rendered[1]?.includes("Responding"));
  assert.ok(!rendered[1]?.includes("Responding."));
});

test("ActivityBlockMessageComponent keeps responding footer quantitative only", () => {
  const rendered = createComponent(
    { isResponding: true, activeTools: 0, latestActiveTool: undefined },
    { now: 12_000, compactionCount: 3 },
  ).render(64).map((line) => stripAnsi(line)).join("\n");

  assert.doesNotMatch(rendered, /Final answer streaming/);
  assert.doesNotMatch(rendered, /compactions/);
  assert.match(rendered, /3 tool calls/);
});

test("ActivityBlockMessageComponent renders the status line fully bold without a spinner", () => {
  const line = stripAnsi(createComponent({}, { theme: markerBoldTheme }).render(64)[1] ?? "");
  assert.match(line, /│<b>[^<]*<\/b>│/);
  assert.match(line, /<b>checking the latest thinking excerpt[^<]*<\/b>/u);
  assert.doesNotMatch(line, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
});

test("ActivityBlockMessageComponent keeps the timer on the far right", () => {
  const rendered = createComponent({ latestTokenCount: 1600 }, { now: 12_000 }).render(56).map((line) => stripAnsi(line));
  const footer = rendered[rendered.length - 2] ?? "";
  assert.match(footer, /12s\s*│?$/);
  assert.ok(footer.includes("3 tool calls · 1K tokens"));
});

test("ActivityBlockMessageComponent stays width-safe on narrow terminals", () => {
  const rendered = createComponent().render(28).map((line) => stripAnsi(line));
  assert.ok(rendered.length <= 20);
  for (const line of rendered) {
    assert.ok(line.length <= 28, `expected line to fit width 28, got ${line.length}: ${line}`);
  }
});

test("ActivityBlockMessageComponent collapses to a single safe line on very narrow terminals", () => {
  const rendered = createComponent().render(10).map((line) => stripAnsi(line));
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].length <= 10);
});

test("ActivityBlockMessageComponent keeps the block shape without a visible turn header", () => {
  const rendered = createComponent({}, { expanded: true }).render(48).map((line) => stripAnsi(line));
  assert.ok(rendered.length <= 20);
  assert.ok(!rendered.some((line) => line.includes("Turn #123")));
  const activityIndex = rendered.findIndex((line) => line.includes("checking the latest thinking excerpt") || line.includes("Cooking") || line.includes("Responding") || line.includes("Waiting for the first update"));
  const blankRow = /^│\s*│$/;
  assert.ok(activityIndex >= 0);
  assert.match(rendered[activityIndex + 1] ?? "", blankRow);
  assert.ok(rendered.some((line) => line.includes("▶ $ printf hello")));
  assert.equal(rendered.filter((line) => line.includes("checking the latest thinking excerpt")).length, 1);
  assert.ok(!rendered.some((line) => line.includes("Expanded")));
  assert.ok(!rendered.some((line) => line.includes("Thought:")));
  for (const line of rendered) {
    assert.ok(line.length <= 48, `expected line to fit width 48, got ${line.length}: ${line}`);
  }
});

test("ActivityBlockMessageComponent keeps the footer line at the bottom in expanded mode", () => {
  const rendered = createComponent({}, { expanded: true, now: 12_000 }).render(64).map((line) => stripAnsi(line));
  const footer = rendered[rendered.length - 2] ?? "";

  assert.match(footer, /3 tool calls/);
  assert.match(footer, /12s\s*│?$/);
  assert.ok(rendered.slice(0, -2).some((line) => line.includes("▶ $ printf hello")));
});

 test("ActivityBlockMessageComponent adds a spacer row after the expanded tool list", () => {
  const rendered = createComponent({}, { expanded: true, now: 12_000 }).render(64).map((line) => stripAnsi(line));
  const blankRow = /^│\s*│$/;
  const footerIndex = rendered.findIndex((line) => line.includes("3 tool calls"));

  assert.ok(footerIndex >= 1);
  assert.match(rendered[footerIndex - 1] ?? "", blankRow);
});

test("ActivityBlockMessageComponent keeps expanded thinking bounded while preserving the newest sticky tool row", () => {
  const fullThinking = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const rendered = createComponent({
    latestThinking: "line 1",
    latestThinkingFull: fullThinking,
    currentActivity: {
      kind: "thinking",
      summary: "line 1",
      timestamp: 100,
    },
    latestActiveTool: undefined,
    activeTools: 0,
  }, { thinkingExpanded: true }).render(60).map((line) => stripAnsi(line));

  assert.equal(rendered.filter((line) => /line 1(\D|$)/.test(line)).length, 1);
  assert.ok(rendered.some((line) => line.includes("line 8")));
  assert.ok(!rendered.some((line) => line.includes("line 9")));
  assert.ok(rendered.some((line) => line.includes("✓ edit activity-block-widget.ts")));
  assert.ok(!rendered.some((line) => line.includes("Thought: final thought one")));
  assert.ok(!rendered.some((line) => line.includes("Thinking expanded")));
  assert.ok(rendered.length <= 20);
});

test("ActivityBlockMessageComponent adds spacer rows under status and after the sticky tool stack", () => {
  const rendered = createComponent().render(64).map((line) => stripAnsi(line));
  const blankRow = /^│\s*│$/;
  const statusIndex = rendered.findIndex((line) => line.includes("checking the latest thinking excerpt") || line.includes("Responding") || line.includes("Waiting for the first update"));
  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ edit") || line.includes("✓ read"));
  const lastToolLine = toolLines[toolLines.length - 1] ?? "";
  const lastToolIndex = rendered.lastIndexOf(lastToolLine);

  assert.ok(statusIndex >= 0);
  assert.ok(lastToolIndex >= 0);
  assert.match(rendered[statusIndex + 1] ?? "", blankRow);
  assert.match(rendered[lastToolIndex + 1] ?? "", blankRow);
});

test("ActivityBlockMessageComponent shows only the thinking text header in compact mode", () => {
  const rendered = createComponent({
    latestThinking: "Evaluating rendering logic I am checking body text",
    latestThinkingFull: "Evaluating rendering logic\n\nI am checking body text",
    currentActivity: undefined,
    previousActivity: undefined,
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  }).render(64).map((line) => stripAnsi(line));

  assert.equal(rendered.filter((line) => line.includes("Evaluating rendering logic")).length, 1);
  assert.ok(!rendered.some((line) => line.includes("I am checking body text")));
  assert.ok(!rendered.some((line) => line.includes("Last thought Evaluating rendering logic")));
});


test("ActivityBlockMessageComponent uses the thinking header in the status row instead of Cooking", () => {
  const rendered = createComponent({
    latestThinking: "Planning the next change",
    latestThinkingFull: "Planning the next change\n\nwith more detail below",
    currentActivity: {
      kind: "thinking",
      summary: "Planning the next change",
      timestamp: 100,
    },
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  }).render(64).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("Planning the next change")));
  assert.ok(!rendered.some((line) => line.includes("Cooking")));
});

test("ActivityBlockMessageComponent keeps the thinking header in the status row during tool activity", () => {
  const rendered = createComponent({
    latestThinking: "Planning the next change",
    latestThinkingFull: "Planning the next change\n\nwith more detail below",
    currentActivity: {
      kind: "tool",
      summary: "$ printf hello from a surprisingly long command that should truncate safely",
      timestamp: 100,
      toolCallId: "tool-2",
      toolName: "bash",
      toolState: "running",
    },
    latestActiveTool: {
      id: "tool-2",
      name: "bash",
      summary: "$ printf hello from a surprisingly long command that should truncate safely",
      state: "running",
      startedAt: 0,
      updatedAt: 100,
    },
    activeTools: 1,
  }).render(64).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("Planning the next change")));
  assert.ok(!rendered.some((line) => line.includes("Cooking")));
  assert.ok(rendered.some((line) => line.includes("✓ edit activity-block-widget.ts")));
  assert.ok(!rendered.some((line) => line.includes("▶ $ printf hello")));
});

test("ActivityBlockMessageComponent renders collapsed thinking text as markdown", () => {
  const rendered = createComponent({
    latestThinking: "Reviewing bold output",
    latestThinkingFull: "Reviewing **bold** output",
    currentActivity: {
      kind: "thinking",
      summary: "Reviewing bold output",
      timestamp: 100,
    },
    previousActivity: undefined,
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  }).render(64).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => line.includes("Reviewing bold output")));
  assert.ok(!rendered.some((line) => line.includes("**bold**")));
});

test("ActivityBlockMessageComponent keeps the last five tool actions sticky with newest first", () => {
  const rendered = createComponent({
    latestThinking: "Evaluating rendering logic body summary",
    latestThinkingFull: "Evaluating rendering logic\n\nbody summary",
    currentActivity: {
      kind: "thinking",
      summary: "Evaluating rendering logic body summary",
      timestamp: 120,
    },
    latestActiveTool: undefined,
    activeTools: 0,
    tools: [
      {
        id: "tool-6",
        name: "bash",
        summary: "$ printf six",
        state: "running",
        startedAt: 0,
        updatedAt: 140,
      },
      {
        id: "tool-5",
        name: "write",
        summary: "five.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 130,
        completedAt: 130,
      },
      {
        id: "tool-4",
        name: "read",
        summary: "four.md:1-20",
        state: "complete",
        startedAt: 0,
        updatedAt: 120,
        completedAt: 120,
      },
      {
        id: "tool-3",
        name: "edit",
        summary: "three.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 110,
        completedAt: 110,
      },
      {
        id: "tool-2",
        name: "bash",
        summary: "$ printf two",
        state: "complete",
        startedAt: 0,
        updatedAt: 100,
        completedAt: 100,
      },
      {
        id: "tool-1",
        name: "read",
        summary: "one.md:1-10",
        state: "complete",
        startedAt: 0,
        updatedAt: 90,
        completedAt: 90,
      },
    ],
    totalTools: 6,
    activeTools: 1,
    completedTools: 5,
    lastToolSummary: "$ printf six",
    latestToolView: {
      toolCallId: "tool-6",
      name: "bash",
      summary: "$ printf six",
      state: "running",
      isError: false,
      updatedAt: 140,
    },
  }, { toolHistoryViewMode: "recent" }).render(80).map((line) => stripAnsi(line));

  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ write") || line.includes("✓ read") || line.includes("✓ edit") || line.includes("✓ $"));
  assert.equal(toolLines.length, 5);
  assert.match(toolLines[0] ?? "", /▶ \$ printf six/);
  assert.match(toolLines[1] ?? "", /✓ write five\.ts/);
  assert.match(toolLines[2] ?? "", /✓ read four\.md:1-20/);
  assert.match(toolLines[3] ?? "", /✓ edit three\.ts/);
  assert.match(toolLines[4] ?? "", /✓ \$ printf two/);
  assert.ok(!rendered.some((line) => line.includes("one.md:1-10")));
});

test("ActivityBlockMessageComponent shows only the newest sticky tool row in latest mode", () => {
  const rendered = createComponent({
    tools: [
      {
        id: "tool-3",
        name: "edit",
        summary: "three.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 110,
        completedAt: 110,
      },
      {
        id: "tool-2",
        name: "bash",
        summary: "$ printf two",
        state: "running",
        startedAt: 0,
        updatedAt: 120,
      },
      {
        id: "tool-1",
        name: "read",
        summary: "one.md:1-10",
        state: "complete",
        startedAt: 0,
        updatedAt: 90,
        completedAt: 90,
      },
    ],
    totalTools: 3,
    activeTools: 1,
    completedTools: 2,
    lastToolSummary: "$ printf two",
    latestToolView: {
      toolCallId: "tool-2",
      name: "bash",
      summary: "$ printf two",
      state: "running",
      isError: false,
      updatedAt: 120,
    },
  }).render(72).map((line) => stripAnsi(line));

  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ edit") || line.includes("✓ read"));
  assert.equal(toolLines.length, 1);
  assert.match(toolLines[0] ?? "", /✓ edit three\.ts/);
});

test("ActivityBlockMessageComponent shows all tool rows in current sticky order for all mode", () => {
  const rendered = createComponent({
    tools: [
      {
        id: "tool-3",
        name: "edit",
        summary: "three.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 110,
        completedAt: 110,
      },
      {
        id: "tool-2",
        name: "bash",
        summary: "$ printf two",
        state: "running",
        startedAt: 0,
        updatedAt: 120,
      },
      {
        id: "tool-1",
        name: "read",
        summary: "one.md:1-10",
        state: "complete",
        startedAt: 0,
        updatedAt: 90,
        completedAt: 90,
      },
    ],
    totalTools: 3,
    activeTools: 1,
    completedTools: 2,
    lastToolSummary: "$ printf two",
    latestToolView: {
      toolCallId: "tool-2",
      name: "bash",
      summary: "$ printf two",
      state: "running",
      isError: false,
      updatedAt: 120,
    },
  }, { toolHistoryViewMode: "all" }).render(72).map((line) => stripAnsi(line));

  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ edit") || line.includes("✓ read"));
  assert.equal(toolLines.length, 3);
  assert.match(toolLines[0] ?? "", /✓ edit three\.ts/);
  assert.match(toolLines[1] ?? "", /▶ \$ printf two/);
  assert.match(toolLines[2] ?? "", /✓ read one\.md:1-10/);
});

test("ActivityBlockMessageComponent shows timers for running, successful, and failed tool rows once they reach ten seconds", () => {
  const rendered = createComponent({
    tools: [
      {
        id: "tool-running",
        name: "bash",
        summary: "$ sleep 10",
        state: "running",
        startedAt: 2_000,
        updatedAt: 11_000,
      },
      {
        id: "tool-ten",
        name: "read",
        summary: "README.md:1-20",
        state: "complete",
        startedAt: 0,
        updatedAt: 10_000,
        completedAt: 10_000,
      },
      {
        id: "tool-error-ten",
        name: "write",
        summary: "notes.md",
        state: "error",
        startedAt: 2_000,
        updatedAt: 12_000,
        completedAt: 12_000,
      },
      {
        id: "tool-fast",
        name: "edit",
        summary: "fast.ts",
        state: "complete",
        startedAt: 0,
        updatedAt: 9_999,
        completedAt: 9_999,
      },
    ],
    totalTools: 4,
    activeTools: 1,
    completedTools: 2,
    failedTools: 1,
    currentActivity: {
      kind: "tool",
      summary: "$ sleep 10",
      timestamp: 11_000,
      toolCallId: "tool-running",
      toolName: "bash",
      toolState: "running",
    },
    latestActiveTool: {
      id: "tool-running",
      name: "bash",
      summary: "$ sleep 10",
      state: "running",
      startedAt: 2_000,
      updatedAt: 11_000,
    },
    latestToolView: {
      toolCallId: "tool-running",
      name: "bash",
      summary: "$ sleep 10",
      state: "running",
      isError: false,
      updatedAt: 11_000,
    },
    lastToolSummary: "$ sleep 10",
  }, { now: 12_000, toolHistoryViewMode: "recent" }).render(80).map((line) => stripAnsi(line));
  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ read") || line.includes("! write") || line.includes("✓ edit"));

  assert.equal(toolLines.length, 4);
  assert.ok(toolLines.some((line) => /▶ \$ sleep 10.* · 10s/.test(line)));
  assert.ok(toolLines.some((line) => /! write notes\.md.* · 10s/.test(line)));
  assert.ok(toolLines.some((line) => /✓ read README\.md:1-20.* · 10s/.test(line)));
  assert.ok(toolLines.some((line) => /✓ edit fast\.ts/.test(line)));
  assert.ok(!toolLines.some((line) => /✓ edit fast\.ts.* · 9s/.test(line)));
});

test("ActivityBlockMessageComponent uses tool-state background highlighting for the rendered sticky tool row", () => {
  const backgroundTheme = {
    ...theme,
    bg: (name, text) => `<${name}>${text}</${name}>`,
  };
  const rendered = createComponent({}, { theme: backgroundTheme }).render(64).join("\n");
  assert.match(rendered, /<toolSuccessBg>[^\n]*✓ edit activity-block-widget\.ts/);
  assert.doesNotMatch(rendered, /<toolPendingBg>[^\n]*▶ \$ printf hello/);
});

test("ActivityBlockMessageComponent keeps expanded tool history color coded", () => {
  const backgroundTheme = {
    ...theme,
    bg: (name, text) => `<${name}>${text}</${name}>`,
  };
  const rendered = createComponent({}, { theme: backgroundTheme, expanded: true }).render(64).join("\n");
  assert.match(rendered, /<toolPendingBg>[^\n]*▶ \$ printf hello/);
  assert.match(rendered, /<toolSuccessBg>[^\n]*✓ edit activity-block-widget\.ts/);
  assert.match(rendered, /<toolSuccessBg>[^\n]*✓ read README\.md:1-40/);
});

test("ActivityBlockMessageComponent freezes expanded tool timers at completion time", () => {
  const rendered = createComponent({
    tools: [
      {
        id: "tool-running",
        name: "bash",
        summary: "$ sleep 12",
        state: "running",
        startedAt: 8_000,
        updatedAt: 15_000,
      },
      {
        id: "tool-complete",
        name: "read",
        summary: "README.md:1-20",
        state: "complete",
        startedAt: 1_000,
        updatedAt: 12_000,
        completedAt: 12_000,
      },
      {
        id: "tool-fast",
        name: "edit",
        summary: "quick.ts",
        state: "complete",
        startedAt: 4_000,
        updatedAt: 8_000,
        completedAt: 8_000,
      },
    ],
    totalTools: 3,
    activeTools: 1,
    completedTools: 2,
    latestActiveTool: {
      id: "tool-running",
      name: "bash",
      summary: "$ sleep 12",
      state: "running",
      startedAt: 8_000,
      updatedAt: 15_000,
    },
    latestToolView: {
      toolCallId: "tool-running",
      name: "bash",
      summary: "$ sleep 12",
      state: "running",
      isError: false,
      updatedAt: 15_000,
    },
    lastToolSummary: "$ sleep 12",
  }, { expanded: true, now: 20_000 }).render(80).map((line) => stripAnsi(line));

  assert.ok(rendered.some((line) => /▶ \$ sleep 12.* · 12s/.test(line)));
  assert.ok(rendered.some((line) => /✓ read README\.md:1-20.* · 11s/.test(line)));
  assert.ok(rendered.some((line) => /✓ edit quick\.ts/.test(line)));
  assert.ok(!rendered.some((line) => /✓ edit quick\.ts.* · 4s/.test(line)));
  assert.ok(!rendered.some((line) => /✓ read README\.md:1-20.* · 19s/.test(line)));
});

test("ActivityBlockMessageComponent hides the separate primary text area when full history is visible", () => {
  const rendered = createComponent({}, { expanded: true }).render(80).map((line) => stripAnsi(line));
  const prefixedToolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ edit") || line.includes("✓ read"));
  assert.equal(prefixedToolLines.length, 3);
  assert.ok(!rendered.some((line) => line.includes("bash $ printf hello from a surprisingly long command")));
  assert.ok(rendered.some((line) => line.includes("checking the latest thinking excerpt for the activity block")));
  assert.ok(!rendered.some((line) => line.includes("Cooking")));
});

test("ActivityBlockMessageComponent never shows compaction count in the footer", () => {
  const single = createComponent({}, { compactionCount: 1 }).render(64).map((line) => stripAnsi(line)).join("\n");
  assert.doesNotMatch(single, /compactions/);

  const multiple = createComponent({}, { compactionCount: 3 }).render(64).map((line) => stripAnsi(line)).join("\n");
  assert.doesNotMatch(multiple, /compactions/);
});

test("ActivityBlockMessageComponent keeps the full-history panel tool-only when no tools ran", () => {
  const rendered = createComponent({
    tools: [],
    totalTools: 0,
    activeTools: 0,
    completedTools: 0,
    failedTools: 0,
    latestActiveTool: undefined,
    latestToolView: undefined,
  }, { expanded: true }).render(64).map((line) => stripAnsi(line));

  assert.ok(!rendered.some((line) => line.includes("No recent tool details")));
  assert.ok(!rendered.some((line) => line.includes("Thought:")));
  assert.equal(rendered.filter((line) => line.includes("checking the latest thinking excerpt for the activity block")).length, 1);
  assert.ok(rendered.some((line) => line.includes("0 tool calls")));
  const blankRows = rendered.filter((line) => /^│\s*│$/.test(line));
  assert.equal(blankRows.length, 1);
});

test("ActivityBlockMessageComponent keeps only the thinking header visible in full-history mode when no tools ran", () => {
  const rendered = createComponent({
    latestThinking: "**Considering sticky list implementation** I'm thinking about the \"sticky\" list",
    latestThinkingFull: "**Considering sticky list implementation**\n\nI'm thinking about the \"sticky\" list",
    currentActivity: {
      kind: "thinking",
      summary: "Considering sticky list implementation",
      timestamp: 100,
    },
    previousActivity: undefined,
    tools: [],
    totalTools: 0,
    activeTools: 0,
    completedTools: 0,
    failedTools: 0,
    latestActiveTool: undefined,
    latestToolView: undefined,
    lastToolSummary: undefined,
  }, { expanded: true }).render(72).map((line) => stripAnsi(line));

  assert.equal(rendered.filter((line) => line.includes("Considering sticky list implementation")).length, 1);
  assert.ok(!rendered.some((line) => line.includes("I'm thinking about the \"sticky\" list")));
  assert.ok(!rendered.some((line) => line.includes("No recent tool details")));
});

test("ActivityBlockMessageComponent renders a pending placeholder block instead of Activity unavailable", () => {
  const component = new ActivityBlockMessageComponent(
    theme,
    () => undefined,
    () => 1500,
    () => true,
    () => false,
    () => 0,
  );
  const rendered = component.render(64).map((line) => stripAnsi(line));
  assert.ok(rendered.some((line) => line.includes("Waiting for the first update")));
  assert.ok(rendered.some((line) => line.includes("0 tool calls")));
  assert.ok(!rendered.some((line) => line.includes("No recent tool details")));
  assert.ok(!rendered.some((line) => line.includes("Activity unavailable")));
});

test("ActivityBlockMessageComponent keeps the border pink after nested ansi resets", () => {
  const component = new ActivityBlockMessageComponent(
    resetBoldTheme,
    () => createSnapshot(),
    () => 1500,
    () => false,
    () => false,
    () => 0,
  );
  const rendered = component.render(22);
  assert.ok(rendered.some((line) => /\x1b\[1mchecking the latest .*\x1b\[0m\x1b\[38;2;245;194;231m│\x1b\[39m$/.test(line)));
});
