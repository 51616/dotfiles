import test from "node:test";
import assert from "node:assert/strict";
import activityBlockExtension from "../index.ts";

function makePiStub() {
	const handlers = new Map();
	return {
		handlers,
		pi: {
			on(name, handler) {
				handlers.set(String(name), handler);
			},
			registerMessageRenderer() {},
			registerCommand() {},
			registerShortcut() {},
			appendEntry() {},
		},
	};
}

test("session_start does not register a raw terminal input abort handler", async () => {
	const { pi, handlers } = makePiStub();
	activityBlockExtension(pi);

	let terminalInputListenerCount = 0;
	const ctx = {
		hasUI: true,
		sessionManager: {
			getBranch() {
				return [];
			},
		},
		ui: {
			setStatus() {},
			setLiveTranscriptMode() {},
			setHistoricalTranscriptMode() {},
			notify() {},
			onTerminalInput() {
				terminalInputListenerCount += 1;
				return () => {};
			},
		},
	};

	await handlers.get("session_start")({ type: "session_start" }, ctx);
	assert.equal(terminalInputListenerCount, 0);
});
