import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { ActivityBlockMessageComponent } from "../activity-block/lib/activity-block-widget.ts";

initTheme();

const theme = {
  bold: (text) => text,
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
    latestThinking: "Planning the next step",
    latestThinkingFull: "Planning the next step\n\nline 2 of the reasoning\nline 3 of the reasoning",
    thinkingSummaries: [],
    lastThinkingAt: 100,
    lastToolSummary: "$ printf six",
    lastToolUpdateAt: 120,
    respondingStartedAt: undefined,
    turnTokenBaseline: undefined,
    latestTokenCount: 1400,
    currentActivity: {
      kind: "tool",
      summary: "$ printf six",
      timestamp: 120,
      toolCallId: "tool-6",
      toolName: "bash",
      toolState: "running",
    },
    previousActivity: {
      kind: "thinking",
      summary: "Planning the next step",
      timestamp: 100,
    },
    isResponding: false,
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
    failedTools: 0,
    latestActiveTool: {
      id: "tool-6",
      name: "bash",
      summary: "$ printf six",
      state: "running",
      startedAt: 0,
      updatedAt: 140,
    },
    latestToolView: {
      toolCallId: "tool-6",
      name: "bash",
      summary: "$ printf six",
      state: "running",
      isError: false,
      updatedAt: 140,
    },
    ...overrides,
  };
}

function createComponent(snapshotOverrides = {}, options = {}) {
  return new ActivityBlockMessageComponent(
    theme,
    () => createSnapshot(snapshotOverrides),
    () => options.now ?? 1_500,
    () => options.toolHistoryViewMode ?? "recent",
    () => options.thinkingExpanded ?? false,
    () => 0,
  );
}

function render(component, width) {
  return component.render(width).map((line) => stripAnsi(line));
}

function isToolHistoryLine(line) {
  return line.includes("▶ $")
    || line.includes("✓ Wrote")
    || line.includes("✓ Edited")
    || line.includes("✓ read")
    || line.includes("✓ $");
}

test("activity-block full-history view keeps the header but hides the separate thinking text area", () => {
  const rendered = render(createComponent({}, { toolHistoryViewMode: "all" }), 80);
  const toolLines = rendered.filter(isToolHistoryLine);

  assert.equal(toolLines.length, 6);
  assert.ok(rendered.some((line) => line.includes("one.md:1-10")));
  assert.equal(rendered.filter((line) => line.includes("Planning the next step")).length, 1);
  assert.ok(!rendered.some((line) => line.includes("line 2 of the reasoning")));
  assert.ok(!rendered.some((line) => line.includes("Cooking")));
  assert.ok(!rendered.some((line) => line.includes("bash $ printf six")));
});

test("activity-block full-history view shows thinking again after explicit expansion", () => {
  const rendered = render(createComponent({}, { toolHistoryViewMode: "all", thinkingExpanded: true }), 80);
  const toolLines = rendered.filter(isToolHistoryLine);

  assert.ok(rendered.some((line) => line.includes("Planning the next step")));
  assert.ok(rendered.some((line) => line.includes("line 2 of the reasoning")));
  assert.equal(toolLines.length, 5);
  assert.ok(!rendered.some((line) => line.includes("one.md:1-10")));
});


