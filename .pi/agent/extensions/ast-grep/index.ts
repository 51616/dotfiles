import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
	// Works in both CJS and ESM-ish execution environments.
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
		// Fall back to PATH. (We intentionally do NOT try `sg` because it commonly
		// conflicts with the system `sg` command from util-linux/shadow.)
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

			// Context flags: if `context` is provided, prefer it over before/after.
			if (typeof params.context === "number") {
				args.push("--context", String(params.context));
			} else {
				if (typeof params.before === "number") args.push("--before", String(params.before));
				if (typeof params.after === "number") args.push("--after", String(params.after));
			}

			if (params.json) {
				// NOTE: ast-grep requires `=` when specifying a style.
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
					// Ensure we run from the project cwd (not the extension folder)
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

			// ast-grep uses exit code 1 for "no matches". That shouldn't be treated as a tool error.
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
				// Keep the output (often contains the reason), but make the failure explicit.
				text = `ast-grep exited with code ${exitCode}.\n\n` + (text || "(no output)");
			}

			return {
				content: [{ type: "text", text: text || "(no output)" }],
				details,
			};
		},
	});
}
