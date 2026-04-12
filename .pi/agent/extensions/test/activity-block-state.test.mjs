// @lat: [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMessageUpdate,
  applyToolEnd,
  applyToolStart,
  createInitialActivityBlockState,
  extractFinalThinkingSummaries,
  finishRun,
  getActivityBlockSnapshot,
  normalizeExcerpt,
  setTurnTokenBaseline,
  startTurn,
  summarizeTool,
  syncLatestTokenCount,
} from "../activity-block/lib/activity-block-state.ts";

function assistantMessage(content, stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content,
    stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    api: "anthropic-messages",
    provider: "faux",
    model: "faux-model",
    timestamp: Date.now(),
    ...extra,
  };
}

test("normalizeExcerpt collapses whitespace and truncates safely", () => {
  assert.equal(normalizeExcerpt("line one\n\nline two"), "line one line two");
  assert.match(normalizeExcerpt("x".repeat(200), 24), /^x{23}…$/);
});

test("summarizeTool formats common tool arguments", () => {
  assert.equal(summarizeTool("read", { path: "README.md", offset: 3, limit: 2 }), "README.md:3-4");
  assert.equal(summarizeTool("bash", { command: "printf hello" }), "$ printf hello");
  assert.equal(summarizeTool("edit", { file_path: "notes/todo.md" }), "notes/todo.md");
});

test("startTurn keeps the block token count across internal continuation turns", () => {
  const state = createInitialActivityBlockState();
  state.latestTokenCount = 2200;
  startTurn(state);
  assert.equal(state.latestTokenCount, 2200);
});


test("context token sync subtracts the per-block baseline", () => {
  const state = createInitialActivityBlockState();
  setTurnTokenBaseline(state, 1200);

  syncLatestTokenCount(state, 1700, "context");
  assert.equal(state.latestTokenCount, 500);

  syncLatestTokenCount(state, 2300, "context");
  assert.equal(state.latestTokenCount, 1100);
});

test("usage token sync also stays block-scoped once a baseline exists", () => {
  const state = createInitialActivityBlockState();
  setTurnTokenBaseline(state, 1200);

  syncLatestTokenCount(state, 1500, "usage");
  assert.equal(state.latestTokenCount, 300);

  syncLatestTokenCount(state, 138000, "usage");
  assert.equal(state.latestTokenCount, 136800);
});

test("text streaming marks the block as responding until the turn ends", () => {
  const state = createInitialActivityBlockState();

  applyMessageUpdate(
    state,
    {
      type: "message_update",
      message: assistantMessage([{ type: "text", text: "hello" }], "stop", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      assistantMessageEvent: { type: "text_delta", delta: "he", contentIndex: 0, partial: {} },
    },
    100,
  );

  let snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.isResponding, true);
  assert.equal(snapshot.latestTokenCount, 1800);

  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } },
    150,
  );

  snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.isResponding, false);

  finishRun(
    state,
    { type: "agent_end", messages: [assistantMessage([{ type: "text", text: "done" }], "stop")] },
    200,
  );

  snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.isResponding, false);
});

test("reasoning-only updates keep the latest excerpt and final thinking summaries", () => {
  const state = createInitialActivityBlockState();

  applyMessageUpdate(
    state,
    {
      type: "message_update",
      message: assistantMessage([{ type: "thinking", thinking: "draft one" }]),
      assistantMessageEvent: { type: "thinking_delta", delta: "draft", contentIndex: 0, partial: {} },
    },
    100,
  );

  applyMessageUpdate(
    state,
    {
      type: "message_update",
      message: assistantMessage([{ type: "thinking", thinking: "draft two gets refined" }]),
      assistantMessageEvent: { type: "thinking_delta", delta: "refined", contentIndex: 0, partial: {} },
    },
    200,
  );

  finishRun(
    state,
    {
      type: "agent_end",
      messages: [
        assistantMessage([
          { type: "thinking", thinking: "final chain of thought summary" },
          { type: "text", text: "done" },
        ], "stop"),
      ],
    },
    350,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.runState, "complete");
  assert.equal(snapshot.latestThinking, "final chain of thought summary");
  assert.deepEqual(snapshot.thinkingSummaries, ["final chain of thought summary"]);
  assert.equal(snapshot.finalLabel, "Completed");
});

