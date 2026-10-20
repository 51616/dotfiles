import test from "node:test";
import assert from "node:assert/strict";
import { isTriggerMessage } from "../index.ts";

test("user messages and displayed custom messages are block triggers", () => {
	assert.equal(isTriggerMessage({ role: "user" }), true);
	assert.equal(isTriggerMessage({ role: "custom", display: true }), true);
});

test("assistant, tool results, hidden custom messages, and bash executions never start a block", () => {
	assert.equal(isTriggerMessage({ role: "assistant" }), false);
	assert.equal(isTriggerMessage({ role: "toolResult" }), false);
	assert.equal(isTriggerMessage({ role: "custom", display: false }), false);
	assert.equal(isTriggerMessage({ role: "custom" }), false);
	assert.equal(isTriggerMessage({ role: "bashExecution" }), false);
});
