import type {
	AgentEndEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { summarizeFffindTool, summarizeFfgrepTool } from "./search-tool-summary.ts";

const MAX_FINAL_THINKING_SUMMARIES = 4;
const MAX_TOOL_DETAIL_LENGTH = 2400;
const MAX_TOOL_DETAIL_LINES = 16;

export type RunState = "idle" | "running" | "complete" | "aborted" | "error";
export type ToolState = "running" | "complete" | "error";
export type ActivityKind = "thinking" | "tool";

export interface ToolDetailView {
	toolCallId: string;
	name: string;
	summary: string;
	state: ToolState;
	isError: boolean;
	updatedAt: number;
	inputPreview?: string;
	outputPreview?: string;
	diffPreview?: string;
}

export interface ToolActivity {
	id: string;
	name: string;
	summary: string;
	state: ToolState;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
}

export interface ActivitySummary {
	kind: ActivityKind;
	summary: string;
	timestamp: number;
	toolCallId?: string;
	toolName?: string;
	toolState?: ToolState;
}

export interface ActivityBlockState {
	runState: RunState;
	startedAt?: number;
	endedAt?: number;
	finalLabel?: string;
	latestThinking: string;
	latestThinkingFull: string;
	thinkingSummaries: string[];
	lastThinkingAt?: number;
	lastToolSummary?: string;
	lastToolUpdateAt?: number;
	respondingStartedAt?: number;
	turnTokenBaseline?: number;
	latestTokenCount?: number;
	currentActivity?: ActivitySummary;
	previousActivity?: ActivitySummary;
	isResponding: boolean;
	tools: Map<string, ToolActivity>;
	totalTools: number;
	activeTools: number;
	completedTools: number;
	failedTools: number;
	latestActiveToolId?: string;
	latestToolView?: ToolDetailView;
}

export interface ActivityBlockSnapshot {
	runState: RunState;
	startedAt?: number;
	endedAt?: number;
	finalLabel?: string;
	latestThinking: string;
	latestThinkingFull: string;
	thinkingSummaries: string[];
	lastThinkingAt?: number;
	lastToolSummary?: string;
	lastToolUpdateAt?: number;
	respondingStartedAt?: number;
	turnTokenBaseline?: number;
	latestTokenCount?: number;
	currentActivity?: ActivitySummary;
	previousActivity?: ActivitySummary;
	isResponding: boolean;
	tools: ToolActivity[];
	totalTools: number;
	activeTools: number;
	completedTools: number;
	failedTools: number;
	latestActiveTool?: ToolActivity;
	latestToolView?: ToolDetailView;
}

export interface PersistedActivityBlockState {
	turnId: string;
	snapshot: ActivityBlockSnapshot;
}

type ToolCallDraft = {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
};

export function createInitialActivityBlockState(): ActivityBlockState {
	return {
		runState: "idle",
		latestThinking: "",
		latestThinkingFull: "",
		thinkingSummaries: [],
		isResponding: false,
		turnTokenBaseline: undefined,
		latestTokenCount: undefined,
		currentActivity: undefined,
		previousActivity: undefined,
		tools: new Map<string, ToolActivity>(),
		totalTools: 0,
		activeTools: 0,
		completedTools: 0,
		failedTools: 0,
		latestToolView: undefined,
	};
}

export function resetActivityBlockState(state: ActivityBlockState): void {
	const next = createInitialActivityBlockState();
	state.runState = next.runState;
	state.startedAt = next.startedAt;
	state.endedAt = next.endedAt;
	state.finalLabel = next.finalLabel;
	state.latestThinking = next.latestThinking;
	state.latestThinkingFull = next.latestThinkingFull;
	state.thinkingSummaries = next.thinkingSummaries;
	state.lastThinkingAt = next.lastThinkingAt;
	state.lastToolSummary = next.lastToolSummary;
	state.lastToolUpdateAt = next.lastToolUpdateAt;
	state.respondingStartedAt = next.respondingStartedAt;
	state.turnTokenBaseline = next.turnTokenBaseline;
	state.latestTokenCount = next.latestTokenCount;
	state.isResponding = next.isResponding;
	state.currentActivity = next.currentActivity;
	state.previousActivity = next.previousActivity;
	state.tools = next.tools;
	state.totalTools = next.totalTools;
	state.activeTools = next.activeTools;
	state.completedTools = next.completedTools;
	state.failedTools = next.failedTools;
	state.latestActiveToolId = next.latestActiveToolId;
	state.latestToolView = next.latestToolView;
}

export function startRun(state: ActivityBlockState, now: number): void {
	resetActivityBlockState(state);
	state.runState = "running";
	state.startedAt = now;
}

export function startTurn(_state: ActivityBlockState): void {
	// Token counts stay block-scoped across internal continuation turns.
}

export function applyMessageUpdate(state: ActivityBlockState, event: MessageUpdateEvent, now: number): void {
	if (state.runState === "idle") {
		startRun(state, now);
	}
	updateLatestTokenCount(state, event.message);
	if (isTextResponseEvent(event)) {
		if (!state.isResponding) {
			state.respondingStartedAt = now;
		}
		state.isResponding = true;
		return;
	}
	const toolDraft = extractToolCallDraft(event);
	if (toolDraft) {
		applyToolDraft(state, toolDraft, now);
		return;
	}
	const excerpt = extractLatestThinkingExcerpt(event);
	const fullThinking = extractLatestThinkingContent(event);
	if (!excerpt || !fullThinking) return;
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	state.latestThinking = excerpt;
	state.latestThinkingFull = fullThinking;
	state.thinkingSummaries = [excerpt];
	state.lastThinkingAt = now;
	recordActivity(state, { kind: "thinking", summary: excerpt, timestamp: now });
}

function applyToolDraft(state: ActivityBlockState, draft: ToolCallDraft, now: number): void {
	if (state.runState === "idle") {
		startRun(state, now);
	}
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	const existing = state.tools.get(draft.toolCallId);
	const summary = summarizeTool(draft.toolName, draft.args);
	if (existing) {
		existing.name = draft.toolName;
		existing.summary = summary;
		if (existing.state === "running") {
			existing.completedAt = undefined;
		}
		existing.updatedAt = now;
	} else {
		state.tools.set(draft.toolCallId, {
			id: draft.toolCallId,
			name: draft.toolName,
			summary,
			state: "running",
			startedAt: now,
			updatedAt: now,
		});
		state.totalTools += 1;
	}
	const latest = state.tools.get(draft.toolCallId);
	state.lastToolSummary = summary;
	state.lastToolUpdateAt = now;
	state.latestToolView = createToolDetailView({
		toolCallId: draft.toolCallId,
		toolName: draft.toolName,
		args: draft.args,
		state: latest?.state ?? "running",
		isError: latest?.state === "error",
		now,
		previous: state.latestToolView,
	});
	recordActivity(state, {
		kind: "tool",
		summary,
		timestamp: now,
		toolCallId: draft.toolCallId,
		toolName: draft.toolName,
		toolState: latest?.state ?? "running",
	});
	recomputeToolCounts(state, draft.toolCallId);
}

export function applyToolStart(state: ActivityBlockState, event: ToolExecutionStartEvent, now: number): void {
	if (state.runState === "idle") {
		startRun(state, now);
	}
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	const existing = state.tools.get(event.toolCallId);
	const summary = summarizeTool(event.toolName, event.args);
	if (existing) {
		existing.name = event.toolName;
		existing.summary = summary;
		existing.state = "running";
		existing.updatedAt = now;
		existing.completedAt = undefined;
	} else {
		state.tools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			summary,
			state: "running",
			startedAt: now,
			updatedAt: now,
		});
		state.totalTools += 1;
	}
	state.lastToolSummary = summary;
	state.lastToolUpdateAt = now;
	state.latestToolView = createToolDetailView({
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: event.args,
		state: "running",
		isError: false,
		now,
		previous: state.latestToolView,
	});
	recordActivity(state, {
		kind: "tool",
		summary,
		timestamp: now,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		toolState: "running",
	});
	recomputeToolCounts(state, event.toolCallId);
}