test("activity-block does not pad the bottom tool stack while expanded thinking is shown", () => {
  const rendered = render(createComponent({
    tools: [
      {
        id: "tool-2",
        name: "bash",
        summary: "$ printf two",
        state: "running",
        startedAt: 0,
        updatedAt: 140,
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
    totalTools: 2,
    activeTools: 1,
    completedTools: 1,
    latestActiveTool: {
      id: "tool-2",
      name: "bash",
      summary: "$ printf two",
      state: "running",
      startedAt: 0,
      updatedAt: 140,
    },
    latestToolView: {
      toolCallId: "tool-2",
      name: "bash",
      summary: "$ printf two",
      state: "running",
      isError: false,
      updatedAt: 140,
    },
    lastToolSummary: "$ printf two",
  }, { toolHistoryViewMode: "recent", thinkingExpanded: true }), 80);

  const blankRows = rendered.filter((line) => /^│\s*│$/.test(line));
  const toolLines = rendered.filter((line) => line.includes("▶ $") || line.includes("✓ read"));

  assert.equal(toolLines.length, 2);
  assert.equal(blankRows.length, 2);
});


test("activity-block expanded thinking bottom-anchors the visible tool stack", () => {
  const rendered = render(createComponent({
    latestThinking: "Planning the next step",
    latestThinkingFull: "Planning the next step\n\nline 2 of the reasoning",
    tools: [{
      id: "tool-1",
      name: "bash",
      summary: "$ printf one",
      state: "running",
      startedAt: 0,
      updatedAt: 140,
    }],
    totalTools: 1,
    activeTools: 1,
    completedTools: 0,
    lastToolSummary: "$ printf one",
    latestActiveTool: {
      id: "tool-1",
      name: "bash",
      summary: "$ printf one",
      state: "running",
      startedAt: 0,
      updatedAt: 140,
    },
    latestToolView: {
      toolCallId: "tool-1",
      name: "bash",
      summary: "$ printf one",
      state: "running",
      isError: false,
      updatedAt: 140,
    },
    currentActivity: {
      kind: "tool",
      summary: "$ printf one",
      timestamp: 140,
      toolCallId: "tool-1",
      toolName: "bash",
      toolState: "running",
    },
  }, { toolHistoryViewMode: "latest", thinkingExpanded: true }), 80);
  const toolIndex = rendered.findIndex((line) => line.includes("▶ $ printf one"));

  assert.ok(toolIndex >= 2);
  assert.match(rendered[toolIndex - 1] ?? "", /^│\s*│$/);
  assert.ok((rendered[toolIndex - 2] ?? "").includes("line 2 of the reasoning"));
});

test("activity-block thinking body stays toggleable and width-safe across view sizes", () => {
  const collapsed = createComponent();
  const expanded = createComponent({}, { thinkingExpanded: true });

  for (const width of [28, 48, 80]) {
    const collapsedLines = render(collapsed, width);
    const expandedLines = render(expanded, width);

    assert.ok(!collapsedLines.some((line) => line.includes("line 2 of the reasoning")));
    assert.ok(expandedLines.some((line) => line.includes("line 2 of the reasoning")));
    assert.ok(expandedLines.length <= 20);
    for (const line of expandedLines) {
      assert.ok(line.length <= width, `expected line to fit width ${width}, got ${line.length}: ${line}`);
    }
  }
});

test("activity-block truncates displayed thinking text to 500 chars", () => {
  const header = "a".repeat(499);
  const longThinking = `${header}\n\n${"b".repeat(20)}`;
  const collapsedLines = render(createComponent({
    latestThinking: header,
    latestThinkingFull: longThinking,
    currentActivity: {
      kind: "thinking",
      summary: header,
      timestamp: 100,
    },
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  }), 600);
  const expandedLines = render(createComponent({
    latestThinking: header,
    latestThinkingFull: longThinking,
    currentActivity: {
      kind: "thinking",
      summary: header,
      timestamp: 100,
    },
    latestActiveTool: undefined,
    activeTools: 0,
    lastToolSummary: undefined,
  }, { thinkingExpanded: true }), 600);

  const collapsedText = collapsedLines.join("\n");
  const expandedText = expandedLines.join("\n");

  assert.ok(!collapsedText.includes("bbbbb"));
  assert.ok(!expandedText.includes("bbbbb"));
  assert.ok(expandedText.includes("…"));
});

test("activity-block block timer and tool timers tick on the same second boundary", () => {
  const beforeBoundary = render(createComponent({
    startedAt: 0,
    tools: [{
      id: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      startedAt: 1_000,
      updatedAt: 11_999,
    }],
    totalTools: 1,
    activeTools: 1,
    completedTools: 0,
    lastToolSummary: "$ sleep 11",
    latestActiveTool: {
      id: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      startedAt: 1_000,
      updatedAt: 11_999,
    },
    latestToolView: {
      toolCallId: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      isError: false,
      updatedAt: 11_999,
    },
    currentActivity: {
      kind: "tool",
      summary: "$ sleep 11",
      timestamp: 11_999,
      toolCallId: "tool-1",
      toolName: "bash",
      toolState: "running",
    },
  }, { now: 11_999, toolHistoryViewMode: "latest" }), 80).join("\n");

  const afterBoundary = render(createComponent({
    startedAt: 0,
    tools: [{
      id: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      startedAt: 1_000,
      updatedAt: 12_000,
    }],
    totalTools: 1,
    activeTools: 1,
    completedTools: 0,
    lastToolSummary: "$ sleep 11",
    latestActiveTool: {
      id: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      startedAt: 1_000,
      updatedAt: 12_000,
    },
    latestToolView: {
      toolCallId: "tool-1",
      name: "bash",
      summary: "$ sleep 11",
      state: "running",
      isError: false,
      updatedAt: 12_000,
    },
    currentActivity: {
      kind: "tool",
      summary: "$ sleep 11",
      timestamp: 12_000,
      toolCallId: "tool-1",
      toolName: "bash",
      toolState: "running",
    },
  }, { now: 12_000, toolHistoryViewMode: "latest" }), 80).join("\n");

  assert.match(beforeBoundary, /11s/);
  assert.match(beforeBoundary, /▶ \$ sleep 11.* · 10s/);
  assert.match(afterBoundary, /12s/);
  assert.match(afterBoundary, /▶ \$ sleep 11.* · 11s/);
});
