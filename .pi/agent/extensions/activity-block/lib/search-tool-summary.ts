const MAX_SEARCH_SUMMARY_LENGTH = 96;

export function summarizeFffindTool(args: unknown): string {
	const pattern = quoteSearchText(getStringProperty(args, ["pattern"]));
	const path = formatSearchScope(getStringProperty(args, ["path"]));
	const exclude = formatExcludeList(getStringOrStringArrayProperty(args, ["exclude"]));
	const limit = getNumberProperty(args, ["limit"]);
	const cursor = getStringProperty(args, ["cursor"]);
	const modifiers = [
		exclude ? `excluding ${exclude}` : undefined,
		limit !== undefined ? `limit ${limit}` : undefined,
		cursor ? "next page" : undefined,
	].filter((value): value is string => Boolean(value));
	let summary = `files matching ${pattern} in ${path}`;
	if (modifiers.length > 0) summary += ` (${modifiers.join("; ")})`;
	return normalizeSearchExcerpt(summary);
}

export function summarizeFfgrepTool(args: unknown): string {
	const pattern = quoteSearchText(getStringProperty(args, ["pattern"]));
	const path = formatSearchScope(getStringProperty(args, ["path"]));
	const exclude = formatExcludeList(getStringOrStringArrayProperty(args, ["exclude"]));
	const limit = getNumberProperty(args, ["limit"]);
	const context = getNumberProperty(args, ["context"]);
	const cursor = getStringProperty(args, ["cursor"]);
	const caseSensitive = getBooleanProperty(args, ["caseSensitive"]);
	const modifiers = [
		exclude ? `excluding ${exclude}` : undefined,
		caseSensitive ? "case-sensitive" : undefined,
		context !== undefined ? `${context} context line${context === 1 ? "" : "s"}` : undefined,
		limit !== undefined ? `limit ${limit}` : undefined,
		cursor ? "next page" : undefined,
	].filter((value): value is string => Boolean(value));
	let summary = `text matching ${pattern} in ${path}`;
	if (modifiers.length > 0) summary += ` (${modifiers.join("; ")})`;
	return normalizeSearchExcerpt(summary);
}

function normalizeSearchExcerpt(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SEARCH_SUMMARY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_SEARCH_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function quoteSearchText(value: string | undefined): string {
	return value ? `“${value}”` : "…";
}

function formatSearchScope(path: string | undefined): string {
	if (!path || path === "." || path === "./") return "repo";
	return path;
}

function formatExcludeList(values: string[]): string | undefined {
	if (values.length === 0) return undefined;
	return values.slice(0, 3).join(", ") + (values.length > 3 ? ", …" : "");
}

function getStringProperty(value: unknown, keys: string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return undefined;
}

function getNumberProperty(value: unknown, keys: string[]): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
	}
	return undefined;
}

function getBooleanProperty(value: unknown, keys: string[]): boolean | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "boolean") return candidate;
	}
	return undefined;
}

function getStringOrStringArrayProperty(value: unknown, keys: string[]): string[] {
	if (!value || typeof value !== "object") return [];
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (Array.isArray(candidate)) {
			return candidate
				.map((item) => typeof item === "string" ? item.trim() : "")
				.filter((item) => item.length > 0);
		}
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item.length > 0);
		}
	}
	return [];
}