export function applyToolUpdate(state: ActivityBlockState, event: ToolExecutionUpdateEvent, now: number): void {
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	const existing = state.tools.get(event.toolCallId);
	if (!existing) {
		applyToolStart(
			state,
			{ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
			now,
		);
	}
	const summary = summarizeTool(event.toolName, event.args);
	const latest = state.tools.get(event.toolCallId);
	if (latest) {
		latest.summary = summary;
		latest.updatedAt = now;
	}
	state.lastToolSummary = summary;
	state.lastToolUpdateAt = now;
	state.latestToolView = createToolDetailView({
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		args: event.args,
		partialResult: event.partialResult,
		state: latest?.state ?? "running",
		isError: false,
		now,
		previous: state.latestToolView,
	});
	recordActivity(state, {
		kind: "tool",
		summary,
		timestamp: now,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		toolState: latest?.state ?? "running",
	});
	recomputeToolCounts(state, event.toolCallId);
}

export function applyToolEnd(state: ActivityBlockState, event: ToolExecutionEndEvent, now: number): void {
	if (state.runState === "idle") {
		startRun(state, now);
	}
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	const existing = state.tools.get(event.toolCallId);
	if (!existing) {
		state.tools.set(event.toolCallId, {
			id: event.toolCallId,
			name: event.toolName,
			summary: summarizeTool(event.toolName, undefined),
			state: event.isError ? "error" : "complete",
			startedAt: now,
			updatedAt: now,
			completedAt: now,
		});
		state.totalTools += 1;
	} else {
		existing.state = event.isError ? "error" : "complete";
		existing.updatedAt = now;
		existing.completedAt = now;
	}
	const latest = state.tools.get(event.toolCallId);
	if (latest) {
		state.lastToolSummary = latest.summary;
		state.lastToolUpdateAt = now;
		state.latestToolView = createToolDetailView({
			toolCallId: event.toolCallId,
			toolName: latest.name,
			state: latest.state,
			isError: event.isError,
			result: event.result,
			now,
			previous: state.latestToolView,
			summaryOverride: latest.summary,
		});
		recordActivity(state, {
			kind: "tool",
			summary: latest.summary,
			timestamp: now,
			toolCallId: event.toolCallId,
			toolName: latest.name,
			toolState: latest.state,
		});
	}
	recomputeToolCounts(state);
}

export function finishRun(state: ActivityBlockState, event: AgentEndEvent | TurnEndEvent, now: number): void {
	state.endedAt = now;
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	applyTerminalToolResults(state, event, now);
	const danglingToolCount = failDanglingTools(state, now);
	const finalAssistant = getFinalAssistantMessage(event);
	updateLatestTokenCount(state, finalAssistant);
	const terminal = deriveFinalState(finalAssistant, danglingToolCount);
	state.runState = terminal.runState;
	state.finalLabel = terminal.finalLabel;
	const finalThinking = finalAssistant ? extractThinkingSummariesFromAssistantMessage(finalAssistant) : [];
	if (finalThinking.length > 0) {
		state.thinkingSummaries = finalThinking;
		state.latestThinking = finalThinking[0] ?? state.latestThinking;
		state.latestThinkingFull = extractLatestThinkingFromAssistantMessage(finalAssistant) ?? state.latestThinkingFull;
		if (state.currentActivity?.kind !== "tool") {
			recordActivity(state, { kind: "thinking", summary: state.latestThinking, timestamp: now });
		}
	} else if (state.latestThinking) {
		state.thinkingSummaries = [state.latestThinking];
	}
	recomputeToolCounts(state);
}

export function interruptRun(state: ActivityBlockState, now: number, finalLabel = "Interrupted by steering"): void {
	state.endedAt = now;
	state.isResponding = false;
	state.respondingStartedAt = undefined;
	state.runState = "complete";
	state.finalLabel = finalLabel;
	if (state.latestThinking) {
		state.thinkingSummaries = [state.latestThinking];
	}
	failDanglingTools(state, now);
	recomputeToolCounts(state);
}

export function setTurnTokenBaseline(state: ActivityBlockState, tokenCount: number | null | undefined): void {
	if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) return;
	state.turnTokenBaseline = tokenCount;
}

