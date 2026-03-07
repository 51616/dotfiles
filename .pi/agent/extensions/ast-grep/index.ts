import type { ExtensionAPI, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { accessSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@mariozechner/pi-tui";

const JsonStyle = StringEnum(["pretty", "stream", "compact"] as const);

const AstGrepToolParams = Type.Object({
	pattern: Type.String({
		description:
			"AST pattern to match. Write it like code, using $VARS (e.g. $A, $MATCH) as wildcards.",
	}),
	lang: Type.Optional(
		Type.String({
			description:
				"Language of the pattern (e.g. ts, js, jsx, tsx, py, rs). If omitted, ast-grep infers from files.",
		}),
	),
	rewrite: Type.Optional(
		Type.String({
			description:
				"Rewrite template. If provided, ast-grep prints diffs by default (does not modify files unless apply=true).",
		}),
	),
	apply: Type.Optional(
		Type.Boolean({
			description:
				"If true, apply rewrite to files (equivalent to ast-grep --update-all). Requires rewrite.",
			default: false,
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description: "Paths to search (default: ['.']).",
		}),
	),
	globs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Include/exclude globs (repeatable). Same semantics as --globs in ast-grep; prefix with ! to exclude.",
		}),
	),
	context: Type.Optional(
		Type.Integer({
			description: "Show N lines of context around each match.",
			minimum: 0,
		}),
	),
	before: Type.Optional(
		Type.Integer({
			description: "Show N lines of context before each match.",
			minimum: 0,
		}),
	),
	after: Type.Optional(
		Type.Integer({
			description: "Show N lines of context after each match.",
			minimum: 0,
		}),
	),
	json: Type.Optional(JsonStyle),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Kill the command if it runs longer than this.",
			minimum: 1000,
			default: 120000,
		}),
	),
});

type AstGrepToolParams = Static<typeof AstGrepToolParams>;

