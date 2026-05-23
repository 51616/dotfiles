import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	applyToolEnd,
	applyToolStart,
	createInitialActivityBlockState,
	finishRun,
	getActivityBlockSnapshot,
	startRun,
	type ActivityBlockSnapshot,
	type ActivityBlockState,
} from "./activity-block-state.ts";

export type ActivityBlockMessageDetails = {
	turnId: string;
	turnDisplayId: string;
};

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];
type HistoricalAssistantMessage = Extract<SessionMessage, { role: "assistant" }>;
type HistoricalToolResultMessage = Extract<SessionMessage, { role: "toolResult" }>;
type HistoricalToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
};

type HistoricalActivityBlock = {
	turnId: string;
	state: ActivityBlockState;
	lastEventAt: number;
	lastAssistant?: HistoricalAssistantMessage;
};

export function getActivityBlockMessageDetails(
	entry: SessionEntry,
	messageType: string,
): ActivityBlockMessageDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== messageType) return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const turnId = (details as { turnId?: unknown }).turnId;
	const turnDisplayId = (details as { turnDisplayId?: unknown }).turnDisplayId;
	if (typeof turnId !== "string" || !turnId) return undefined;
	if (typeof turnDisplayId !== "string" || !turnDisplayId) return undefined;
	return { turnId, turnDisplayId };
}

export function reconstructSnapshotsFromTranscript(
	entries: SessionEntry[],
	messageType: string,
): Map<string, ActivityBlockSnapshot> {
	const snapshots = new Map<string, ActivityBlockSnapshot>();
	let current: HistoricalActivityBlock | undefined;

	const finishCurrent = (now?: number) => {
		if (!current) return;
		const endedAt = now ?? current.lastEventAt;
		finishRun(
			current.state,
			{ type: "agent_end", messages: current.lastAssistant ? [current.lastAssistant] : [] },
			endedAt,
		);
		snapshots.set(current.turnId, getActivityBlockSnapshot(current.state));
		current = undefined;
	};

	for (const entry of entries) {
		const activityDetails = getActivityBlockMessageDetails(entry, messageType);
		if (activityDetails) {
			finishCurrent(entryTimestampMs(entry, current?.lastEventAt));
			const startedAt = entryTimestampMs(entry, Date.now());
			const state = createInitialActivityBlockState();
			startRun(state, startedAt);
			current = { turnId: activityDetails.turnId, state, lastEventAt: startedAt };
			continue;
		}

		if (!current) continue;
		if (entry.type === "custom_message") continue;
		if (entry.type !== "message") continue;

		const message = entry.message;
		const now = entryTimestampMs(entry, messageTimestampMs(message) ?? current.lastEventAt);
		if (message.role === "user") {
			finishCurrent(now);
			continue;
		}
		if (message.role === "assistant") {
			current.lastEventAt = now;
			current.lastAssistant = message;
			for (const toolCall of getHistoricalToolCalls(message)) {
				applyToolStart(
					current.state,
					{
						type: "tool_execution_start",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						args: toolCall.arguments ?? {},
					},
					now,
				);
			}
			continue;
		}
		if (message.role === "toolResult") {
			current.lastEventAt = now;
			applyToolEnd(
				current.state,
				{
					type: "tool_execution_end",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					result: getToolResultPayload(message),
					isError: message.isError,
				},
				now,
			);
		}
	}

	finishCurrent();
	return snapshots;
}

export function mergeRecoveredToolHistory(
	snapshot: ActivityBlockSnapshot,
	recovered: ActivityBlockSnapshot | undefined,
): ActivityBlockSnapshot {
	const snapshotToolCount = Array.isArray(snapshot.tools) ? snapshot.tools.length : 0;
	const recoveredToolCount = Array.isArray(recovered?.tools) ? recovered.tools.length : 0;
	if (!recovered || snapshotToolCount >= recoveredToolCount) return snapshot;
	return {
		...recovered,
		...snapshot,
		startedAt: snapshot.startedAt ?? recovered.startedAt,
		endedAt: snapshot.endedAt ?? recovered.endedAt,
		tools: recovered.tools,
		totalTools: recovered.totalTools,
		activeTools: recovered.activeTools,
		completedTools: recovered.completedTools,
		failedTools: recovered.failedTools,
		latestActiveTool: recovered.latestActiveTool,
		latestToolView: snapshot.latestToolView ?? recovered.latestToolView,
		lastToolSummary: snapshot.lastToolSummary ?? recovered.lastToolSummary,
		lastToolUpdateAt: snapshot.lastToolUpdateAt ?? recovered.lastToolUpdateAt,
		currentActivity: snapshot.currentActivity ?? recovered.currentActivity,
		previousActivity: snapshot.previousActivity ?? recovered.previousActivity,
	};
}

function getHistoricalToolCalls(message: HistoricalAssistantMessage): HistoricalToolCall[] {
	return message.content.filter(isHistoricalToolCall);
}

function isHistoricalToolCall(content: HistoricalAssistantMessage["content"][number]): content is HistoricalToolCall {
	if (!content || typeof content !== "object") return false;
	if (content.type !== "toolCall") return false;
	const candidate = content as { id?: unknown; name?: unknown; arguments?: unknown };
	if (typeof candidate.id !== "string" || !candidate.id) return false;
	if (typeof candidate.name !== "string" || !candidate.name) return false;
	if (candidate.arguments !== undefined && (!candidate.arguments || typeof candidate.arguments !== "object" || Array.isArray(candidate.arguments))) return false;
	return true;
}

function getToolResultPayload(message: HistoricalToolResultMessage): { content: HistoricalToolResultMessage["content"]; details?: unknown } {
	return {
		content: message.content,
		details: message.details,
	};
}

function entryTimestampMs(entry: SessionEntry, fallback: number | undefined): number {
	const timestamp = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
	if (Number.isFinite(timestamp)) return timestamp;
	return fallback ?? Date.now();
}

function messageTimestampMs(message: SessionMessage): number | undefined {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
	return timestamp;
}
