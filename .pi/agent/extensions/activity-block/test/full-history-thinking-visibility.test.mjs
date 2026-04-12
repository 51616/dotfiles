import test from "node:test";
import assert from "node:assert/strict";
import { ActivityBlockMessageComponent } from "../lib/activity-block-widget.ts";

const theme = {
	bold: (text) => text,
	fg: (_name, text) => text,
	bg: (_name, text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
};

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createSnapshot(overrides = {}) {
	return {
		runState: "running",
		startedAt: 0,
		endedAt: undefined,
		finalLabel: undefined,
		latestThinking: "Planning the next step",
		latestThinkingFull: "Planning the next step\n\nline 2 of the reasoning",
		thinkingSummaries: [],
		lastThinkingAt: 100,
		lastToolSummary: undefined,
		lastToolUpdateAt: undefined,
		respondingStartedAt: undefined,
		turnTokenBaseline: undefined,
		latestTokenCount: 1400,
		currentActivity: {
			kind: "thinking",
			summary: "Planning the next step",
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

test("full tool-history view keeps the header but hides the separate thinking text area when no tool rows exist", () => {
	const component = new ActivityBlockMessageComponent(
		theme,
		() => createSnapshot(),
		() => 1_500,
		() => "all",
		() => false,
		() => 0,
	);
	const rendered = component.render(80).map(stripAnsi).join("\n");

	assert.match(rendered, /Planning the next step/);
	assert.doesNotMatch(rendered, /Cooking/);
	assert.match(rendered, /0 tool calls/);
	assert.doesNotMatch(rendered, /line 2 of the reasoning/);
});