interface AstGrepToolDetails {
	binary: string;
	args: string[];
	exitCode: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function getThisDir(): string {
	try {
		// @ts-expect-error - __dirname may not exist in ESM.
		return __dirname as string;
	} catch {
		return dirname(fileURLToPath(import.meta.url));
	}
}

function resolveAstGrepBinary(): { binary: string; hint?: string } {
	const here = getThisDir();
	const local = join(here, "node_modules", ".bin", "ast-grep");
	try {
		accessSync(local);
		return { binary: local };
	} catch {
		return {
			binary: "ast-grep",
			hint:
				"ast-grep binary not found next to this extension. If installed as a directory extension, run npm install in that directory (e.g. ~/.pi/agent/extensions/ast-grep). Or install globally: npm i -g @ast-grep/cli",
		};
	}
}

function writeTempOutputFile(output: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ast-grep-"));
	const file = join(dir, "output.txt");
	writeFileSync(file, output, "utf8");
	return file;
}

function shortenPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const home = os.homedir();
	if (p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function truncateInline(text: string, max = 72): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeList(values: string[], maxItems = 2): string {
	if (values.length === 0) return "";
	const shown = values.slice(0, maxItems).join(", ");
	const remaining = values.length - maxItems;
	return remaining > 0 ? `${shown} +${remaining}` : shown;
}

function buildCallSummary(args: any): string {
	const parts: string[] = [];

	if (typeof args?.pattern === "string" && args.pattern.trim()) {
		parts.push(`pattern=${JSON.stringify(truncateInline(args.pattern, 80))}`);
	} else if (args?.pattern != null) {
		parts.push("pattern=[invalid]");
	} else {
		parts.push("pattern=...");
	}

	if (typeof args?.lang === "string" && args.lang.trim()) {
		parts.push(`lang=${args.lang.trim()}`);
	}

	if (typeof args?.rewrite === "string" && args.rewrite.trim()) {
		parts.push(`rewrite=${JSON.stringify(truncateInline(args.rewrite, 72))}`);
	}

	if (args?.apply === true) {
		parts.push("apply=true");
	}

	if (Array.isArray(args?.paths) && args.paths.length > 0) {
		const paths = args.paths.map((value: unknown) => shortenPath(value)).filter(Boolean);
		if (paths.length > 0) parts.push(`paths=${summarizeList(paths, 2)}`);
	}

	if (Array.isArray(args?.globs) && args.globs.length > 0) {
		const globs = args.globs
			.map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
			.filter(Boolean);
		if (globs.length > 0) parts.push(`globs=${summarizeList(globs, 2)}`);
	}

	if (Number.isInteger(args?.context)) {
		parts.push(`context=${args.context}`);
	} else {
		if (Number.isInteger(args?.before)) parts.push(`before=${args.before}`);
		if (Number.isInteger(args?.after)) parts.push(`after=${args.after}`);
	}

	if (typeof args?.json === "string" && args.json.trim()) {
		parts.push(`json=${args.json.trim()}`);
	}

	if (Number.isInteger(args?.timeoutMs)) {
		parts.push(`timeoutMs=${args.timeoutMs}`);
	}

	return parts.join(" ");
}

function joinTextBlocks(result: { content?: Array<{ type: string; text?: string }> } | undefined): string {
	if (!result?.content) return "";
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => (c.text ?? "").replace(/\r/g, ""))
		.join("\n");
}

function styleToolOutput(theme: any, text: string): string {
	return text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast-grep",
		label: "ast-grep",
		description:
			`Structural search / rewrite using ast-grep (AST-based grep). ` +
			`If apply=true, rewrites are applied to files immediately (no confirmation). ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). ` +
			`If truncated, full output is saved to a temp file and the path is included in the result details.`,
		parameters: AstGrepToolParams,

		async execute(_toolCallId, params: AstGrepToolParams, signal, _onUpdate, ctx) {
			if (params.apply && !params.rewrite) {
				return {
					content: [
						{
							type: "text",
							text: "ast-grep: apply=true requires rewrite.",
						},
					],
					details: { exitCode: 2 } satisfies Partial<AstGrepToolDetails>,
				};
			}

			const { binary, hint } = resolveAstGrepBinary();

			const args: string[] = ["run", "--pattern", params.pattern, "--color", "never"];
			if (params.lang) args.push("--lang", params.lang);
			if (params.rewrite) args.push("--rewrite", params.rewrite);

			if (typeof params.context === "number") {
				args.push("--context", String(params.context));
			} else {
				if (typeof params.before === "number") args.push("--before", String(params.before));
				if (typeof params.after === "number") args.push("--after", String(params.after));
			}

			if (params.json) {
				args.push(`--json=${params.json}`);
			}

			if (params.apply) args.push("--update-all");
			for (const g of params.globs ?? []) args.push("--globs", g);
			for (const p of params.paths ?? ["."]) args.push(p);

			let stdout = "";
			let stderr = "";
			let exitCode = 0;
			try {
				const res = await pi.exec(binary, args, {
					signal,
					timeout: params.timeoutMs ?? 120000,
					cwd: ctx.cwd,
				});
				stdout = res.stdout ?? "";
				stderr = res.stderr ?? "";
				exitCode = res.code ?? 0;
			} catch (e: any) {
				const msg = typeof e?.message === "string" ? e.message : String(e);
				return {
					content: [
						{
							type: "text",
							text:
								`ast-grep failed to execute. ${hint ? `Hint: ${hint}` : ""}\n\nError: ${msg}`.trim(),
						},
					],
					details: {
						binary,
						args,
						exitCode: 127,
					} satisfies AstGrepToolDetails,
				};
			}

			const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n\n");

			if (exitCode === 1 && combined.length === 0) {
				return {
					content: [{ type: "text", text: "No matches found." }],
					details: { binary, args, exitCode } satisfies AstGrepToolDetails,
				};
			}

			const truncation = truncateHead(combined || "", {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: AstGrepToolDetails = {
				binary,
				args,
				exitCode,
			};

			let text = truncation.content;

			if (truncation.truncated) {
				const fullOutputPath = writeTempOutputFile(combined);
				details.truncation = truncation;
				details.fullOutputPath = fullOutputPath;
				text +=
					`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
					`Full output saved to: ${fullOutputPath}]`;
			}

			if (exitCode !== 0 && exitCode !== 1) {
				text = `ast-grep exited with code ${exitCode}.\n\n` + (text || "(no output)");
			}

			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details,
			};
		},

		renderCall(args: any, theme: any) {
			const title = theme.fg("accent", theme.bold("ast-grep"));
			const summary = buildCallSummary(args);
			const body = summary ? theme.fg("toolTitle", summary) : theme.fg("toolOutput", "...");
			return new Text(`${title} ${body}`, 0, 0);
		},

		renderResult(result: any, options: ToolRenderResultOptions, theme: any) {
			if (!options.expanded) return undefined;
			const output = joinTextBlocks(result);
			if (!output.trim()) return undefined;
			return new Text(`\n${styleToolOutput(theme, output)}`, 0, 0);
		},
	});
}
