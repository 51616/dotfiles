import * as os from "node:os";

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

export function buildAstGrepCallSummary(args: any): string {
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

	if (Array.isArray(args?.paths) && args.paths.length > 0) {
		const paths = args.paths
			.map((value: unknown) => shortenPath(value))
			.filter(Boolean);
		if (paths.length > 0) {
			parts.push(`paths=${summarizeList(paths, 2)}`);
		}
	}

	if (Array.isArray(args?.globs) && args.globs.length > 0) {
		const globs = args.globs
			.map((value: unknown) => (typeof value === "string" ? value.trim() : ""))
			.filter(Boolean);
		if (globs.length > 0) {
			parts.push(`globs=${summarizeList(globs, 2)}`);
		}
	}

	if (typeof args?.rewrite === "string" && args.rewrite.trim()) {
		parts.push(`rewrite=${JSON.stringify(truncateInline(args.rewrite, 72))}`);
	}

	if (args?.apply === true) {
		parts.push("apply=true");
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
