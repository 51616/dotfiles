// @lat: [[activity-block#Activity block]]
// Pure parsers for `/activity-block` arguments and the tool-history view cycle.

import type { ToolHistoryViewMode } from "./activity-block-widget.ts";

/**
 * `block`: tool rows are hidden from pi's transcript and new runs get an activity block.
 * `default`: pi renders tool rows normally and no new blocks are created.
 */
export type TranscriptViewMode = "block" | "default";

export function parseExpandCommand(args: string): boolean | undefined {
	const command = args.trim().toLowerCase();
	if (command === "expand") return true;
	if (command === "collapse") return false;
	return undefined;
}

export function parseToolHistoryViewMode(args: string): ToolHistoryViewMode | undefined {
	const command = args.trim().toLowerCase();
	if (!command) return undefined;
	if (command === "expand" || command === "all") return "all";
	if (command === "collapse" || command === "latest") return "latest";
	if (command === "recent" || command === "5" || command === "five" || command === "5 latest" || command === "latest 5" || command === "5-latest") return "recent";
	return undefined;
}

export function parseZenModeCommand(args: string): boolean | "toggle" | undefined {
	const command = args.trim().toLowerCase();
	if (command === "zen") return "toggle";
	if (command === "zen on" || command === "zen enable" || command === "zen enabled") return true;
	if (command === "zen off" || command === "zen disable" || command === "zen disabled") return false;
	return undefined;
}

export function parseTranscriptViewModeCommand(args: string): TranscriptViewMode | undefined {
	const command = args.trim().toLowerCase().replace(/\s+/g, " ");
	if (command === "mode default" || command === "view default" || command === "default" || command === "default view") return "default";
	if (command === "mode block" || command === "view block" || command === "block" || command === "block view" || command === "activity block") return "block";
	return undefined;
}

export function getNextToolHistoryViewMode(
	currentMode: ToolHistoryViewMode,
	_totalTools: number,
	options?: { expandedThinkingShown?: boolean },
): ToolHistoryViewMode {
	if (options?.expandedThinkingShown) {
		return currentMode === "latest" ? "recent" : "latest";
	}
	if (currentMode === "latest") return "recent";
	if (currentMode === "recent") return "all";
	return "latest";
}
