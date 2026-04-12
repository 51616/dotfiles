import { getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type Component, type MarkdownTheme } from "@mariozechner/pi-tui";
import type { ActivityBlockSnapshot, ToolActivity, ToolState } from "./activity-block-state.ts";

const DEFAULT_MAX_RENDERED_LINES = 20;
const THINKING_EXPANDED_MAX_RENDERED_LINES = 20;
const DEFAULT_THOUGHT_LINES = 1;
const EXPANDED_THOUGHT_LINES = 15;
const THINKING_EXPANDED_TOOL_HISTORY_ROWS = 5;
const MAX_THINKING_DISPLAY_CHARS = 500;
const CATPPUCCIN_PINK_ANSI = "\x1b[38;2;245;194;231m";
const RESET_FG_ANSI = "\x1b[39m";
const ANSI_RESET_WITH_FG_RE = /\x1b\[(?:0|39)m/g;

type ThemeColor = "text" | "dim" | "success" | "error" | "warning" | "accent" | "toolOutput" | "toolTitle" | "muted" | "bashMode";
type ThemeBgColor = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" | "selectedBg";
type ToolRowView = { text: string; color?: ThemeColor; toolState?: ToolState; placeholder?: boolean };

export type ToolHistoryViewMode = "latest" | "recent" | "all";

const RECENT_TOOL_HISTORY_ROWS = 5;

export interface ActivityBlockViewModel {
	title: string;
	status: string;
	primary: string;
	secondary: string;
	secondaryRight?: string;
	tertiary?: string;
	spinner?: string;
}

export function formatActivityBlock(
	snapshot: ActivityBlockSnapshot,
	now: number,
	title = "Activity",
): ActivityBlockViewModel {
	const spinner = shouldShowSpinner(snapshot) ? getSpinnerFrame(now) : undefined;
	const liveStopAt = snapshot.isResponding
		? (snapshot.respondingStartedAt ?? snapshot.lastToolUpdateAt ?? snapshot.lastThinkingAt ?? now)
		: now;
	const stopAt = snapshot.endedAt ?? liveStopAt;
	const elapsedMs = Math.max(0, stopAt - (snapshot.startedAt ?? stopAt));
	const elapsedLabel = formatDuration(elapsedMs);
	const counts = formatToolCallCounts(snapshot.totalTools, snapshot.failedTools);
	const tokens = formatTokenCount(snapshot.latestTokenCount);
	const running = "Cooking";

	if (snapshot.runState === "complete" || snapshot.runState === "aborted" || snapshot.runState === "error") {
		const terminal = normalizeTerminalStatus(snapshot.finalLabel ?? capitalize(snapshot.runState), snapshot.runState);
		return {
			title,
			status: terminal,
			primary: chooseTerminalPrimary(snapshot),
			secondary: joinParts([counts, tokens]),
			secondaryRight: elapsedLabel,
			spinner,
		};
	}

	if (snapshot.isResponding) {
		return {
			title,
			status: "Responding",
			primary: chooseRespondingPrimary(snapshot),
			secondary: joinParts([counts, tokens]),
			secondaryRight: elapsedLabel,
			tertiary: chooseRespondingTertiary(snapshot),
			spinner,
		};
	}

	if (snapshot.latestActiveTool) {
		return {
			title,
			status: running,
			primary: `${snapshot.latestActiveTool.name} ${snapshot.latestActiveTool.summary}`.trim(),
			secondary: joinParts([counts, tokens]),
			secondaryRight: elapsedLabel,
			tertiary: snapshot.activeTools > 1 ? `${snapshot.activeTools} tools active; showing the latest update` : undefined,
			spinner,
		};
	}

	if (snapshot.latestThinking) {
		return {
			title,
			status: "Cooking",
			primary: snapshot.latestThinking,
			secondary: joinParts([counts, tokens]),
			secondaryRight: elapsedLabel,
			spinner,
		};
	}

	if (snapshot.lastToolSummary) {
		return {
			title,
			status: running,
			primary: "",
			secondary: joinParts([counts, tokens]),
			secondaryRight: elapsedLabel,
			spinner,
		};
	}

	return {
		title,
		status: snapshot.runState === "running" ? "Waiting for the first update" : capitalize(snapshot.runState),
		primary: snapshot.runState === "running" ? "" : "Done",
		secondary: joinParts([counts, tokens]),
		secondaryRight: elapsedLabel,
		spinner,
	};
}

function createPendingSnapshot(now: number): ActivityBlockSnapshot {
	return {
		runState: "running",
		startedAt: now,
		endedAt: undefined,
		finalLabel: undefined,
		latestThinking: "",
		latestThinkingFull: "",
		thinkingSummaries: [],
		lastThinkingAt: undefined,
		lastToolSummary: undefined,
		lastToolUpdateAt: undefined,
		respondingStartedAt: undefined,
		turnTokenBaseline: undefined,
		latestTokenCount: undefined,
		currentActivity: undefined,
		previousActivity: undefined,
		isResponding: false,
		tools: [],
		totalTools: 0,
		activeTools: 0,
		completedTools: 0,
		failedTools: 0,
		latestActiveTool: undefined,
		latestToolView: undefined,
	};
}

export class ActivityBlockMessageComponent implements Component {
	private readonly theme: Theme;
	private readonly getSnapshot: () => ActivityBlockSnapshot | undefined;
	private readonly getNow: () => number;
	private readonly getToolHistoryViewMode: () => ToolHistoryViewMode;
	private readonly getThinkingExpanded: () => boolean;
	private readonly getCompactionCount: () => number;
	private readonly shouldHide: () => boolean;
	private readonly markdownTheme: MarkdownTheme;

	constructor(
		theme: Theme,
		getSnapshot: () => ActivityBlockSnapshot | undefined,
		getNow: () => number,
		getToolHistoryViewMode: () => ToolHistoryViewMode,
		getThinkingExpanded: () => boolean,
		getCompactionCount: () => number,
		shouldHide: () => boolean = () => false,
	) {
		this.theme = theme;
		this.getSnapshot = getSnapshot;
		this.getNow = getNow;
		this.getToolHistoryViewMode = getToolHistoryViewMode;
		this.getThinkingExpanded = getThinkingExpanded;
		this.getCompactionCount = getCompactionCount;
		this.shouldHide = shouldHide;
		this.markdownTheme = getMarkdownTheme();
	}

	invalidate(): void {
		this.markdownTheme = getMarkdownTheme();
	}

	render(width: number): string[] {
		if (this.shouldHide()) return [];
		const rawNow = this.getNow();
		const timerNow = alignRenderClock(rawNow);
		const snapshot = this.getSnapshot() ?? createPendingSnapshot(timerNow);
		const model = formatActivityBlock(snapshot, timerNow);
		const thinkingSource = getThinkingSource(snapshot);
		const { header: thinkingHeader } = splitThinkingSource(thinkingSource || snapshot.latestThinking);
		const innerWidth = Math.max(1, width - 2);
		const toolHistoryViewMode = normalizeToolHistoryViewMode(this.getToolHistoryViewMode() as ToolHistoryViewMode | boolean | undefined);
		const thinkingExpanded = this.getThinkingExpanded();
		const inlineThinkingHeader = shouldInlineThinkingHeader(snapshot, thinkingHeader, toolHistoryViewMode, thinkingExpanded);
		const statusText = chooseStatusText(this.theme, this.markdownTheme, snapshot, model, thinkingHeader, innerWidth, inlineThinkingHeader);
		const statusLabel = decorateBlockTitle(statusText);
		if (width <= 14) {
			const line = `${statusLabel} ${model.primary}`.trim();
			return [applyPersistentColor(fitToWidth(line, width), statusRowWrapper(this.theme))];
		}

		const showAllToolHistory = toolHistoryViewMode === "all";
		const showThinkingPanel = shouldShowThinkingPanel(toolHistoryViewMode, thinkingExpanded);
		const maxRenderedLines = thinkingExpanded ? THINKING_EXPANDED_MAX_RENDERED_LINES : DEFAULT_MAX_RENDERED_LINES;
		const rows = [
			renderBorder("╭", "╮", innerWidth),
			renderRow(innerWidth, statusLabel, statusRowWrapper(this.theme)),
			renderEmptyRow(innerWidth, this.theme),
		];
		const footerReservation = 2;
		const thinkingExpandedHasToolHistory = thinkingExpanded && hasThinkingExpandedToolHistory(snapshot, toolHistoryViewMode);
		const thoughtLines = showThinkingPanel
			? renderThinkingBlockRows(
				this.theme,
				this.markdownTheme,
				snapshot,
				innerWidth,
				thinkingExpanded,
				thinkingExpanded
					? Math.max(
						0,
						maxRenderedLines
							- rows.length
							- footerReservation
							- 1
							- (thinkingExpandedHasToolHistory ? THINKING_EXPANDED_TOOL_HISTORY_ROWS + 1 : 0),
					)
					: EXPANDED_THOUGHT_LINES,
				inlineThinkingHeader,
			)
			: [];
		const thoughtSpacer = thoughtLines.length > 0 ? 1 : 0;
		const detail = model.secondary || " ";
		let primaryLines: string[] = [];
		let expandedDetailLines: ToolRowView[] = [];
		let thinkingExpandedToolHistoryRows: string[] = [];
		if (thinkingExpanded) {
			const maxToolHistoryRows = Math.max(0, maxRenderedLines - rows.length - thoughtLines.length - thoughtSpacer - footerReservation - 1);
			thinkingExpandedToolHistoryRows = renderThinkingExpandedToolHistoryRows(
				this.theme,
				snapshot,
				innerWidth,
				timerNow,
				toolHistoryViewMode,
				maxToolHistoryRows,
			);
			if (thinkingExpandedToolHistoryRows.length === 0) {
				const fallbackBudget = Math.max(1, maxRenderedLines - rows.length - thoughtLines.length - thoughtSpacer - footerReservation - 1);
				primaryLines = renderPrimaryLines(
					this.theme,
					this.markdownTheme,
					snapshot,
					model,
					innerWidth,
					fallbackBudget,
					toolHistoryViewMode,
					thinkingExpanded,
					thoughtLines.length > 0,
					timerNow,
				);
			}
		} else {
			const primaryBudget = Math.max(1, maxRenderedLines - rows.length - thoughtLines.length - thoughtSpacer - 3);
			primaryLines = renderPrimaryLines(
				this.theme,
				this.markdownTheme,
				snapshot,
				model,
				innerWidth,
				primaryBudget,
				toolHistoryViewMode,
				thinkingExpanded,
				thoughtLines.length > 0,
				timerNow,
			);
			const primarySpacer = primaryLines.length > 0 ? 1 : 0;
			const maxExpandedDetailLines = showAllToolHistory
				? Math.max(0, maxRenderedLines - rows.length - thoughtLines.length - thoughtSpacer - primaryLines.length - primarySpacer - 3)
				: 0;
			expandedDetailLines = showAllToolHistory
				? formatExpandedDetails(this.theme, snapshot, innerWidth, timerNow, maxExpandedDetailLines)
				: [];
		}

		rows.push(...thoughtLines);
		if (thoughtLines.length > 0) {
			rows.push(renderEmptyRow(innerWidth, this.theme));
		}
		rows.push(...primaryLines);
		if (primaryLines.length > 0) {
			rows.push(renderEmptyRow(innerWidth, this.theme));
		}
		for (const line of expandedDetailLines) {
			const wrapper = line.placeholder
				? placeholderToolRowWrapper(this.theme)
				: line.toolState
					? toolActivityWrapper(this.theme, line.toolState)
					: colorWrapper(this.theme, line.color ?? "dim");
			rows.push(renderRow(innerWidth, line.text, wrapper));
		}
		if (expandedDetailLines.length > 0) {
			rows.push(renderEmptyRow(innerWidth, this.theme));
		}
		rows.push(...thinkingExpandedToolHistoryRows);
		if (thinkingExpandedToolHistoryRows.length > 0) {
			rows.push(renderEmptyRow(innerWidth, this.theme));
		}
		rows.push(renderSplitRow(innerWidth, detail, model.secondaryRight, colorWrapper(this.theme, "dim")));
		rows.push(renderBorder("╰", "╯", innerWidth));
		return rows.slice(0, maxRenderedLines);
	}
}

function chooseTerminalPrimary(snapshot: ActivityBlockSnapshot): string {
	if (snapshot.latestActiveTool) {
		return `${snapshot.latestActiveTool.name} ${snapshot.latestActiveTool.summary}`.trim();
	}
	if (snapshot.latestThinking) {
		return truncateThinkingDisplay(snapshot.latestThinking);
	}
	return "";
}

function chooseRespondingPrimary(snapshot: ActivityBlockSnapshot): string {
	if (snapshot.latestThinking) {
		return `Last thought ${truncateThinkingDisplay(snapshot.latestThinking)}`;
	}
	return "Writing response";
}

function chooseRespondingTertiary(snapshot: ActivityBlockSnapshot): string | undefined {
	if (snapshot.latestThinking) {
		return "Final answer streaming";
	}
	return undefined;
}

function renderThinkingBlockRows(
	theme: Theme,
	markdownTheme: MarkdownTheme,
	snapshot: ActivityBlockSnapshot,
	width: number,
	thinkingExpanded: boolean,
	maxContentLines: number,
	inlineHeader: boolean,
): string[] {
	if (!snapshot.latestThinking) return [];
	if (snapshot.runState !== "running" && !thinkingExpanded) return [];
	const source = getThinkingSource(snapshot);
	const { header, body } = splitThinkingSource(source || snapshot.latestThinking);
	const headerSource = header || snapshot.latestThinking;
	const headerLine = renderMarkdownRows(theme, markdownTheme, headerSource, width, 1, "text")[0] ?? stripPadding(headerSource);
	const headerRow = renderRow(width, stripPadding(headerLine), colorWrapper(theme, "text"));
	if (!thinkingExpanded || maxContentLines <= 1) return inlineHeader ? [] : [headerRow];
	if (!body) return inlineHeader ? [] : [headerRow];
	const markdownLines = renderMarkdownRows(theme, markdownTheme, body, width, maxContentLines - 1, "text");
	if (markdownLines.length === 0) return inlineHeader ? [] : [headerRow];
	return [
		...(inlineHeader ? [] : [headerRow]),
		...markdownLines.map((line) => renderRow(width, stripPadding(line), colorWrapper(theme, "text"))),
	];
}

function getThinkingSource(snapshot: ActivityBlockSnapshot): string {
	const source = snapshot.currentActivity?.kind === "thinking"
		? snapshot.latestThinkingFull || snapshot.currentActivity.summary
		: snapshot.latestThinkingFull || snapshot.latestThinking;
	return truncateThinkingDisplay(source);
}

function shouldInlineThinkingHeader(
	snapshot: ActivityBlockSnapshot,
	thinkingHeader: string,
	_toolHistoryViewMode: ToolHistoryViewMode,
	_thinkingExpanded: boolean,
): boolean {
	return snapshot.runState === "running"
		&& !snapshot.isResponding
		&& Boolean(thinkingHeader.trim());
}

function chooseStatusText(
	theme: Theme,
	markdownTheme: MarkdownTheme,
	snapshot: ActivityBlockSnapshot,
	model: ActivityBlockViewModel,
	thinkingHeader: string,
	width: number,
	inlineThinkingHeader: boolean,
): string {
	if (inlineThinkingHeader) {
		return renderMarkdownRows(theme, markdownTheme, thinkingHeader, width, 1, "text")[0] ?? thinkingHeader;
	}
	return model.status;
}

function decorateBlockTitle(title: string): string {
	const trimmed = title.trimEnd();
	if (!trimmed) return trimmed;
	if (trimmed === "Complete") {
		return "Completed!";
	}
	if (trimmed === "Completed") {
		return "Completed!";
	}
	return trimmed;
}

function normalizeTerminalStatus(status: string, runState: ActivityBlockSnapshot["runState"]): string {
	if (runState === "complete" && status === "Complete") {
		return "Completed";
	}
	return status;
}

function shouldShowSpinner(snapshot: ActivityBlockSnapshot): boolean {
	return snapshot.runState === "running" && !snapshot.isResponding;
}

function getSpinnerFrame(now: number): string {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
	return frames[Math.floor(now / 80) % frames.length] ?? frames[0];
}

function truncateThinkingDisplay(text: string): string {
	if (text.length <= MAX_THINKING_DISPLAY_CHARS) return text;
	return `${text.slice(0, MAX_THINKING_DISPLAY_CHARS - 1)}…`;
}

function normalizeToolHistoryViewMode(mode: ToolHistoryViewMode | boolean | undefined): ToolHistoryViewMode {
	if (mode === true) return "all";
	if (mode === false || mode === undefined) return "latest";
	return mode;
}

export function shouldShowThinkingPanel(toolHistoryViewMode: ToolHistoryViewMode, thinkingExpanded: boolean): boolean {
	return thinkingExpanded || toolHistoryViewMode !== "all";
}

export function isExpandedThinkingShown(snapshot: ActivityBlockSnapshot, thinkingExpanded: boolean): boolean {
	return thinkingExpanded && Boolean(snapshot.latestThinking.trim());
}

function alignRenderClock(now: number): number {
	return Math.floor(now / 1000) * 1000;
}

function splitThinkingSource(text: string): { header: string; body: string } {
	const lines = text.replace(/\r/g, "").split("\n");
	const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
	if (firstContentIndex === -1) return { header: "", body: "" };
	const header = lines[firstContentIndex]?.trim() ?? "";
	const body = lines.slice(firstContentIndex + 1).join("\n").trim();
	return { header, body };
}

function renderPrimaryLines(
	theme: Theme,
	markdownTheme: MarkdownTheme,
	snapshot: ActivityBlockSnapshot,
	model: ActivityBlockViewModel,
	width: number,
	maxLines: number,
	toolHistoryViewMode: ToolHistoryViewMode,
	thinkingExpanded: boolean,
	hasThoughtLines: boolean,
	now: number,
): string[] {
	if (maxLines <= 0) return [];
	if (toolHistoryViewMode === "all" && !thinkingExpanded) return [];
	const stickyToolLimit = getStickyToolLimit(toolHistoryViewMode);
	if (stickyToolLimit > 0) {
		const targetToolRows = Math.min(stickyToolLimit, maxLines);
		const stickyTools = getStickyToolActivities(snapshot, targetToolRows);
		const placeholderCount = getToolHistoryPlaceholderCount(toolHistoryViewMode, stickyTools.length, targetToolRows);
		if (stickyTools.length > 0 || placeholderCount > 0) {
			return [
				...stickyTools.map((tool) => renderToolActivityRow(theme, tool, width, now)),
				...renderPlaceholderToolRows(theme, width, placeholderCount),
			];
		}
	}
	const { header: inlineThinkingHeader } = splitThinkingSource(getThinkingSource(snapshot));
	const hidesReasoningPrimary = snapshot.latestThinking
		&& (model.primary === snapshot.latestThinking || model.primary === `Last thought ${snapshot.latestThinking}`)
		&& (toolHistoryViewMode === "all" || hasThoughtLines || shouldInlineThinkingHeader(snapshot, inlineThinkingHeader, toolHistoryViewMode, thinkingExpanded));
	if (hidesReasoningPrimary) {
		return [];
	}
	if (!model.primary) return [];
	return [renderRow(width, model.primary, colorWrapper(theme, "text"))];
}

function formatExpandedDetails(
	theme: Theme,
	snapshot: ActivityBlockSnapshot,
	width: number,
	now: number,
	maxRows: number,
): ToolRowView[] {
	if (maxRows <= 0) return [];
	const toolLines = formatToolLines(theme, snapshot.tools, width, now);
	return [
		...toolLines,
		...createPlaceholderToolRows(getToolHistoryPlaceholderCount("all", toolLines.length, maxRows)),
	].slice(0, maxRows);
}

function formatToolLines(
	theme: Theme,
	tools: ToolActivity[],
	width: number,
	now: number,
): ToolRowView[] {
	return sortToolsNewestFirst(tools).map((tool) => ({
		text: styleTimedToolActivityLine(theme, tool, width, now),
		color: "text",
		toolState: tool.state,
	}));
}

function getStickyToolLimit(toolHistoryViewMode: ToolHistoryViewMode): number {
	switch (toolHistoryViewMode) {
		case "latest":
			return 1;
		case "recent":
			return RECENT_TOOL_HISTORY_ROWS;
		default:
			return 0;
	}
}

export function getToolHistoryPlaceholderCount(
	toolHistoryViewMode: ToolHistoryViewMode,
	actualRows: number,
	targetRows?: number,
): number {
	const resolvedTargetRows = targetRows ?? getStickyToolLimit(toolHistoryViewMode);
	if (resolvedTargetRows <= 0 || actualRows <= 0) return 0;
	return Math.max(0, resolvedTargetRows - actualRows);
}

function hasThinkingExpandedToolHistory(snapshot: ActivityBlockSnapshot, toolHistoryViewMode: ToolHistoryViewMode): boolean {
	return getThinkingExpandedToolActivities(snapshot, toolHistoryViewMode, THINKING_EXPANDED_TOOL_HISTORY_ROWS).length > 0;
}

function renderThinkingExpandedToolHistoryRows(
	theme: Theme,
	snapshot: ActivityBlockSnapshot,
	width: number,
	now: number,
	toolHistoryViewMode: ToolHistoryViewMode,
	maxRows: number,
): string[] {
	const targetRows = Math.min(THINKING_EXPANDED_TOOL_HISTORY_ROWS, maxRows);
	if (targetRows <= 0) return [];
	const tools = getThinkingExpandedToolActivities(snapshot, toolHistoryViewMode, targetRows);
	if (tools.length === 0) return [];
	return tools.map((tool) => renderToolActivityRow(theme, tool, width, now));
}

function getThinkingExpandedToolActivities(
	snapshot: ActivityBlockSnapshot,
	toolHistoryViewMode: ToolHistoryViewMode,
	limit: number,
): ToolActivity[] {
	if (limit <= 0) return [];
	if (toolHistoryViewMode === "latest") {
		return getStickyToolActivities(snapshot, 1).slice(0, Math.min(1, limit));
	}
	const tools = sortToolsNewestFirst(snapshot.tools).slice(0, limit);
	if (tools.length > 0) return tools;
	return getStickyToolActivities(snapshot, 1).slice(0, Math.min(1, limit));
}

function getStickyToolActivities(snapshot: ActivityBlockSnapshot, limit: number): ToolActivity[] {
	if (limit <= 0) return [];
	const recentTools = sortToolsNewestFirst(snapshot.tools).slice(0, limit);
	if (recentTools.length > 0) return recentTools;
	if (!snapshot.latestToolView) return [];
	return [{
		id: snapshot.latestToolView.toolCallId,
		name: snapshot.latestToolView.name,
		summary: snapshot.latestToolView.summary,
		state: snapshot.latestToolView.state,
		startedAt: snapshot.latestToolView.updatedAt,
		updatedAt: snapshot.latestToolView.updatedAt,
		completedAt: snapshot.latestToolView.state === "running" ? undefined : snapshot.latestToolView.updatedAt,
	}];
}

function renderToolActivityRow(theme: Theme, tool: ToolActivity, width: number, now: number): string {
	return renderRow(width, styleTimedToolActivityLine(theme, tool, width, now), toolActivityWrapper(theme, tool.state));
}

function renderPlaceholderToolRows(theme: Theme, width: number, count: number): string[] {
	return Array.from({ length: count }, () => renderRow(width, "", placeholderToolRowWrapper(theme)));
}

function createPlaceholderToolRows(count: number): ToolRowView[] {
	return Array.from({ length: count }, () => ({ text: "", placeholder: true }));
}

function formatToolDuration(tool: Pick<ToolActivity, "startedAt" | "updatedAt" | "completedAt" | "state">, now: number): string | undefined {
	if (!Number.isFinite(tool.startedAt)) return undefined;
	const stopAt = tool.completedAt ?? (tool.state === "running" ? now : tool.updatedAt);
	const durationMs = Math.max(0, stopAt - tool.startedAt);
	if (durationMs < 10_000) return undefined;
	return formatDuration(durationMs);
}

function styleTimedToolActivityLine(theme: Theme, tool: ToolActivity, width: number, now: number): string {
	const duration = formatToolDuration(tool, now);
	const suffix = duration ? theme.fg("dim", ` · ${duration}`) : "";
	const suffixWidth = duration ? visibleWidth(` · ${duration}`) : 0;
	const baseWidth = Math.max(1, width - suffixWidth);
	const baseLine = styleToolActivityLine(
		theme,
		tool.state,
		tool.name,
		normalizeLine(tool.summary, Math.max(1, baseWidth - 6)),
	);
	const truncatedBaseLine = truncateToWidth(baseLine, baseWidth, "…");
	return `${truncatedBaseLine}${suffix}`;
}

function renderMarkdownRows(
	theme: Theme,
	markdownTheme: MarkdownTheme,
	text: string,
	width: number,
	maxLines: number,
	color: ThemeColor,
): string[] {
	if (!text.trim() || maxLines <= 0) return [];
	const markdown = new Markdown(text, 0, 0, markdownTheme, {
		color: (value) => theme.fg(color, value),
	});
	return markdown.render(width).map((line) => stripPadding(line)).slice(0, maxLines);
}

export function sortToolsNewestFirst(tools: readonly ToolActivity[]): ToolActivity[] {
	// Compact and expanded views must share the exact same tool ordering.
	return [...tools].sort(compareToolsNewestFirst);
}

function compareToolsNewestFirst(left: ToolActivity, right: ToolActivity): number {
	if (left.startedAt !== right.startedAt) return right.startedAt - left.startedAt;
	return right.id.localeCompare(left.id);
}

function getToolPrefix(state: ToolState | undefined): string {
	if (state === "running") return "▶";
	if (state === "error") return "!";
	return "✓";
}

function getToolColor(state: ToolState | undefined): ThemeColor {
	if (state === "running") return "warning";
	if (state === "error") return "error";
	return "success";
}

function styleToolActivityLine(theme: Theme, state: ToolState | undefined, toolName: string, summary: string): string {
	const prefix = theme.fg(getToolColor(state), getToolPrefix(state));
	const styledToolName = styleToolName(theme, toolName);
	const styledSummary = styleToolSummary(theme, toolName, summary);
	return `${prefix} ${styledToolName}${styledSummary ? ` ${styledSummary}` : ""}`.trim();
}

function styleToolName(theme: Theme, toolName: string): string {
	switch (toolName) {
		case "read":
			return theme.fg("accent", theme.bold("read"));
		case "write":
			return theme.fg("success", theme.bold("write"));
		case "edit":
			return theme.fg("warning", theme.bold("edit"));
		case "bash":
			return theme.fg("bashMode", theme.bold("$"));
		case "grep":
		case "find":
		case "multi_grep":
		case "run_skill_script":
			return theme.fg("toolTitle", theme.bold(getToolDisplayName(toolName)));
		default:
			return theme.fg("text", theme.bold(toolName));
	}
}

function getToolDisplayName(toolName: string): string {
	if (toolName === "run_skill_script") return "run-skill";
	return toolName;
}

function styleToolSummary(theme: Theme, toolName: string, summary: string): string {
	if (!summary) return "";
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return theme.fg("accent", summary);
		case "bash":
			return summary.startsWith("$") ? theme.fg("toolTitle", summary.slice(1).trimStart()) : theme.fg("toolTitle", summary);
		case "grep":
		case "find":
		case "multi_grep":
		case "run_skill_script":
			return theme.fg("accent", summary);
		default:
			return theme.fg("text", summary);
	}
}