export function syncLatestTokenCount(
	state: ActivityBlockState,
	tokenCount: number | null | undefined,
	source: "usage" | "context" = "usage",
): void {
	if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) return;
	if (source === "context") {
		if (state.turnTokenBaseline === undefined) {
			state.turnTokenBaseline = tokenCount;
			return;
		}
		const turnScopedTokens = Math.max(0, tokenCount - state.turnTokenBaseline);
		if (turnScopedTokens <= 0) return;
		state.latestTokenCount = Math.max(state.latestTokenCount ?? 0, turnScopedTokens);
		return;
	}
	if (state.turnTokenBaseline !== undefined) {
		const turnScopedTokens = Math.max(0, tokenCount - state.turnTokenBaseline);
		if (turnScopedTokens <= 0) return;
		state.latestTokenCount = Math.max(state.latestTokenCount ?? 0, turnScopedTokens);
		return;
	}
	state.latestTokenCount = Math.max(state.latestTokenCount ?? 0, tokenCount);
}

export function getActivityBlockSnapshot(state: ActivityBlockState): ActivityBlockSnapshot {
	const tools = Array.from(state.tools.values()).sort((left, right) => left.startedAt - right.startedAt);
	const latestActiveTool = state.latestActiveToolId ? state.tools.get(state.latestActiveToolId) : undefined;
	return {
		runState: state.runState,
		startedAt: state.startedAt,
		endedAt: state.endedAt,
		finalLabel: state.finalLabel,
		latestThinking: state.latestThinking,
		latestThinkingFull: state.latestThinkingFull,
		thinkingSummaries: [...state.thinkingSummaries],
		lastThinkingAt: state.lastThinkingAt,
		lastToolSummary: state.lastToolSummary,
		lastToolUpdateAt: state.lastToolUpdateAt,
		respondingStartedAt: state.respondingStartedAt,
		turnTokenBaseline: state.turnTokenBaseline,
		latestTokenCount: state.latestTokenCount,
		currentActivity: state.currentActivity ? { ...state.currentActivity } : undefined,
		previousActivity: state.previousActivity ? { ...state.previousActivity } : undefined,
		isResponding: state.isResponding,
		tools,
		totalTools: state.totalTools,
		activeTools: state.activeTools,
		completedTools: state.completedTools,
		failedTools: state.failedTools,
		latestActiveTool,
		latestToolView: state.latestToolView ? { ...state.latestToolView } : undefined,
	};
}

