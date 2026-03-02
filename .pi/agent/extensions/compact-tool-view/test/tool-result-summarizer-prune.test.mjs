import assert from "node:assert/strict";
import test from "node:test";

import { pruneToolCallArgumentsForContext } from "../../../.pi/extensions/tool-result-summarizer/prune-args.ts";

function makeSettings(patch = {}) {
	return {
		enabled: true,
		keepLastTurns: 5,
		keepLastTokens: 64000,
		blacklist: [],
		maxSummariesPerContext: 3,
		maxSummaryLines: 10,
		maxToolOutputCharsForSummarizer: 24000,
		pruneToolCallArgs: true,
		toolCallArgsMaxString: 100,
		toolCallArgsMaxDepth: 4,
		toolCallArgsMaxArray: 30,
		toolCallArgsAlwaysOmitKeys: ["oldText", "newText", "content", "data", "output"],
		summarizerModel: { provider: "openai-codex", modelId: "gpt-5.3-codex-spark", thinking: "medium" },
		...patch,
	};
}

test("pruneToolCallArgumentsForContext: edit oldText/newText become digest metadata", () => {
	const settings = makeSettings({ toolCallArgsMaxString: 50 });
	const args = {
		path: "foo.ts",
		oldText: "a".repeat(2000),
		newText: "b".repeat(1500),
	};

	const pruned = pruneToolCallArgumentsForContext("edit", args, settings);
	assert.equal(pruned.path, "foo.ts");
	assert.equal(typeof pruned.oldText, "object");
	assert.equal(pruned.oldText.omitted, true);
	assert.equal(pruned.oldText.chars, 2000);
	assert.equal(typeof pruned.oldText.sha256, "string");
	assert.equal(typeof pruned.newText.sha256, "string");
});

test("pruneToolCallArgumentsForContext: long bash command is truncated-with-digest, not omitted", () => {
	const settings = makeSettings({ toolCallArgsAlwaysOmitKeys: [], toolCallArgsMaxString: 60 });
	const args = { command: "echo " + "x".repeat(400) };

	const pruned = pruneToolCallArgumentsForContext("bash", args, settings);
	assert.equal(typeof pruned.command, "object");
	assert.equal(typeof pruned.command.text, "string");
	assert.match(pruned.command.text, /TRUNCATED/);
	assert.equal(pruned.command.chars, args.command.length);
	assert.equal(typeof pruned.command.sha256, "string");
});

test("pruneToolCallArgumentsForContext: always-omit keys are replaced even for short strings", () => {
	const settings = makeSettings({ toolCallArgsAlwaysOmitKeys: ["token"] });
	const args = { token: "SECRET", other: "ok" };
	const pruned = pruneToolCallArgumentsForContext("custom", args, settings);
	assert.equal(typeof pruned.token, "object");
	assert.equal(pruned.token.omitted, true);
	assert.equal(pruned.other, "ok");
});
