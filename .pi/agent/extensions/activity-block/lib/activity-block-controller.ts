// @lat: [[activity-block#Activity block]]
// Block lifecycle on pi 1.3.0 public extension events. See `.lat-md/activity-block.md` for the contract.

import type {
	AgentEndEvent,
	ExtensionContext,
	MessageUpdateEvent,
	TurnEndEvent,
	SessionEntry,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { TranscriptViewMode } from "./activity-block-commands.ts";
import { getNextToolHistoryViewMode } from "./activity-block-commands.ts";
import {
	getActivityBlockMessageDetails,
	mergeRecoveredToolHistory,
	reconstructSnapshotsFromTranscript,
	type ActivityBlockMessageDetails,
} from "./activity-block-history.ts";
import {
	applyMessageUpdate,
	applyToolEnd,
	applyToolStart,
	applyToolUpdate,
	createInitialActivityBlockState,
	finishRun,
	getActivityBlockSnapshot,
	interruptRun,
	setTurnTokenBaseline,
	startRun,
	syncLatestTokenCount,
	type ActivityBlockSnapshot,
	type ActivityBlockState,
	type PersistedActivityBlockState,
} from "./activity-block-state.ts";
import { ActivityBlockMessageComponent, isExpandedThinkingShown, type ToolHistoryViewMode } from "./activity-block-widget.ts";

/** customType of the transcript anchor entry (`custom` today, `custom_message` in pre-1.3.0 sessions). */
export const ANCHOR_TYPE = "activity-block-turn";
/** customType of the persisted final snapshot entry. */
export const STATE_TYPE = "activity-block-state";
export const DOCK_WIDGET_KEY = "activity-block-live-dock";
export const STEERING_SPLIT_LABEL = "Interrupted by steering";

/**
 * Side effects the controller needs from pi. Kept as an explicit port so tests drive the controller with a
 * recording fake instead of a full runtime.
 */
export interface ActivityBlockHost {
	appendEntry(customType: string, data: unknown): void;
	now(): number;
	setInterval(callback: () => void, ms: number): { unref?: () => void };
	clearInterval(handle: { unref?: () => void }): void;
}

type ActivityBlockTheme = ConstructorParameters<typeof ActivityBlockMessageComponent>[0];

type ActiveBlock = {
	turnId: string;
	turnDisplayId: string;
	state: ActivityBlockState;
	/** True once the anchor entry has been written. Splits only apply to anchored blocks. */
	anchored: boolean;
	/** Last `agent_end` of the run. A run can contain several (retry, compaction continuation). */
	pendingTerminalEvent?: AgentEndEvent;
	/** Last `turn_end` seen by this block. Tells a steer (loop still running tools) from a follow-up (loop done). */
	lastTurnEnd?: TurnEndEvent;
};

const TOKEN_REFRESH_INTERVAL_MS = 1000;

export class ActivityBlockController {
	private active: ActiveBlock | undefined;
	private readonly snapshots = new Map<string, ActivityBlockSnapshot>();
	private toolHistoryViewMode: ToolHistoryViewMode = "latest";
	private thinkingExpanded = false;
	private zenMode = false;
	private transcriptViewMode: TranscriptViewMode = "block";
	private turnCounter = 0;
	private compactionCount = 0;
	private ctx: ExtensionContext | undefined;
	private dockRequestRender: (() => void) | undefined;
	private tokenRefresh: { unref?: () => void } | undefined;
	private spinnerRefresh: { unref?: () => void } | undefined;
	private readonly host: ActivityBlockHost;
	private readonly spinnerIntervalMs: number;

	// Plain fields, not TS parameter properties: tests load these files with Node's strip-only TypeScript mode.
	constructor(host: ActivityBlockHost, spinnerIntervalMs: number) {
		this.host = host;
		this.spinnerIntervalMs = spinnerIntervalMs;
	}

	// ---------------------------------------------------------------------------------------------
	// Session lifecycle

	/** Restore state for the current branch and (re)claim UI surfaces. Called on session_start and tree navigation. */
	attachSession(ctx: ExtensionContext): void {
		this.stopTimers();
		this.active = undefined;
		this.ctx = ctx;
		this.hydrate(ctx.sessionManager.getBranch());
		this.applyUiMode();
	}

	/** Recount compactions after a compaction entry was added; blocks and anchors are unchanged. */
	onCompaction(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.compactionCount = countCompactions(ctx.sessionManager.getBranch());
		this.requestRender();
	}

	shutdown(): void {
		this.stopTimers();
		this.active = undefined;
		this.snapshots.clear();
		this.dockRequestRender = undefined;
		// pi's resetExtensionUI() clears widgets and restores the working row for the next runtime;
		// the old context may already be stale here, so do not touch ctx.ui.
		this.ctx = undefined;
	}

	// ---------------------------------------------------------------------------------------------
	// Run lifecycle

	/** `agent_start`. Idempotent: retries and compaction continuations of the same run reuse the active block. */
	onAgentStart(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (this.transcriptViewMode !== "block") return;
		if (this.active) {
			this.active.pendingTerminalEvent = undefined;
			return;
		}
		this.active = this.createBlock(ctx);
		this.syncTimers();
		this.requestRender();
	}

	/**
	 * `message_start`. Two jobs:
	 * - a user message (or displayed custom trigger) that arrives while the active block already has content
	 *   is a steering/follow-up message: freeze the current block and start a new unanchored one;
	 * - the first assistant message of a block writes the transcript anchor. Extension handlers run before pi's UI
	 *   receives `message_start`, so the anchor renders below the trigger message and above the streaming reply.
	 */
	onMessageStart(message: { role: string; customType?: string; display?: boolean }, ctx: ExtensionContext): void {
		this.ctx = ctx;
		const active = this.active;
		if (!active) return;
		if (isTriggerMessage(message)) {
			if (!active.anchored) return;
			const lastTurnEnd = active.lastTurnEnd;
			// A follow-up arrives after a turn that requested no more tools: that block finished normally.
			// A steer arrives while the loop still had tool work queued: that block was cut short.
			if (lastTurnEnd && lastTurnEnd.message.role === "assistant" && lastTurnEnd.message.stopReason !== "toolUse") {
				this.finishBlock((state, now) => finishRun(state, lastTurnEnd, now));
			} else {
				this.finishBlock((state, now) => interruptRun(state, now, STEERING_SPLIT_LABEL));
			}
			this.active = this.createBlock(ctx);
			this.syncTimers();
			this.requestRender();
			return;
		}
		if (message.role === "assistant" && !active.anchored) {
			active.anchored = true;
			const details: ActivityBlockMessageDetails = { turnId: active.turnId, turnDisplayId: active.turnDisplayId };
			this.host.appendEntry(ANCHOR_TYPE, details);
		}
	}

	onMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void {
		const state = this.activeState(ctx);
		if (!state) return;
		applyMessageUpdate(state, event, this.host.now());
		this.syncContextUsage();
		this.syncTimers();
		this.requestRender();
	}

	onToolStart(event: ToolExecutionStartEvent, ctx: ExtensionContext): void {
		const state = this.activeState(ctx);
		if (!state) return;
		applyToolStart(state, event, this.host.now());
		this.syncContextUsage();
		this.syncTimers();
		this.requestRender();
	}

	onToolUpdate(event: ToolExecutionUpdateEvent, ctx: ExtensionContext): void {
		const state = this.activeState(ctx);
		if (!state) return;
		applyToolUpdate(state, event, this.host.now());
		this.requestRender();
	}

	onToolEnd(event: ToolExecutionEndEvent, ctx: ExtensionContext): void {
		const state = this.activeState(ctx);
		if (!state) return;
		applyToolEnd(state, event, this.host.now());
		this.syncContextUsage();
		this.requestRender();
	}

	onTurnEnd(event: TurnEndEvent): void {
		if (!this.active) return;
		this.active.lastTurnEnd = event;
	}

	/** `agent_end`. Not final: pi may retry, continue after compaction, or drain queued follow-ups. */
	onAgentEnd(event: AgentEndEvent): void {
		if (!this.active) return;
		this.active.pendingTerminalEvent = event;
	}

	/** `agent_settled`. The run is fully done; persist and release the active block. */
	onAgentSettled(): void {
		const active = this.active;
		if (!active) return;
		const terminal: AgentEndEvent = active.pendingTerminalEvent ?? { type: "agent_end", messages: [] };
		this.finishBlock((state, now) => finishRun(state, terminal, now));
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering surfaces

	/** Factory for the permanent above-editor dock. It renders nothing unless a block is running and visible. */
	createDockComponent(tui: { requestRender(): void }, theme: ActivityBlockTheme): Component {
		this.dockRequestRender = () => tui.requestRender();
		return new ActivityBlockMessageComponent(
			theme,
			() => (this.active ? getActivityBlockSnapshot(this.active.state) : undefined),
			() => this.host.now(),
			() => this.toolHistoryViewMode,
			() => this.thinkingExpanded,
			() => this.compactionCount,
			() => !this.isDockVisible(),
		);
	}

	/** Transcript block for an anchor. Hidden while the same block is shown in the dock, and in default/zen mode. */
	createTranscriptComponent(details: ActivityBlockMessageDetails | undefined, theme: ActivityBlockTheme): Component {
		return new ActivityBlockMessageComponent(
			theme,
			() => (details ? this.getSnapshot(details.turnId) : undefined),
			() => this.host.now(),
			() => this.toolHistoryViewMode,
			() => this.thinkingExpanded,
			() => this.compactionCount,
			() => this.shouldHideTranscriptBlock(details?.turnId),
		);
	}

	getSnapshot(turnId: string): ActivityBlockSnapshot | undefined {
		if (this.active?.turnId === turnId) return getActivityBlockSnapshot(this.active.state);
		return this.snapshots.get(turnId);
	}

	shouldHideToolRows(): boolean {
		return this.transcriptViewMode === "block";
	}

	// ---------------------------------------------------------------------------------------------
	// User controls

	hasBlocks(): boolean {
		return this.active !== undefined || this.snapshots.size > 0;
	}

	getToolHistoryViewMode(): ToolHistoryViewMode {
		return this.toolHistoryViewMode;
	}

	getThinkingExpanded(): boolean {
		return this.thinkingExpanded;
	}

	getTranscriptViewMode(): TranscriptViewMode {
		return this.transcriptViewMode;
	}

	isZenMode(): boolean {
		return this.zenMode;
	}

	cycleToolHistoryViewMode(): ToolHistoryViewMode {
		const snapshot = this.getLatestSnapshot();
		this.toolHistoryViewMode = getNextToolHistoryViewMode(this.toolHistoryViewMode, snapshot?.totalTools ?? 0, {
			expandedThinkingShown: snapshot ? isExpandedThinkingShown(snapshot, this.thinkingExpanded) : false,
		});
		this.requestRender();
		return this.toolHistoryViewMode;
	}

	setToolHistoryViewMode(mode: ToolHistoryViewMode): void {
		this.toolHistoryViewMode = mode;
		this.requestRender();
	}

	toggleThinkingExpanded(next?: boolean): boolean {
		this.thinkingExpanded = next ?? !this.thinkingExpanded;
		this.requestRender();
		return this.thinkingExpanded;
	}

	setZenMode(enabled: boolean): boolean {
		this.zenMode = enabled;
		this.syncTimers();
		this.requestRender();
		return this.zenMode;
	}

	/**
	 * Switch between block mode and pi's default transcript. A running block is finalized when leaving block mode
	 * so its tool rows are not lost. Tool-row renderers are chosen per row, so rows that already exist keep their
	 * current look until pi rebuilds the chat (resume, reload, compaction).
	 */
	setTranscriptViewMode(mode: TranscriptViewMode): TranscriptViewMode {
		if (mode === this.transcriptViewMode) return mode;
		if (mode === "default" && this.active) {
			this.finishBlock((state, now) => interruptRun(state, now, "Switched to default view"));
		}
		this.transcriptViewMode = mode;
		this.applyUiMode();
		return mode;
	}

	// ---------------------------------------------------------------------------------------------
	// Internals

	private createBlock(ctx: ExtensionContext): ActiveBlock {
		this.turnCounter += 1;
		const now = this.host.now();
		const state = createInitialActivityBlockState();
		startRun(state, now);
		setTurnTokenBaseline(state, ctx.getContextUsage()?.tokens);
		return {
			turnId: `turn-${now}-${this.turnCounter}`,
			turnDisplayId: String(this.turnCounter),
			state,
			anchored: false,
		};
	}

	/** Freeze the active block, persist it if it was anchored, and clear it. */
	private finishBlock(finalize: (state: ActivityBlockState, now: number) => void): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		finalize(active.state, this.host.now());
		const snapshot = getActivityBlockSnapshot(active.state);
		// An unanchored block never appeared in the transcript (the run ended before any assistant message,
		// e.g. a provider error before streaming). Persisting it would create an orphan snapshot.
		if (active.anchored) {
			this.snapshots.set(active.turnId, snapshot);
			const persisted: PersistedActivityBlockState = { turnId: active.turnId, snapshot };
			this.host.appendEntry(STATE_TYPE, persisted);
		}
		this.syncTimers();
		this.requestRender();
	}

	private activeState(ctx: ExtensionContext): ActivityBlockState | undefined {
		this.ctx = ctx;
		return this.active?.state;
	}

	private hydrate(entries: SessionEntry[]): void {
		this.snapshots.clear();
		this.turnCounter = 0;
		this.compactionCount = countCompactions(entries);
		const reconstructed = reconstructSnapshotsFromTranscript(entries, ANCHOR_TYPE);
		for (const [turnId, snapshot] of reconstructed) {
			this.snapshots.set(turnId, snapshot);
			this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(turnId));
		}
		for (const entry of entries) {
			const details = getActivityBlockMessageDetails(entry, ANCHOR_TYPE);
			if (details) {
				this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(details.turnId));
				continue;
			}
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as Partial<PersistedActivityBlockState> | undefined;
			if (!data?.turnId || !data.snapshot) continue;
			this.snapshots.set(data.turnId, mergeRecoveredToolHistory(data.snapshot, reconstructed.get(data.turnId)));
			this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(data.turnId));
		}
	}

	private applyUiMode(): void {
		const ctx = this.ctx;
		if (ctx?.hasUI) {
			// Block mode owns the working indicator (the dock shows its own scanner). pi resets this on reload.
			ctx.ui.setWorkingVisible(this.transcriptViewMode !== "block");
		}
		this.syncTimers();
		this.requestRender();
	}

	private isDockVisible(): boolean {
		return this.active !== undefined && this.transcriptViewMode === "block" && !this.zenMode;
	}

	private shouldHideTranscriptBlock(turnId: string | undefined): boolean {
		if (this.transcriptViewMode === "default" || this.zenMode) return true;
		// The running block is shown in the dock; hide its transcript twin to avoid a duplicate.
		return turnId !== undefined && turnId === this.active?.turnId && this.isDockVisible();
	}

	private getLatestSnapshot(): ActivityBlockSnapshot | undefined {
		if (this.active) return getActivityBlockSnapshot(this.active.state);
		let latest: ActivityBlockSnapshot | undefined;
		for (const snapshot of this.snapshots.values()) latest = snapshot;
		return latest;
	}

	private syncContextUsage(): void {
		const state = this.active?.state;
		const usage = this.ctx?.getContextUsage();
		if (!state || !usage) return;
		syncLatestTokenCount(state, usage.tokens, "context");
	}

	private requestRender(): void {
		this.dockRequestRender?.();
	}

	private syncTimers(): void {
		if (this.active && !this.tokenRefresh) {
			this.tokenRefresh = this.startInterval(() => {
				this.syncContextUsage();
				this.requestRender();
			}, TOKEN_REFRESH_INTERVAL_MS);
		} else if (!this.active && this.tokenRefresh) {
			this.host.clearInterval(this.tokenRefresh);
			this.tokenRefresh = undefined;
		}
		const animate = this.isDockVisible() && this.active?.state.runState === "running" && !this.active.state.isResponding;
		if (animate && !this.spinnerRefresh) {
			this.spinnerRefresh = this.startInterval(() => this.requestRender(), this.spinnerIntervalMs);
		} else if (!animate && this.spinnerRefresh) {
			this.host.clearInterval(this.spinnerRefresh);
			this.spinnerRefresh = undefined;
		}
	}

	private startInterval(callback: () => void, ms: number): { unref?: () => void } {
		const handle = this.host.setInterval(callback, ms);
		handle.unref?.();
		return handle;
	}

	private stopTimers(): void {
		if (this.tokenRefresh) this.host.clearInterval(this.tokenRefresh);
		if (this.spinnerRefresh) this.host.clearInterval(this.spinnerRefresh);
		this.tokenRefresh = undefined;
		this.spinnerRefresh = undefined;
	}
}

/**
 * A message that starts new work inside a running agent loop: a steered/follow-up user message, or a displayed
 * custom message delivered by another extension with `triggerTurn`. Custom messages that pi flushes at turn end
 * (`sendMessage` without trigger) are emitted only to UI listeners, never to extensions, so they never reach here.
 */
export function isTriggerMessage(message: { role: string; display?: boolean }): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.display === true;
}

function countCompactions(entries: SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) if (entry.type === "compaction") count += 1;
	return count;
}

function deriveTurnCounter(turnId: string): number {
	const match = /^turn-(\d+)-(\d+)$/.exec(turnId);
	return match ? Number(match[2]) : 0;
}