export function extractLatestThinkingExcerpt(event: MessageUpdateEvent): string {
	const latestThinking = getLatestThinkingBlock(event.message.content);
	return latestThinking ? normalizeExcerpt(latestThinking.thinking) : "";
}

export function extractFinalThinkingSummaries(event: AgentEndEvent, maxItems = MAX_FINAL_THINKING_SUMMARIES): string[] {
	const finalAssistant = getFinalAssistantMessage(event);
	return finalAssistant ? extractThinkingSummariesFromAssistantMessage(finalAssistant, maxItems) : [];
}

export function normalizeExcerpt(text: string, maxLength = 96): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function summarizeTool(toolName: string, args: unknown): string {
	if (toolName === "bash") {
		const command = getStringProperty(args, ["command"]);
		return command ? normalizeExcerpt(`$ ${command}`, 72) : "$ …";
	}
	if (toolName === "read") {
		const path = getStringProperty(args, ["path", "file_path"]);
		const offset = getNumberProperty(args, ["offset"]);
		const limit = getNumberProperty(args, ["limit"]);
		let suffix = "";
		if (offset !== undefined || limit !== undefined) {
			const start = offset ?? 1;
			const end = limit !== undefined ? start + limit - 1 : undefined;
			suffix = end !== undefined ? `:${start}-${end}` : `:${start}`;
		}
		return path ? normalizeExcerpt(`${path}${suffix}`, 72) : "…";
	}
	if (toolName === "write" || toolName === "edit") {
		const path = getStringProperty(args, ["path", "file_path"]);
		return path ? normalizeExcerpt(path, 72) : "…";
	}
	if (toolName === "run_skill_script") {
		const script = getStringProperty(args, ["script"]);
		const skill = getStringProperty(args, ["skill"]);
		const interpreter = getStringProperty(args, ["interpreter"]);
		const timeoutSeconds = getNumberProperty(args, ["timeoutSeconds"]);
		const argCount = getStringArrayProperty(args, ["args"]).length;
		let summary = script ?? "…";
		if (skill) summary += ` in ${skill}`;
		if (interpreter) summary += ` via ${interpreter}`;
		const modifiers = [
			timeoutSeconds !== undefined ? `timeout ${timeoutSeconds}s` : undefined,
			argCount > 0 ? `${argCount} arg${argCount === 1 ? "" : "s"}` : undefined,
		].filter((value): value is string => Boolean(value));
		if (modifiers.length > 0) summary += ` (${modifiers.join(", ")})`;
		return normalizeExcerpt(summary, 72);
	}
	if (toolName === "fffind") {
		return summarizeFffindTool(args);
	}
	if (toolName === "ffgrep") {
		return summarizeFfgrepTool(args);
	}
	if (toolName === "find") {
		const pattern = getStringProperty(args, ["pattern"]);
		const path = getStringProperty(args, ["path", "file_path"]) ?? ".";
		const limit = getNumberProperty(args, ["limit"]);
		let summary = pattern ?? "…";
		summary += ` in ${path}`;
		if (limit !== undefined) summary += ` (limit ${limit})`;
		return normalizeExcerpt(summary, 72);
	}
	if (toolName === "grep") {
		const pattern = getStringProperty(args, ["pattern"]);
		const path = getStringProperty(args, ["path", "file_path"]) ?? ".";
		const glob = getStringProperty(args, ["glob"]);
		let summary = pattern ? `/${pattern}/` : "…";
		summary += ` in ${path}`;
		if (glob) summary += ` (${glob})`;
		return normalizeExcerpt(summary, 72);
	}
	if (toolName === "multi_grep") {
		const patterns = getStringArrayProperty(args, ["patterns", "queries", "terms", "needles"]);
		const pattern = getStringProperty(args, ["pattern", "query", "term", "needle"]);
		const path = getStringProperty(args, ["path", "file_path"]) ?? ".";
		const glob = getStringProperty(args, ["glob"]);
		const formattedPatterns = patterns.length > 0
			? patterns.map((value) => `/${value}/`).join(" | ")
			: pattern ? `/${pattern}/` : "…";
		let summary = `${formattedPatterns} in ${path}`;
		if (glob) summary += ` (${glob})`;
		return normalizeExcerpt(summary, 72);
	}
	const summary = getStringProperty(args, ["path", "file_path", "command", "url", "name"]);
	return summary ? normalizeExcerpt(summary, 72) : normalizeExcerpt(toolName, 72);
}

