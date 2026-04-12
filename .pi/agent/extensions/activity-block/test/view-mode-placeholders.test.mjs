import test from "node:test";
import assert from "node:assert/strict";
import { getNextToolHistoryViewMode } from "../index.ts";
import { getToolHistoryPlaceholderCount, isExpandedThinkingShown, shouldShowThinkingPanel } from "../lib/activity-block-widget.ts";

test("tool history cycling always visits recent and all when no thinking text is shown", () => {
	assert.equal(getNextToolHistoryViewMode("latest", 0), "recent");
	assert.equal(getNextToolHistoryViewMode("recent", 1), "all");
	assert.equal(getNextToolHistoryViewMode("all", 2), "latest");
});


test("tool history cycling skips full history while expanded thinking is shown", () => {
	assert.equal(getNextToolHistoryViewMode("latest", 0, { expandedThinkingShown: true }), "recent");
	assert.equal(getNextToolHistoryViewMode("recent", 1, { expandedThinkingShown: true }), "latest");
	assert.equal(getNextToolHistoryViewMode("all", 2, { expandedThinkingShown: true }), "latest");
});

test("placeholder rows fill undersized tool history views only when at least one history row exists", () => {
	assert.equal(getToolHistoryPlaceholderCount("latest", 1, 1), 0);
	assert.equal(getToolHistoryPlaceholderCount("recent", 2, 5), 3);
	assert.equal(getToolHistoryPlaceholderCount("all", 2, 7), 5);
	assert.equal(getToolHistoryPlaceholderCount("latest", 0, 1), 0);
	assert.equal(getToolHistoryPlaceholderCount("recent", 0, 5), 0);
});

test("full tool view hides the thinking panel unless thinking is explicitly expanded", () => {
	assert.equal(shouldShowThinkingPanel("latest", false), true);
	assert.equal(shouldShowThinkingPanel("recent", false), true);
	assert.equal(shouldShowThinkingPanel("all", false), false);
	assert.equal(shouldShowThinkingPanel("all", true), true);
});


test("expanded thinking detection only treats the explicit expanded view as visible thinking text", () => {
	assert.equal(isExpandedThinkingShown({ latestThinking: "", runState: "running", isResponding: false }, false), false);
	assert.equal(isExpandedThinkingShown({ latestThinking: "draft", runState: "running", isResponding: false }, false), false);
	assert.equal(isExpandedThinkingShown({ latestThinking: "draft", runState: "running", isResponding: true }, false), false);
	assert.equal(isExpandedThinkingShown({ latestThinking: "draft", runState: "complete", isResponding: false }, false), false);
	assert.equal(isExpandedThinkingShown({ latestThinking: "draft", runState: "complete", isResponding: false }, true), true);
});
