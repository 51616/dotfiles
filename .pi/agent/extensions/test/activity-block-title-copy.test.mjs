import test from "node:test";
import assert from "node:assert/strict";
import stripAnsi from "strip-ansi";
import { ActivityBlockMessageComponent } from "../activity-block/lib/activity-block-widget.ts";

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
    latestThinking: "checking the latest thinking excerpt for the activity block",
    latestThinkingFull: "checking the latest thinking excerpt for the activity block\n\nwith extra detail",
    thinkingSummaries: [],
    lastThinkingAt: 100,
    lastToolSummary: undefined,
    lastToolUpdateAt: undefined,
    respondingStartedAt: undefined,
    turnTokenBaseline: undefined,
    latestTokenCount: 999,
    currentActivity: {
      kind: "thinking",
      summary: "checking the latest thinking excerpt for the activity block",
      timestamp: 100,
    },
    previousActivity: undefined,
    isResponding: false,
    tools: [],
    totalTools: 0,
    activeTools: 0,
    completedTools: 0,
    failedTools: 0,
    latestActiveTool: undefined,
    latestToolView: undefined,
    ...overrides,
  };
}

function render(snapshotOverrides = {}, options = {}) {
  const component = new ActivityBlockMessageComponent(
    theme,
    () => createSnapshot(snapshotOverrides),
    () => options.now ?? 1_500,
    () => options.toolHistoryViewMode ?? "latest",
    () => options.thinkingExpanded ?? false,
    () => 0,
  );
  return component.render(options.width ?? 72).map((line) => stripAnsi(line));
}

test("activity-block keeps the visible running title static", () => {
  const rendered = render({}, { now: 1_050 });
  assert.ok(rendered.some((line) => line.includes("checking the latest thinking excerpt for the activity block")));
  assert.ok(!rendered.some((line) => line.includes("checking the latest thinking excerpt for the activity block...")));
});

test("activity-block renders Completed with an exclamation mark", () => {
  const rendered = render({
    runState: "complete",
    endedAt: 2_200,
    finalLabel: "Complete",
    latestThinking: "",
    latestThinkingFull: "",
    currentActivity: undefined,
    lastThinkingAt: undefined,
  });
  assert.ok(rendered.some((line) => line.includes("Completed!")));
});

test("activity-block does not show Done when a no-tool turn completes", () => {
  const rendered = render({
    runState: "complete",
    endedAt: 2_200,
    finalLabel: "Completed",
    latestThinking: "",
    latestThinkingFull: "",
    currentActivity: undefined,
    lastThinkingAt: undefined,
  });
  assert.ok(!rendered.some((line) => line.includes("Done")));
  assert.ok(rendered.some((line) => line.includes("0 tool calls")));
});