function updateLatestTokenCount(
	state: ActivityBlockState,
	message:
		| Extract<NonNullable<ReturnType<typeof getFinalAssistantMessage>>, { role: "assistant" }>
		| MessageUpdateEvent["message"]
		| undefined,
): void {
	const usage = message && "usage" in message ? message.usage : undefined;
	syncLatestTokenCount(state, usage?.totalTokens, "usage");
}

function recordActivity(state: ActivityBlockState, next: ActivitySummary): void {
	const current = state.currentActivity;
	if (!current) {
		state.currentActivity = { ...next };
		return;
	}
	if (current.kind === next.kind) {
		if (current.kind === "thinking") {
			state.currentActivity = { ...next };
			return;
		}
		if (current.toolCallId && current.toolCallId === next.toolCallId) {
			state.currentActivity = { ...next };
			return;
		}
	}
	state.previousActivity = { ...current };
	state.currentActivity = { ...next };
}

function isTextResponseEvent(event: MessageUpdateEvent): boolean {
	return event.assistantMessageEvent.type === "text_start"
		|| event.assistantMessageEvent.type === "text_delta"
		|| event.assistantMessageEvent.type === "text_end";
}

function extractToolCallDraft(event: MessageUpdateEvent): ToolCallDraft | undefined {
	const contentIndex = getToolCallContentIndex(event);
	if (contentIndex === undefined) return undefined;
	const content = event.message.content[contentIndex];
	if (!content || content.type !== "toolCall") return undefined;
	const toolCallId = getStringProperty(content, ["id"]);
	const toolName = getStringProperty(content, ["name"]);
	if (!toolCallId || !toolName) return undefined;
	return {
		toolCallId,
		toolName,
		args: getObjectProperty(content, ["arguments"]) ?? {},
	};
}

function getToolCallContentIndex(event: MessageUpdateEvent): number | undefined {
	switch (event.assistantMessageEvent.type) {
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return event.assistantMessageEvent.contentIndex;
		default:
			return undefined;
	}
}

