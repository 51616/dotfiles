import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { createActivityBlockHarness, stateEntries } from "../../test/helpers/activity-block-harness.mjs";

initTheme();

test("responding turns stay in the above-editor dock until the run settles", async () => {
	const harness = createActivityBlockHarness();
	await harness.startSession();
	await harness.run.start();
	await harness.run.assistant([{ type: "text", text: "done" }]);
	const [anchor] = harness.anchors();

	assert.match(harness.renderDock().join("\n"), /Responding/);
	assert.deepEqual(harness.renderAnchor(anchor), [], "no duplicate block in the transcript while docked");

	await harness.run.end([{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }]);
	assert.match(harness.renderDock().join("\n"), /Responding/, "agent_end is not final; pi may still retry");

	await harness.run.settle();
	assert.equal(stateEntries(harness).length, 1);
	assert.deepEqual(harness.renderDock(), []);
	assert.match(harness.renderAnchor(anchor).join("\n"), /COMPLETED!/);
});

test("the dock widget is installed once per session and never re-registered per run", async () => {
	const harness = createActivityBlockHarness();
	await harness.startSession();
	for (let index = 0; index < 3; index += 1) {
		await harness.run.start();
		await harness.run.assistant([{ type: "text", text: `run ${index}` }]);
		await harness.run.end();
		await harness.run.settle();
	}
	assert.equal(harness.widgetCalls.filter((call) => call.key === "activity-block-live-dock").length, 1);
	assert.equal(harness.anchors().length, 3);
	assert.deepEqual(harness.anchors().map((anchor) => anchor.data.turnDisplayId), ["1", "2", "3"]);
});
