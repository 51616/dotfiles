import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import { summarizeTool } from "../lib/activity-block-state.ts";
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

function createSnapshot(overrides = {}) {
	return {
		runState: "complete",
		startedAt: 0,
		endedAt: 1_000,
		finalLabel: "Completed",
		latestThinking: "",
		latestThinkingFull: "",
		thinkingSummaries: [],
		lastThinkingAt: undefined,
		lastToolSummary: "/needle/ in src (*.ts)",
		lastToolUpdateAt: 900,
		currentActivity: undefined,
		previousActivity: undefined,
		isResponding: false,
		tools: [
			{
				id: "tool-grep",
				name: "grep",
				summary: "/needle/ in src (*.ts)",
				state: "complete",
				startedAt: 100,
				updatedAt: 200,
				completedAt: 200,
			},
			{
				id: "tool-find",
				name: "find",
				summary: "*.test.mjs in src (limit 10)",
				state: "complete",
				startedAt: 300,
				updatedAt: 400,
				completedAt: 400,
			},
			{
				id: "tool-multi-grep",
				name: "multi_grep",
				summary: "/alpha/ | /beta/ in src (*.ts)",
				state: "complete",
				startedAt: 500,
				updatedAt: 600,
				completedAt: 600,
			},
			{
				id: "tool-run-skill-script",
				name: "run_skill_script",
				summary: "scripts/pi-ssh-setup.sh in pi-ssh via bash (remote, timeout 30s, 2 args)",
				state: "complete",
				startedAt: 700,
				updatedAt: 800,
				completedAt: 800,
			},
		],
		totalTools: 4,
		activeTools: 0,
		completedTools: 4,
		failedTools: 0,
		latestActiveTool: undefined,
		latestToolView: undefined,
		...overrides,
	};
}

function render(snapshotOverrides = {}) {
	const component = new ActivityBlockMessageComponent(
		colorTheme,
		() => createSnapshot(snapshotOverrides),
		() => 1_000,
		() => "all",
		() => false,
		() => 0,
	);
	return component.render(160).join("\n");
}

test("summarizeTool formats grep, find, multi_grep, and run_skill_script arguments", () => {
	assert.equal(summarizeTool("grep", { pattern: "needle", path: "src", glob: "*.ts" }), "/needle/ in src (*.ts)");
	assert.equal(summarizeTool("find", { pattern: "*.test.mjs", path: "src", limit: 10 }), "*.test.mjs in src (limit 10)");
	assert.equal(
		summarizeTool("multi_grep", { patterns: ["alpha", "beta"], path: "src", glob: "*.ts" }),
		"/alpha/ | /beta/ in src (*.ts)",
	);
	assert.equal(
		summarizeTool("run_skill_script", {
			script: "scripts/pi-ssh-setup.sh",
			skill: "pi-ssh",
			interpreter: "bash",
			args: ["--verify", "--json"],
			target: "remote",
			timeoutSeconds: 30,
		}),
		"scripts/pi-ssh-setup.sh in pi-ssh via bash (remote, timeout 30s, 2 args)",
	);
});

test("ActivityBlockMessageComponent color codes grep, find, multi_grep, and run_skill_script rows", () => {
	const rendered = render();

	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>grep<\/b><\/toolTitle> <accent>\/needle\/ in src \(\*\.ts\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>find<\/b><\/toolTitle> <accent>\*\.test\.mjs in src \(limit 10\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>multi_grep<\/b><\/toolTitle> <accent>\/alpha\/ \| \/beta\/ in src \(\*\.ts\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>run-skill<\/b><\/toolTitle> <accent>scripts\/pi-ssh-setup\.sh in pi-ssh via bash \(remote, timeout 30s, 2 args\)<\/accent>/);
});