function getFinalAssistantMessage(event: AgentEndEvent | TurnEndEvent) {
	if ("message" in event) {
		return event.message.role === "assistant" ? event.message : undefined;
	}
	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const message = event.messages[index];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function applyTerminalToolResults(state: ActivityBlockState, event: AgentEndEvent | TurnEndEvent, now: number): void {
	const toolResults = "toolResults" in event ? event.toolResults : event.messages.filter(isToolResultLikeMessage);
	for (const toolResult of toolResults) {
		const toolCallId = getStringProperty(toolResult, ["toolCallId"]);
		const toolName = getStringProperty(toolResult, ["toolName"]);
		if (!toolCallId || !toolName) continue;
		const existing = state.tools.get(toolCallId);
		if (existing && existing.state !== "running") continue;
		applyToolEnd(
			state,
			{
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: toolResult,
				isError: getBooleanProperty(toolResult, ["isError"]) ?? false,
			},
			now,
		);
	}
}

function isToolResultLikeMessage(message: unknown): message is Record<string, unknown> {
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "toolResult");
}

function failDanglingTools(state: ActivityBlockState, now: number): number {
	let danglingToolCount = 0;
	for (const tool of state.tools.values()) {
		if (tool.state !== "running") continue;
		tool.state = "error";
		tool.updatedAt = now;
		tool.completedAt = now;
		danglingToolCount += 1;
	}
	if (danglingToolCount === 0) return 0;

	state.lastToolUpdateAt = now;
	if (state.latestToolView?.state === "running") {
		state.latestToolView = {
			...state.latestToolView,
			state: "error",
			isError: true,
			updatedAt: now,
		};
	}
	if (state.currentActivity?.kind === "tool" && state.currentActivity.toolState === "running") {
		state.currentActivity = {
			...state.currentActivity,
			toolState: "error",
			timestamp: now,
		};
	}
	return danglingToolCount;
}

function extractThinkingSummariesFromAssistantMessage(
	message: Extract<NonNullable<ReturnType<typeof getFinalAssistantMessage>>, { role: "assistant" }>,
	maxItems = MAX_FINAL_THINKING_SUMMARIES,
): string[] {
	const summaries = message.content
		.filter((content): content is Extract<(typeof message.content)[number], { type: "thinking" }> => content.type === "thinking")
		.map((content) => normalizeExcerpt(content.thinking, 120))
		.filter(Boolean);
	return Array.from(new Set(summaries)).slice(0, maxItems);
}

function extractLatestThinkingFromAssistantMessage(
	message: Extract<NonNullable<ReturnType<typeof getFinalAssistantMessage>>, { role: "assistant" }>,
): string | undefined {
	const latestThinking = getLatestThinkingBlock(message.content);
	return latestThinking?.thinking.trim() || undefined;
}

function deriveFinalState(
	message: Extract<NonNullable<ReturnType<typeof getFinalAssistantMessage>>, { role: "assistant" }> | undefined,
	danglingToolCount = 0,
): { runState: RunState; finalLabel: string } {
	if (!message) {
		if (danglingToolCount > 0) {
			return { runState: "error", finalLabel: formatDanglingToolFinalLabel(danglingToolCount) };
		}
		return { runState: "complete", finalLabel: "Completed" };
	}
	if (message.stopReason === "aborted") {
		return { runState: "aborted", finalLabel: "Aborted" };
	}
	if (message.stopReason === "error") {
		return { runState: "error", finalLabel: message.errorMessage ? `Error: ${message.errorMessage}` : "Error" };
	}
	if (danglingToolCount > 0) {
		return { runState: "error", finalLabel: formatDanglingToolFinalLabel(danglingToolCount) };
	}
	return { runState: "complete", finalLabel: "Completed" };
}

function formatDanglingToolFinalLabel(danglingToolCount: number): string {
	return danglingToolCount === 1
		? "Error: active command cancelled"
		: `Error: ${danglingToolCount} active commands cancelled`;
}

function recomputeToolCounts(state: ActivityBlockState, latestActiveToolId = state.latestActiveToolId): void {
	let activeTools = 0;
	let completedTools = 0;
	let failedTools = 0;
	let latestActive: ToolActivity | undefined;
	for (const tool of state.tools.values()) {
		if (tool.state === "running") {
			activeTools += 1;
			if (!latestActive || tool.updatedAt >= latestActive.updatedAt) {
				latestActive = tool;
			}
		} else if (tool.state === "error") {
			failedTools += 1;
		} else {
			completedTools += 1;
		}
	}
	state.activeTools = activeTools;
	state.completedTools = completedTools;
	state.failedTools = failedTools;
	state.latestActiveToolId = latestActive?.id ?? latestActiveToolId;
	if (state.latestActiveToolId && !state.tools.has(state.latestActiveToolId)) {
		state.latestActiveToolId = undefined;
	}
	if (!latestActive) {
		state.latestActiveToolId = undefined;
	}
}

