import test from "node:test";
import assert from "node:assert/strict";
import { sortToolsNewestFirst } from "../lib/activity-block-widget.ts";

test("sortToolsNewestFirst uses only start time when ordering tool history", () => {
	const tools = [
		{ id: "started-first-updated-last", name: "read", summary: "older start", state: "complete", startedAt: 10, updatedAt: 300 },
		{ id: "started-middle", name: "bash", summary: "middle start", state: "running", startedAt: 20, updatedAt: 100 },
		{ id: "started-last", name: "edit", summary: "latest start", state: "error", startedAt: 30, updatedAt: 200 },
	];

	assert.deepEqual(sortToolsNewestFirst(tools).map((tool) => tool.id), ["started-last", "started-middle", "started-first-updated-last"]);
});

test("sortToolsNewestFirst ignores update-time ties and falls back to reverse id only when start times match", () => {
	const tools = [
		{ id: "a", name: "read", summary: "older start", state: "complete", startedAt: 10, updatedAt: 999 },
		{ id: "b", name: "read", summary: "same start older update", state: "error", startedAt: 20, updatedAt: 100 },
		{ id: "c", name: "read", summary: "same start newer update", state: "running", startedAt: 20, updatedAt: 300 },
	];

	assert.deepEqual(sortToolsNewestFirst(tools).map((tool) => tool.id), ["c", "b", "a"]);
});
