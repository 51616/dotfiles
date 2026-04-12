import test from "node:test";
import assert from "node:assert/strict";
import { shouldStartNewBlockAfterMessageStart } from "../index.ts";

test("queued steering-style user messages split the current activity block after the initial trigger message", () => {
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "user" }, true, false), true);
});

test("initial trigger user message and non-user messages do not split the current activity block", () => {
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "user" }, true, true), false);
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "assistant" }, true, false), false);
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "toolResult" }, true, false), false);
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "custom", customType: "activity-block-turn" }, true, false), false);
	assert.equal(shouldStartNewBlockAfterMessageStart({ role: "user" }, false, false), false);
});