function createToolDetailView(options: {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
	state: ToolState;
	isError: boolean;
	now: number;
	previous?: ToolDetailView;
	summaryOverride?: string;
}): ToolDetailView {
	const inputPreview = clipMultiline(extractToolInputPreview(options.toolName, options.args));
	const resultPreview = extractToolResultPreview(options.result ?? options.partialResult);
	const previous = options.previous?.toolCallId === options.toolCallId ? options.previous : undefined;
	return {
		toolCallId: options.toolCallId,
		name: options.toolName,
		summary: options.summaryOverride ?? summarizeTool(options.toolName, options.args),
		state: options.state,
		isError: options.isError,
		updatedAt: options.now,
		inputPreview: inputPreview || previous?.inputPreview,
		outputPreview: clipMultiline(resultPreview.outputPreview) || previous?.outputPreview,
		diffPreview: clipMultiline(resultPreview.diffPreview) || previous?.diffPreview,
	};
}

function extractToolInputPreview(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	if (toolName === "write") {
		return getStringProperty(args, ["content"]);
	}
	if (toolName === "edit") {
		const oldText = getStringProperty(args, ["oldText"]);
		const newText = getStringProperty(args, ["newText"]);
		if (oldText || newText) {
			return [oldText ? `- ${oldText}` : undefined, newText ? `+ ${newText}` : undefined].filter(Boolean).join("\n");
		}
	}
	return undefined;
}

function extractToolResultPreview(value: unknown): { outputPreview?: string; diffPreview?: string } {
	if (typeof value === "string") {
		return { outputPreview: value };
	}
	if (!value || typeof value !== "object") {
		return {};
	}
	const details = getObjectProperty(value, ["details"]);
	const diffPreview = getStringProperty(details, ["diff"]);
	const content = getArrayProperty(value, ["content"]);
	if (!content) {
		return { diffPreview };
	}
	const textBlocks = content
		.map((item) => {
			if (!item || typeof item !== "object") return undefined;
			if ((item as { type?: unknown }).type !== "text") return undefined;
			const text = (item as { text?: unknown }).text;
			return typeof text === "string" ? text : undefined;
		})
		.filter((text): text is string => Boolean(text));
	return {
		diffPreview,
		outputPreview: textBlocks.length > 0 ? textBlocks.join("\n") : undefined,
	};
}

function clipMultiline(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\r/g, "").trim();
	if (!normalized) return undefined;
	const lines = normalized.split("\n").slice(0, MAX_TOOL_DETAIL_LINES);
	const clipped = lines.join("\n");
	if (clipped.length <= MAX_TOOL_DETAIL_LENGTH && lines.length === normalized.split("\n").length) {
		return clipped;
	}
	return `${clipped.slice(0, MAX_TOOL_DETAIL_LENGTH).trimEnd()}\n…`;
}

function extractLatestThinkingContent(event: MessageUpdateEvent): string {
	const latestThinking = getLatestThinkingBlock(event.message.content);
	return latestThinking?.thinking.trim() ?? "";
}

function getLatestThinkingBlock(content: Array<{ type: string } & Record<string, unknown>>) {
	for (let index = content.length - 1; index >= 0; index -= 1) {
		const item = content[index];
		if (item.type !== "thinking") continue;
		const thinking = (item as { thinking?: unknown }).thinking;
		if (typeof thinking === "string" && thinking.trim()) {
			return { thinking };
		}
	}
	return undefined;
}

function getStringProperty(value: unknown, keys: string[]): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return undefined;
}

function getNumberProperty(value: unknown, keys: string[]): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function getBooleanProperty(value: unknown, keys: string[]): boolean | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (typeof candidate === "boolean") {
			return candidate;
		}
	}
	return undefined;
}

function getObjectProperty(value: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
			return candidate as Record<string, unknown>;
		}
	}
	return undefined;
}

function getArrayProperty(value: unknown, keys: string[]): unknown[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of keys) {
		const candidate = (value as Record<string, unknown>)[key];
		if (Array.isArray(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function getStringArrayProperty(value: unknown, keys: string[]): string[] {
	const items = getArrayProperty(value, keys);
	if (!items) return [];
	return items
		.map((item) => typeof item === "string" ? item.trim() : "")
		.filter((item) => item.length > 0);
}
