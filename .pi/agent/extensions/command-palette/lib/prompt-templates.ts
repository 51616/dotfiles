import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

const PLACEHOLDER_PATTERN = /\$(?:\d+|@|ARGUMENTS)\b|\$\{@:\d+(?::\d+)?\}/;

export function parsePromptTemplateArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: '"' | "'" | null = null;

	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}

		if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) {
		args.push(current);
	}

	return args;
}

export function substitutePromptTemplateArgs(content: string, args: string[]): string {
	let result = content;

	result = result.replace(/\$(\d+)/g, (_, num: string) => {
		const index = Number.parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = Number.parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) {
			const length = Number.parseInt(lengthStr, 10);
			return args.slice(start, start + length).join(" ");
		}
		return args.slice(start).join(" ");
	});

	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

export function hasPromptTemplatePlaceholders(content: string): boolean {
	return PLACEHOLDER_PATTERN.test(content);
}

export function loadPromptTemplateBody(filePath: string): string {
	const rawContent = readFileSync(filePath, "utf8");
	return parseFrontmatter(rawContent).body;
}

export function buildPromptTemplateInsertionText(content: string, currentLineText: string | null | undefined): string {
	return currentLineText && currentLineText.trim().length > 0 ? `\n\n${content}` : content;
}

export function getFallbackCurrentLineText(editorText: string): string {
	const lines = editorText.split("\n");
	return lines.at(-1) ?? "";
}