test("activity history keeps the current and previous activity summaries", () => {
  const state = createInitialActivityBlockState();

  applyMessageUpdate(
    state,
    {
      type: "message_update",
      message: assistantMessage([{ type: "thinking", thinking: "first draft" }]),
      assistantMessageEvent: { type: "thinking_delta", delta: "draft", contentIndex: 0, partial: {} },
    },
    100,
  );
  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } },
    150,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.currentActivity?.kind, "tool");
  assert.match(snapshot.currentActivity?.summary ?? "", /README\.md/);
  assert.equal(snapshot.previousActivity?.kind, "thinking");
  assert.equal(snapshot.previousActivity?.summary, "first draft");
});

test("extractFinalThinkingSummaries keeps only final-form thinking blocks", () => {
  const summaries = extractFinalThinkingSummaries({
    type: "agent_end",
    messages: [
      assistantMessage([{ type: "thinking", thinking: "draft should not matter" }], "stop"),
      assistantMessage([
        { type: "thinking", thinking: "final thought one" },
        { type: "thinking", thinking: "final thought two" },
        { type: "text", text: "answer" },
      ], "stop"),
    ],
  });
  assert.deepEqual(summaries, ["final thought one", "final thought two"]);
});

test("tool-end-only events still start a running block", () => {
  const state = createInitialActivityBlockState();

  applyToolEnd(
    state,
    { type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: [] }, isError: false },
    100,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.runState, "running");
  assert.equal(snapshot.totalTools, 1);
  assert.equal(snapshot.completedTools, 1);
  assert.equal(snapshot.activeTools, 0);
});

test("single-tool and parallel turns keep accurate counts and latest active tool", () => {
  const state = createInitialActivityBlockState();

  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "a.md" } },
    100,
  );
  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-2", toolName: "bash", args: { command: "echo hi" } },
    150,
  );
  applyToolEnd(
    state,
    { type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: { content: [] }, isError: false },
    200,
  );

  const mid = getActivityBlockSnapshot(state);
  assert.equal(mid.totalTools, 2);
  assert.equal(mid.activeTools, 1);
  assert.equal(mid.completedTools, 1);
  assert.equal(mid.latestActiveTool?.id, "tool-2");
  assert.match(mid.latestActiveTool?.summary ?? "", /^\$ echo hi/);

  applyToolEnd(
    state,
    { type: "tool_execution_end", toolCallId: "tool-2", toolName: "bash", result: { content: [] }, isError: true },
    300,
  );

  const final = getActivityBlockSnapshot(state);
  assert.equal(final.activeTools, 0);
  assert.equal(final.completedTools, 1);
  assert.equal(final.failedTools, 1);
});

test("turn_end can finalize a single turn from the assistant message", () => {
  const state = createInitialActivityBlockState();
  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } },
    100,
  );

  finishRun(
    state,
    {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage([
        { type: "thinking", thinking: "final thought for this turn" },
        { type: "text", text: "done" },
      ], "stop"),
      toolResults: [],
    },
    180,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.runState, "complete");
  assert.equal(snapshot.finalLabel, "Completed");
  assert.deepEqual(snapshot.thinkingSummaries, ["final thought for this turn"]);
});

test("aborted runs derive the terminal state from the last assistant message", () => {
  const state = createInitialActivityBlockState();
  applyToolStart(
    state,
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "README.md" } },
    100,
  );

  finishRun(
    state,
    {
      type: "agent_end",
      messages: [
        assistantMessage([{ type: "thinking", thinking: "working" }], "aborted", { errorMessage: "Request was aborted" }),
      ],
    },
    180,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.runState, "aborted");
  assert.equal(snapshot.finalLabel, "Aborted");
});

test("finishRun does not replace block-scoped token counts with whole-session totals", () => {
  const state = createInitialActivityBlockState();
  setTurnTokenBaseline(state, 137800);
  syncLatestTokenCount(state, 138100, "context");

  finishRun(
    state,
    {
      type: "agent_end",
      messages: [
        assistantMessage([{ type: "text", text: "Yep." }], "stop", {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 138000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }),
      ],
    },
    180,
  );

  const snapshot = getActivityBlockSnapshot(state);
  assert.equal(snapshot.latestTokenCount, 300);
});