function normalizeLine(text: string, maxLength: number): string {
	return truncateToWidth(text, maxLength, "…");
}

function joinParts(parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join(" · ");
}

function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const remainderSeconds = totalSeconds % 60;
	return `${minutes}m ${remainderSeconds}s`;
}

function formatToolCallCounts(totalTools: number, failedTools: number): string {
	const failedSuffix = failedTools > 0 ? ` (${failedTools} failed)` : "";
	return `${totalTools} tool calls${failedSuffix}`;
}

function formatTokenCount(tokenCount: number | undefined): string | undefined {
	if (tokenCount === undefined || !Number.isFinite(tokenCount)) return undefined;
	if (tokenCount < 1000) return "< 1K tokens";
	return `${Math.floor(tokenCount / 1000)}K tokens`;
}

function formatCompactionCount(compactionCount: number): string | undefined {
	if (!Number.isFinite(compactionCount) || compactionCount <= 1) return undefined;
	return `${compactionCount} compactions`;
}


function renderBorder(left: string, right: string, innerWidth: number): string {
	return applyPersistentColor(`${left}${"─".repeat(innerWidth)}${right}`, CATPPUCCIN_PINK_ANSI, RESET_FG_ANSI);
}

function renderRow(innerWidth: number, text: string, wrapper: [string, string]): string {
	const fitted = fitToWidth(text, innerWidth);
	const content = applyPersistentColor(fitted, wrapper[0], wrapper[1]);
	const borderLeft = applyPersistentColor("│", CATPPUCCIN_PINK_ANSI, RESET_FG_ANSI);
	const borderRight = applyPersistentColor("│", CATPPUCCIN_PINK_ANSI, RESET_FG_ANSI);
	return `${borderLeft}${content}${borderRight}`;
}

