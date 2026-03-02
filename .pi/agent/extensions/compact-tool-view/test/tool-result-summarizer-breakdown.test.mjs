import assert from "node:assert/strict";
import test from "node:test";

import { computeTokenBreakdown } from "../../../.pi/extensions/tool-result-summarizer/utils.ts";

test("computeTokenBreakdown counts assistant thinking/text/toolCalls and tool results", () => {
	const messages = [
		{ role: "user", content: "hello", timestamp: 1 },
		{
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "abc", thinkingSignature: "{}" },
				{ type: "text", text: "hi" },
				{ type: "toolCall", id: "call_1", name: "edit", arguments: { path: "x", oldText: "A".repeat(1000) } },
			],
		},
		{
			role: "toolResult",
			timestamp: 3,
			toolCallId: "call_1",
			toolName: "edit",
			isError: false,
			content: [{ type: "text", text: "ok" }],
		},
	];

	const b = computeTokenBreakdown(messages);
	assert.equal(b.categories["user.text"].chars, 5);
	assert.equal(b.categories["assistant.thinking"].chars, 3);
	assert.equal(b.categories["assistant.text"].chars, 2);
	assert.equal(b.categories["toolResult.edit.text"].chars, 2);
	assert.ok(b.categories["assistant.toolCalls"].chars > 0);
	assert.ok(b.totalTokensApprox > 0);
});
