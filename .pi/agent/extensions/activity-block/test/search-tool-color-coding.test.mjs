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
				id: "tool-fffind",
				name: "fffind",
				summary: "“activity block” in activity-block/ (excluding node_modules/; limit 20)",
				state: "complete",
				startedAt: 650,
				updatedAt: 700,
				completedAt: 700,
			},
			{
				id: "tool-ffgrep",
				name: "ffgrep",
				summary: "“fff” in repo (excluding test/; case-sensitive; 2 context lines; limit 20)",
				state: "complete",
				startedAt: 720,
				updatedAt: 760,
				completedAt: 760,
			},
			{
				id: "tool-run-skill-script",
				name: "run_skill_script",
				summary: "scripts/pi-ssh-setup.sh in pi-ssh via bash (timeout 30s, 2 args)",
				state: "complete",
				startedAt: 700,
				updatedAt: 800,
				completedAt: 800,
			},
		],
		totalTools: 6,
		activeTools: 0,
		completedTools: 6,
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
	return component.render(260).join("\n");
}

test("summarizeTool formats grep, find, fff, multi_grep, and run_skill_script arguments", () => {
	assert.equal(summarizeTool("grep", { pattern: "needle", path: "src", glob: "*.ts" }), "/needle/ in src (*.ts)");
	assert.equal(summarizeTool("find", { pattern: "*.test.mjs", path: "src", limit: 10 }), "*.test.mjs in src (limit 10)");
	assert.equal(
		summarizeTool("fffind", { pattern: "activity block", path: "activity-block/", exclude: ["node_modules/"], limit: 20 }),
		"“activity block” in activity-block/ (excluding node_modules/; limit 20)",
	);
	assert.equal(
		summarizeTool("ffgrep", { pattern: "fff", exclude: "test/", caseSensitive: true, context: 2, limit: 20 }),
		"“fff” in repo (excluding test/; case-sensitive; 2 context lines; limit 20)",
	);
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
			timeoutSeconds: 30,
		}),
		"scripts/pi-ssh-setup.sh in pi-ssh via bash (timeout 30s, 2 args)",
	);
});

test("ActivityBlockMessageComponent color codes grep, find, fff, multi_grep, and run_skill_script rows", () => {
	const rendered = render();

	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>grep<\/b><\/toolTitle> <accent>\/needle\/ in src \(\*\.ts\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>find<\/b><\/toolTitle> <accent>\*\.test\.mjs in src \(limit 10\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>ffgrep<\/b><\/toolTitle> <accent>“fff” in repo \(excluding test\/; case-sensitive; 2 context lines; limit 20\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>fffind<\/b><\/toolTitle> <accent>“activity block” in activity-block\/ \(excluding node_modules\/; limit 20\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>multi_grep<\/b><\/toolTitle> <accent>\/alpha\/ \| \/beta\/ in src \(\*\.ts\)<\/accent>/);
	assert.match(rendered, /<success>✓<\/success> <toolTitle><b>run-skill<\/b><\/toolTitle> <accent>scripts\/pi-ssh-setup\.sh in pi-ssh via bash \(timeout 30s, 2 args\)<\/accent>/);
});

test("ActivityBlockMessageComponent uses the theme border color for the block frame", () => {
	const rendered = render();

	assert.match(rendered, /<border>╭─+/);
	assert.match(rendered, /<border>│<\/border>/);
	assert.doesNotMatch(rendered, /\x1b\[38;2;245;194;231m/);
});