function renderEmptyRow(innerWidth: number, theme: Theme): string {
	return renderRow(innerWidth, "", colorWrapper(theme, "text"));
}

function renderSplitRow(innerWidth: number, left: string, right: string | undefined, wrapper: [string, string]): string {
	if (!right) return renderRow(innerWidth, left, wrapper);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= innerWidth) {
		return renderRow(innerWidth, right, wrapper);
	}
	const leftWidth = Math.max(0, innerWidth - rightWidth - 1);
	if (leftWidth <= 0) {
		return renderRow(innerWidth, right, wrapper);
	}
	const fittedLeft = fitToWidth(left, leftWidth);
	return renderRow(innerWidth, `${fittedLeft} ${right}`, wrapper);
}

function fitToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	const visible = visibleWidth(truncated);
	if (visible >= width) return truncated;
	return `${truncated}${" ".repeat(width - visible)}`;
}

function stripPadding(text: string): string {
	return text.replace(/\s+$/u, "");
}

function capitalize(text: string): string {
	if (!text) return text;
	return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

function colorWrapper(theme: Theme, color: ThemeColor): [string, string] {
	return extractStyleWrapper((text) => theme.fg(color, text));
}

function bgWrapper(theme: Theme, color: ThemeBgColor): [string, string] {
	return extractStyleWrapper((text) => theme.bg(color, text));
}

function statusRowWrapper(theme: Theme): [string, string] {
	return extractStyleWrapper((text) => theme.fg("text", theme.bold(text)));
}

function toolActivityWrapper(theme: Theme, state: ToolState | undefined): [string, string] {
	switch (state) {
		case "running":
			return bgWrapper(theme, "toolPendingBg");
		case "error":
			return bgWrapper(theme, "toolErrorBg");
		default:
			return bgWrapper(theme, "toolSuccessBg");
	}
}

function placeholderToolRowWrapper(theme: Theme): [string, string] {
	return bgWrapper(theme, "selectedBg");
}

function extractStyleWrapper(styleFn: (text: string) => string): [string, string] {
	const sentinel = "\u0000";
	const styled = styleFn(sentinel);
	const index = styled.indexOf(sentinel);
	if (index === -1) return ["", ""];
	return [styled.slice(0, index), styled.slice(index + sentinel.length)];
}

function applyPersistentColor(text: string, prefixOrWrapper: string | [string, string], suffix?: string): string {
	const [prefix, resolvedSuffix] = Array.isArray(prefixOrWrapper)
		? prefixOrWrapper
		: [prefixOrWrapper, suffix ?? RESET_FG_ANSI];
	if (!prefix && !resolvedSuffix) return text;
	const colorSafeText = text.replaceAll(ANSI_RESET_WITH_FG_RE, (match) => `${match}${prefix}`);
	return `${prefix}${colorSafeText}${resolvedSuffix}`;
}
