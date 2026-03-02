import * as os from "node:os";

import type { ExtensionAPI, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	getLanguageFromPath,
	highlightCode,
	renderDiff,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

function shortenPath(p: unknown): string {
	if (typeof p !== "string") return "";
	const home = os.homedir();
	if (p.startsWith(home)) return `~${p.slice(home.length)}`;
	return p;
}

function coerceString(v: unknown): string | null {
	if (typeof v === "string") return v;
	if (v == null) return "";
	return null;
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

function highlightIfPossible(text: string, filePath: string | undefined): { text: string; highlighted: boolean } {
	if (!filePath) return { text, highlighted: false };
	const lang = getLanguageFromPath(filePath);
	if (!lang) return { text, highlighted: false };
	return { text: highlightCode(text.replace(/\t/g, "   "), lang).join("\n"), highlighted: true };
}

export default function (pi: ExtensionAPI) {
	// Goal:
	// - collapsed view: only show the command line (no output preview)
	// - expanded view (Ctrl+O): show the output inside the same tool block
	// - keep background coloring unchanged (pending/success/error)
	// - color-code the command text (read/write/edit/bash)

	// read
	{
		let lastArgs: any;
		const base = createReadTool(process.cwd());
		pi.registerTool({
			...base,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				return createReadTool(ctx.cwd).execute(toolCallId, params, signal);
			},
			renderCall(args: any, theme: any) {
				lastArgs = args;

				const rawPath = coerceString(args?.file_path ?? args?.path);
				const offset = args?.offset;
				const limit = args?.limit;

				const pathText =
					rawPath === null
						? theme.fg("error", "[invalid arg]")
						: rawPath
							? theme.fg("accent", shortenPath(rawPath))
							: theme.fg("toolOutput", "...");

				let range = "";
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					range = theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
				}

				return new Text(`${theme.fg("accent", theme.bold("read"))} ${pathText}${range}`, 0, 0);
			},
			renderResult(result: any, options: ToolRenderResultOptions, theme: any) {
				if (!options.expanded) return undefined;

				const output = joinTextBlocks(result);
				if (!output.trim()) return undefined;

				const rawPath = coerceString(lastArgs?.file_path ?? lastArgs?.path);
				const { text, highlighted } = highlightIfPossible(output, rawPath ?? undefined);
				const finalText = highlighted ? text : styleToolOutput(theme, text);
				return new Text(`\n${finalText}`, 0, 0);
			},
		});
	}

	// write
	{
		let lastArgs: any;
		const base = createWriteTool(process.cwd());
		pi.registerTool({
			...base,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				return createWriteTool(ctx.cwd).execute(toolCallId, params, signal);
			},
			renderCall(args: any, theme: any) {
				lastArgs = args;

				const rawPath = coerceString(args?.file_path ?? args?.path);
				const pathText =
					rawPath === null
						? theme.fg("error", "[invalid arg]")
						: rawPath
							? theme.fg("accent", shortenPath(rawPath))
							: theme.fg("toolOutput", "...");

				return new Text(`${theme.fg("success", theme.bold("write"))} ${pathText}`, 0, 0);
			},
			renderResult(result: any, options: ToolRenderResultOptions, theme: any) {
				if (!options.expanded) return undefined;

				const rawPath = coerceString(lastArgs?.file_path ?? lastArgs?.path);
				const fileContent = coerceString(lastArgs?.content);

				let out = "";
				if (fileContent === null) {
					out = "[invalid content arg - expected string]";
				} else if (fileContent && fileContent.length > 0) {
					const { text, highlighted } = highlightIfPossible(fileContent.replace(/\r/g, ""), rawPath ?? undefined);
					out = highlighted ? text : styleToolOutput(theme, text);
				}

				// If tool produced additional text (e.g. error), include it underneath.
				const toolText = joinTextBlocks(result);
				if (toolText.trim()) {
					const styledToolText = styleToolOutput(theme, toolText);
					out = out ? `${out}\n\n${styledToolText}` : styledToolText;
				}

				return out ? new Text(`\n${out}`, 0, 0) : undefined;
			},
		});
	}

	// edit
	{
		let lastArgs: any;
		const base = createEditTool(process.cwd());
		pi.registerTool({
			...base,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				return createEditTool(ctx.cwd).execute(toolCallId, params, signal);
			},
			renderCall(args: any, theme: any) {
				lastArgs = args;

				const rawPath = coerceString(args?.file_path ?? args?.path);
				const pathText =
					rawPath === null
						? theme.fg("error", "[invalid arg]")
						: rawPath
							? theme.fg("accent", shortenPath(rawPath))
							: theme.fg("toolOutput", "...");

				return new Text(`${theme.fg("warning", theme.bold("edit"))} ${pathText}`, 0, 0);
			},
			renderResult(result: any, options: ToolRenderResultOptions, theme: any) {
				if (!options.expanded) return undefined;

				const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
				if (diff) {
					const rawPath = coerceString(lastArgs?.file_path ?? lastArgs?.path);
					return new Text(`\n${renderDiff(diff, { filePath: rawPath ?? undefined })}`, 0, 0);
				}

				const output = joinTextBlocks(result);
				if (!output.trim()) return undefined;
				return new Text(`\n${styleToolOutput(theme, output)}`, 0, 0);
			},
		});
	}

	// bash
	{
		const base = createBashTool(process.cwd());
		pi.registerTool({
			...base,
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				return createBashTool(ctx.cwd).execute(toolCallId, params, signal);
			},
			renderCall(args: any, theme: any) {
				const command = coerceString(args?.command);
				const timeout = args?.timeout;
				const timeoutText = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

				const dollar = theme.fg("bashMode", theme.bold("$"));

				const cmdText =
					command === null
						? theme.fg("error", "[invalid arg]")
						: command
							? theme.fg("toolTitle", command)
							: theme.fg("toolOutput", "...");

				return new Text(`${dollar} ${cmdText}${timeoutText}`, 0, 0);
			},
			renderResult(result: any, options: ToolRenderResultOptions, theme: any) {
				if (!options.expanded) return undefined;
				const output = joinTextBlocks(result);
				if (!output.trim()) return undefined;
				return new Text(`\n${styleToolOutput(theme, output)}`, 0, 0);
			},
		});
	}
}
