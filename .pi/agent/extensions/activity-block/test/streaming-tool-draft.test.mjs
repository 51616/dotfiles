import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import {
	applyMessageUpdate,
	createInitialActivityBlockState,
	getActivityBlockSnapshot,
	startRun,
} from "../lib/activity-block-state.ts";
import { ActivityBlockMessageComponent } from "../lib/activity-block-widget.ts";

initTheme();

const colorTheme = {
	bold: (text) => `<b>${text}</b>`,
	fg: (name, text) => `<${name}>${text}</${name}>`,
	bg: (_name, text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
};

function snapshotFromStreamingToolCall(toolName, args) {
	const state = createInitialActivityBlockState();
	startRun(state, 0);
	applyMessageUpdate(
		state,
		{
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: toolName,
						arguments: args,
					},
				],
			},
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "",
				partial: { role: "assistant", content: [] },
			},
		},
		100,
	);
	return getActivityBlockSnapshot(state);
}

function render(snapshot) {
	const component = new ActivityBlockMessageComponent(
		colorTheme,
		() => snapshot,
		() => 1_000,
		() => "latest",
		() => false,
		() => 0,
	);
	return component.render(180).join("\n");
}

test("streaming write tool calls appear before execution starts", () => {
	const snapshot = snapshotFromStreamingToolCall("write", {
		path: "src/generated/example.ts",
		content: "export const value = 1;",
	});

	assert.equal(snapshot.totalTools, 1);
	assert.equal(snapshot.activeTools, 1);
	assert.equal(snapshot.latestActiveTool?.name, "write");
	assert.equal(snapshot.latestActiveTool?.summary, "src/generated/example.ts");
	assert.match(
		render(snapshot),
		/<warning>▶<\/warning> <success><b>Writing to<\/b><\/success> <accent>src\/generated\/example\.ts<\/accent>/,
	);
});

test("streaming edit tool calls show edit intent while the payload is still partial", () => {
	const snapshot = snapshotFromStreamingToolCall("edit", {
		path: "src/generated/example.ts",
		edits: [{ oldText: "export const value = 1;", newText: "export const value = 2;" }],
	});

	assert.equal(snapshot.totalTools, 1);
	assert.equal(snapshot.activeTools, 1);
	assert.equal(snapshot.latestActiveTool?.name, "edit");
	assert.equal(snapshot.latestActiveTool?.summary, "src/generated/example.ts");
	assert.match(
		render(snapshot),
		/<warning>▶<\/warning> <warning><b>Editing<\/b><\/warning> <accent>src\/generated\/example\.ts<\/accent>/,
	);
});
