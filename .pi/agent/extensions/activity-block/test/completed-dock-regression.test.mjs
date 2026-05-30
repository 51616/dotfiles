import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import activityBlockExtension from "../index.ts";

initTheme();

const colorTheme = {
	bold: (text) => `<b>${text}</b>`,
	fg: (name, text) => `<${name}>${text}</${name}>`,
	bg: (_name, text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
};

function makePiStub() {
	const handlers = new Map();
	const appended = [];
	let renderer;
	return {
		handlers,
		appended,
		getRenderer() {
			assert.ok(renderer, "activity-block renderer was registered");
			return renderer;
		},
		pi: {
			on(name, handler) {
				handlers.set(String(name), handler);
			},
			registerMessageRenderer(type, factory) {
				renderer = { type, factory };
			},
			registerCommand() {},
			registerShortcut() {},
			appendEntry(type, data) {
				appended.push({ type, data });
			},
		},
	};
}

function makeCtx() {
	const widgetCalls = [];
	return {
		widgetCalls,
		ctx: {
			hasUI: true,
			isIdle() {
				return true;
			},
			getContextUsage() {
				return { tokens: 0 };
			},
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
				setWidget(key, content, options) {
					widgetCalls.push({ key, content, options });
				},
			},
		},
	};
}

async function startActivityBlockTurn(handlers, ctx) {
	return handlers.get("before_turn_response")({
		type: "before_turn_response",
		turnIndex: 0,
		triggerMessages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
		systemPrompt: "",
	}, ctx);
}

function renderTranscriptBlock(renderer, details) {
	const component = renderer.factory({
		role: "custom",
		customType: renderer.type,
		content: "activity block",
		details,
	}, {}, colorTheme);
	return component.render(80);
}

test("completed turns clear the above-editor dock and reveal the transcript block immediately", async () => {
	const { pi, handlers, appended, getRenderer } = makePiStub();
	const { ctx, widgetCalls } = makeCtx();
	activityBlockExtension(pi);

	await handlers.get("session_start")({ type: "session_start" }, ctx);
	const prepared = await startActivityBlockTurn(handlers, ctx);
	const details = prepared?.message?.details;
	assert.ok(details?.turnId, "activity-block turn message was created");
	assert.equal(widgetCalls.at(-1)?.key, "activity-block-live-dock");
	assert.equal(typeof widgetCalls.at(-1)?.content, "function");
	assert.deepEqual(renderTranscriptBlock(getRenderer(), details), []);

	await handlers.get("agent_end")({
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
	}, ctx);

	assert.equal(appended.length, 1);
	assert.equal(appended[0].type, "activity-block-state");
	assert.equal(widgetCalls.at(-1)?.key, "activity-block-live-dock");
	assert.equal(widgetCalls.at(-1)?.content, undefined);
	assert.match(renderTranscriptBlock(getRenderer(), details).join("\n"), /COMPLETED!/);
});
