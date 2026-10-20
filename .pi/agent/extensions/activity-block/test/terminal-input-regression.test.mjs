import test from "node:test";
import assert from "node:assert/strict";
import { createActivityBlockHarness } from "../../test/helpers/activity-block-harness.mjs";

// Esc handling belongs to pi (app.interrupt). A raw terminal listener here once swallowed Esc for other UI.
test("session_start does not register a raw terminal input handler", async () => {
	const harness = createActivityBlockHarness();
	let terminalInputListenerCount = 0;
	harness.ctx.ui.onTerminalInput = () => {
		terminalInputListenerCount += 1;
		return () => {};
	};
	await harness.startSession();
	assert.equal(terminalInputListenerCount, 0);
});
