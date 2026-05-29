// @lat: [[activity-block#Activity block]]

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionEntry,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import {
	getActivityBlockMessageDetails,
	mergeRecoveredToolHistory,
	reconstructSnapshotsFromTranscript,
	type ActivityBlockMessageDetails,
} from "./lib/activity-block-history.ts";
import { ActivityBlockMessageComponent, isExpandedThinkingShown, type ToolHistoryViewMode } from "./lib/activity-block-widget.ts";
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
	startTurn,
	syncLatestTokenCount,
	type ActivityBlockSnapshot,
	type ActivityBlockState,
	type PersistedActivityBlockState,
} from "./lib/activity-block-state.ts";

const MESSAGE_TYPE = "activity-block-turn";
const STATE_TYPE = "activity-block-state";
const STATUS_KEY = "activity-block";
const LIVE_DOCK_WIDGET_KEY = "activity-block-live-dock";
const BLOCK_TOGGLE_SHORTCUT = "ctrl+alt+a";
const THINKING_TOGGLE_SHORTCUT = "ctrl+alt+t";
const ZEN_MODE_TOGGLE_SHORTCUT = "ctrl+alt+z";
const TOKEN_REFRESH_INTERVAL_MS = 1000;

const ACTIVITY_BLOCK_CONTENT = "activity block";

type LiveTranscriptMode = {
	toolRows?: "show" | "hide";
	thinking?: "show" | "collapse" | "hide";
	working?: "show" | "hide";
};

type HistoricalTranscriptMode = {
	toolRows?: "show" | "hide";
	thinking?: "show" | "collapse" | "hide";
};

type TranscriptViewMode = "block" | "default";

type TranscriptModeCapableUI = ExtensionContext["ui"] & {
	setLiveTranscriptMode?: (mode?: LiveTranscriptMode) => void;
	setHistoricalTranscriptMode?: (mode?: HistoricalTranscriptMode) => void;
};

type ActivityBlockTheme = ConstructorParameters<typeof ActivityBlockMessageComponent>[0];
type ActivityBlockWidgetFactory = (_tui: unknown, theme: ActivityBlockTheme) => ActivityBlockMessageComponent;
type WidgetCapableUI = ExtensionContext["ui"] & {
	setWidget?: (key: string, content?: string[] | ActivityBlockWidgetFactory, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
};

class ActivityBlockController {
	private activeTurn:
		| {
			turnId: string;
			turnDisplayId: string;
			state: ActivityBlockState;
			messageInserted: boolean;
			ignoreNextUserMessageStart: boolean;
			pendingTerminalEvent?: TurnEndEvent;
		  }
		| undefined;
	private readonly persistedSnapshots = new Map<string, ActivityBlockSnapshot>();
	private toolHistoryViewMode: ToolHistoryViewMode = "latest";
	private thinkingExpanded = false;
	private zenMode = false;
	private transcriptViewMode: TranscriptViewMode = "block";
	private dockedTurnId: string | undefined;
	// Only hide the transcript duplicate when a dock widget is actually visible.
	// Zen/default mode may retain dock state without a visible widget, and hiding on
	// dockedTurnId alone would make the block disappear from every surface.
	private visibleDockTurnId: string | undefined;
	private uiContext: ExtensionContext | undefined;
	private turnCounter = 0;
	private compactionCount = 0;
	private awaitingQueuedTurnStart = false;
	private tokenRefreshInterval: ReturnType<typeof setInterval> | undefined;

	attach(ctx: ExtensionContext): void {
		this.uiContext = ctx;
		this.syncContextUsage(ctx);
		this.syncDockWidget(ctx);
		this.refreshStatus();
	}

	reset(ctx?: ExtensionContext): void {
		this.stopTokenRefresh();
		this.activeTurn = undefined;
		this.clearDockedTurn(ctx ?? this.uiContext);
		this.persistedSnapshots.clear();
		this.compactionCount = 0;
		this.awaitingQueuedTurnStart = false;
		this.clearTranscriptModes(ctx ?? this.uiContext);
		this.refreshStatus();
	}

	hydrateFromEntries(entries: SessionEntry[]): void {
		this.persistedSnapshots.clear();
		this.turnCounter = 0;
		this.compactionCount = 0;
		this.awaitingQueuedTurnStart = false;
		const reconstructedSnapshots = reconstructSnapshotsFromTranscript(entries, MESSAGE_TYPE);
		for (const [turnId, snapshot] of reconstructedSnapshots) {
			this.persistedSnapshots.set(turnId, snapshot);
			this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(turnId));
		}
		for (const entry of entries) {
			if (entry.type === "compaction") {
				this.compactionCount += 1;
				continue;
			}
			const details = getActivityBlockMessageDetails(entry, MESSAGE_TYPE);
			if (details) {
				this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(details.turnId));
				continue;
			}
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				const data = entry.data as PersistedActivityBlockState | undefined;
				if (!data?.turnId || !data.snapshot) continue;
				this.persistedSnapshots.set(
					data.turnId,
					mergeRecoveredToolHistory(data.snapshot, reconstructedSnapshots.get(data.turnId)),
				);
				this.turnCounter = Math.max(this.turnCounter, deriveTurnCounter(data.turnId));
			}
		}
	}

	prepareTurn(
		ctx: ExtensionContext,
		now: number,
		hasTriggerMessages: boolean,
	): {
		message?: Pick<
			{ customType: string; content: string; display: boolean; details: ActivityBlockMessageDetails },
			"customType" | "content" | "display" | "details"
		>;
		completed?: PersistedActivityBlockState;
	} {
		this.attach(ctx);
		if (this.transcriptViewMode === "default") {
			this.clearDockedTurn(ctx);
			this.clearTranscriptModes(ctx);
			return {};
		}

		let completed: PersistedActivityBlockState | undefined;
		if (hasTriggerMessages && this.activeTurn?.messageInserted === false) {
			this.syncContextUsage(ctx);
			this.startTokenRefresh();
			this.enableTranscriptMode(ctx);
			this.refreshStatus();
			this.activeTurn.messageInserted = true;
			return {
				message: this.createTurnMessage(this.activeTurn),
				completed,
			};
		}
		if (hasTriggerMessages && this.activeTurn) {
			completed = this.awaitingQueuedTurnStart
				? this.consumeQueuedTurnBoundary(now)
				: this.finishActiveTurn(this.activeTurn.pendingTerminalEvent, now);
		}
		this.awaitingQueuedTurnStart = false;

		if (!this.activeTurn) {
			this.activeTurn = this.createActiveTurn(ctx, now);
			return {
				message: this.createTurnMessage(this.activeTurn),
				completed,
			};
		}

		this.syncContextUsage(ctx);
		this.startTokenRefresh();
		this.enableTranscriptMode(ctx);
		this.refreshStatus();
		return { completed };
	}

	onMessageUpdate(event: MessageUpdateEvent, now: number, ctx?: ExtensionContext): void {
		const state = this.activeTurn?.state;
		if (!state) return;
		applyMessageUpdate(state, event, now);
		this.syncContextUsage(ctx);
		this.refreshStatus();
	}

	onToolStart(event: ToolExecutionStartEvent, now: number, ctx?: ExtensionContext): void {
		const state = this.activeTurn?.state;
		if (!state) return;
		applyToolStart(state, event, now);
		this.syncContextUsage(ctx);
		this.refreshStatus();
	}

	onToolUpdate(event: ToolExecutionUpdateEvent, now: number, ctx?: ExtensionContext): void {
		const state = this.activeTurn?.state;
		if (!state) return;
		applyToolUpdate(state, event, now);
		this.syncContextUsage(ctx);
		this.refreshStatus();
	}

	onToolEnd(event: ToolExecutionEndEvent, now: number, ctx?: ExtensionContext): void {
		const state = this.activeTurn?.state;
		if (!state) return;
		applyToolEnd(state, event, now);
		this.syncContextUsage(ctx);
		this.refreshStatus();
	}

	onTurnStart(): void {
		const state = this.activeTurn?.state;
		if (!state) return;
		startTurn(state);
	}

	onTurnEnd(event: TurnEndEvent): void {
		if (!this.activeTurn) return;
		// Keep live transcript suppression active until the current block is finalized.
		// Tool-result continuations reuse the same block across intermediate turn_end events.
		this.activeTurn.pendingTerminalEvent = event;
	}

	finishCurrentTurn(event: AgentEndEvent | undefined, now: number): PersistedActivityBlockState | undefined {
		const persisted = this.finishActiveTurn(this.activeTurn?.pendingTerminalEvent ?? event, now);
		if (!this.activeTurn) {
			this.awaitingQueuedTurnStart = false;
		}
		return persisted;
	}

	markQueuedTurnBoundary(): void {
		if (!this.activeTurn) return;
		this.awaitingQueuedTurnStart = true;
	}

	consumeQueuedTurnBoundary(now: number): PersistedActivityBlockState | undefined {
		if (!this.activeTurn || !this.awaitingQueuedTurnStart) return undefined;
		this.awaitingQueuedTurnStart = false;
		return this.finishActiveTurn(undefined, now, { interrupt: true, keepLiveTranscriptMode: true });
	}

	splitAfterQueuedTrigger(ctx: ExtensionContext, now: number): PersistedActivityBlockState | undefined {
		if (!this.activeTurn) return undefined;
		this.markQueuedTurnBoundary();
		const completed = this.consumeQueuedTurnBoundary(now);
		this.primeQueuedTurn(ctx, now);
		return completed;
	}

	shouldSplitAfterMessageStart(message: { role: string; customType?: string }): boolean {
		if (!shouldStartNewBlockAfterMessageStart(message, this.hasActiveTurn(), this.activeTurn?.ignoreNextUserMessageStart ?? false)) {
			return false;
		}
		return true;
	}

	consumeExpectedUserMessageStart(message: { role: string; customType?: string }): void {
		if (!this.activeTurn || message.role !== "user") return;
		if (this.activeTurn.ignoreNextUserMessageStart) {
			this.activeTurn.ignoreNextUserMessageStart = false;
		}
	}

	primeQueuedTurn(ctx: ExtensionContext, now: number): void {
		this.attach(ctx);
		if (this.activeTurn) return;
		this.activeTurn = this.createActiveTurn(ctx, now, { messageInserted: false, ignoreNextUserMessageStart: false });
	}

	getSnapshot(turnId: string): ActivityBlockSnapshot | undefined {
		if (this.activeTurn?.turnId === turnId) {
			return getActivityBlockSnapshot(this.activeTurn.state);
		}
		return this.persistedSnapshots.get(turnId);
	}

	getToolHistoryViewMode(): ToolHistoryViewMode {
		return this.toolHistoryViewMode;
	}

	getThinkingExpanded(): boolean {
		return this.thinkingExpanded;
	}

	shouldHideTurn(turnId: string | undefined): boolean {
		return this.transcriptViewMode === "default"
			|| (this.zenMode && turnId !== undefined)
			|| (turnId !== undefined && turnId === this.visibleDockTurnId);
	}

	getCompactionCount(): number {
		return this.compactionCount;
	}

	hasActiveTurn(): boolean {
		return this.activeTurn !== undefined;
	}

	hasBlocks(): boolean {
		return this.activeTurn !== undefined || this.persistedSnapshots.size > 0;
	}

	cycleToolHistoryViewMode(ctx?: ExtensionContext): ToolHistoryViewMode {
		if (ctx) {
			this.attach(ctx);
		}
		const snapshot = this.getLatestVisibleSnapshot();
		this.toolHistoryViewMode = getNextToolHistoryViewMode(
			this.toolHistoryViewMode,
			snapshot?.totalTools ?? 0,
			{ expandedThinkingShown: snapshot ? isExpandedThinkingShown(snapshot, this.thinkingExpanded) : false },
		);
		this.refreshStatus();
		return this.toolHistoryViewMode;
	}

	setToolHistoryViewMode(nextMode: ToolHistoryViewMode, ctx?: ExtensionContext): ToolHistoryViewMode {
		if (ctx) {
			this.attach(ctx);
		}
		this.toolHistoryViewMode = nextMode;
		this.refreshStatus();
		return this.toolHistoryViewMode;
	}

	toggleThinkingExpanded(ctx?: ExtensionContext, nextExpanded?: boolean): boolean {
		if (ctx) {
			this.attach(ctx);
		}
		this.thinkingExpanded = nextExpanded ?? !this.thinkingExpanded;
		this.refreshStatus();
		return this.thinkingExpanded;
	}

	setZenMode(nextEnabled: boolean, ctx?: ExtensionContext): boolean {
		if (ctx) {
			this.attach(ctx);
		}
		this.zenMode = nextEnabled;
		this.syncDockWidget(ctx ?? this.uiContext);
		this.refreshStatus();
		return this.zenMode;
	}

	toggleZenMode(ctx?: ExtensionContext): boolean {
		return this.setZenMode(!this.zenMode, ctx);
	}

	setTranscriptViewMode(nextMode: TranscriptViewMode, ctx?: ExtensionContext): TranscriptViewMode {
		if (ctx) {
			this.attach(ctx);
		}
		this.transcriptViewMode = nextMode;
		if (nextMode === "default") {
			this.clearDockedTurn(ctx ?? this.uiContext);
		} else {
			this.syncDockWidget(ctx ?? this.uiContext);
		}
		this.applyCurrentTranscriptMode(ctx ?? this.uiContext);
		this.refreshStatus();
		return this.transcriptViewMode;
	}

	private getLatestVisibleSnapshot(): ActivityBlockSnapshot | undefined {
		if (this.activeTurn) {
			return getActivityBlockSnapshot(this.activeTurn.state);
		}
		let latestSnapshot: ActivityBlockSnapshot | undefined;
		for (const snapshot of this.persistedSnapshots.values()) {
			latestSnapshot = snapshot;
		}
		return latestSnapshot;
	}

	private createTurnIdentity(now: number): { turnId: string; turnDisplayId: string } {
		this.turnCounter += 1;
		return {
			turnId: `turn-${now}-${this.turnCounter}`,
			turnDisplayId: String(this.turnCounter),
		};
	}

	private createActiveTurn(
		ctx: ExtensionContext,
		now: number,
		options?: { messageInserted?: boolean; ignoreNextUserMessageStart?: boolean },
	): NonNullable<ActivityBlockController["activeTurn"]> {
		const { turnId, turnDisplayId } = this.createTurnIdentity(now);
		const state = createInitialActivityBlockState();
		startRun(state, now);
		setTurnTokenBaseline(state, ctx.getContextUsage?.()?.tokens);
		const activeTurn = {
			turnId,
			turnDisplayId,
			state,
			messageInserted: options?.messageInserted ?? true,
			ignoreNextUserMessageStart: options?.ignoreNextUserMessageStart ?? false,
		} satisfies NonNullable<ActivityBlockController["activeTurn"]>;
		this.activeTurn = activeTurn;
		this.dockedTurnId = activeTurn.turnId;
		this.syncContextUsage(ctx);
		this.startTokenRefresh();
		if (this.transcriptViewMode === "block") {
			this.enableTranscriptMode(ctx);
		} else {
			this.clearTranscriptModes(ctx);
		}
		this.syncDockWidget(ctx);
		this.refreshStatus();
		return activeTurn;
	}

	private createTurnMessage(
		activeTurn: NonNullable<ActivityBlockController["activeTurn"]>,
	): Pick<{ customType: string; content: string; display: boolean; details: ActivityBlockMessageDetails }, "customType" | "content" | "display" | "details"> {
		return {
			customType: MESSAGE_TYPE,
			content: ACTIVITY_BLOCK_CONTENT,
			display: true,
			details: { turnId: activeTurn.turnId, turnDisplayId: activeTurn.turnDisplayId } satisfies ActivityBlockMessageDetails,
		};
	}

	private finishActiveTurn(
		event: AgentEndEvent | TurnEndEvent | undefined,
		now: number,
		options?: { interrupt?: boolean; keepLiveTranscriptMode?: boolean },
	): PersistedActivityBlockState | undefined {
		const activeTurn = this.activeTurn;
		if (!activeTurn) return undefined;
		this.stopTokenRefresh();
		if (event) {
			finishRun(activeTurn.state, event, now);
		} else if (options?.interrupt) {
			interruptRun(activeTurn.state, now);
		}
		const snapshot = getActivityBlockSnapshot(activeTurn.state);
		this.persistedSnapshots.set(activeTurn.turnId, snapshot);
		this.activeTurn = undefined;
		this.dockedTurnId = activeTurn.turnId;
		if (!options?.keepLiveTranscriptMode) {
			this.disableLiveTranscriptMode(this.uiContext);
		}
		this.syncDockWidget(this.uiContext);
		this.refreshStatus();
		return { turnId: activeTurn.turnId, snapshot };
	}

	private enableTranscriptMode(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const ui = ctx.ui as TranscriptModeCapableUI;
		ui.setLiveTranscriptMode?.({ toolRows: "hide", thinking: "hide", working: "show" });
	}

	applyHistoricalTranscriptMode(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const ui = ctx.ui as TranscriptModeCapableUI;
		ui.setHistoricalTranscriptMode?.({ toolRows: "hide", thinking: "hide" });
	}

	applyCurrentTranscriptMode(ctx: ExtensionContext | undefined): void {
		if (this.transcriptViewMode === "default") {
			this.clearDockedTurn(ctx);
			this.clearTranscriptModes(ctx);
			return;
		}
		this.applyHistoricalTranscriptMode(ctx);
		if (this.activeTurn) {
			this.enableTranscriptMode(ctx);
		} else {
			this.disableLiveTranscriptMode(ctx);
		}
		this.syncDockWidget(ctx);
	}

	private disableLiveTranscriptMode(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const ui = ctx.ui as TranscriptModeCapableUI;
		ui.setLiveTranscriptMode?.(undefined);
	}

	private clearTranscriptModes(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const ui = ctx.ui as TranscriptModeCapableUI;
		ui.setLiveTranscriptMode?.(undefined);
		ui.setHistoricalTranscriptMode?.(undefined);
	}

	clearDockedTurn(ctx?: ExtensionContext): void {
		this.dockedTurnId = undefined;
		this.clearDockWidget(ctx ?? this.uiContext);
	}

	private syncDockWidget(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) return;
		const ui = ctx.ui as WidgetCapableUI;
		if (typeof ui.setWidget !== "function") {
			this.visibleDockTurnId = undefined;
			return;
		}
		const turnId = this.getDockedTurnIdForDisplay();
		if (!turnId) {
			this.clearDockWidget(ctx);
			return;
		}
		if (this.visibleDockTurnId === turnId) return;
		ui.setWidget(
			LIVE_DOCK_WIDGET_KEY,
			(_tui: unknown, theme: ActivityBlockTheme) => new ActivityBlockMessageComponent(
				theme,
				() => (this.dockedTurnId ? this.getSnapshot(this.dockedTurnId) : undefined),
				() => Date.now(),
				() => this.getToolHistoryViewMode(),
				() => this.getThinkingExpanded(),
				() => this.getCompactionCount(),
				() => false,
			),
			{ placement: "aboveEditor" },
		);
		this.visibleDockTurnId = turnId;
	}

	private getDockedTurnIdForDisplay(): string | undefined {
		if (this.transcriptViewMode !== "block") return undefined;
		if (this.zenMode) return undefined;
		return this.dockedTurnId;
	}

	private clearDockWidget(ctx: ExtensionContext | undefined): void {
		if (!ctx?.hasUI) {
			this.visibleDockTurnId = undefined;
			return;
		}
		const ui = ctx.ui as WidgetCapableUI;
		if (typeof ui.setWidget === "function" && this.visibleDockTurnId !== undefined) {
			ui.setWidget(LIVE_DOCK_WIDGET_KEY, undefined);
		}
		this.visibleDockTurnId = undefined;
	}

	private startTokenRefresh(): void {
		if (this.tokenRefreshInterval || !this.activeTurn) return;
		this.tokenRefreshInterval = setInterval(() => {
			if (!this.activeTurn) {
				this.stopTokenRefresh();
				return;
			}
			this.syncContextUsage();
			this.refreshStatus();
		}, TOKEN_REFRESH_INTERVAL_MS);
		this.tokenRefreshInterval.unref?.();
	}

	private stopTokenRefresh(): void {
		if (!this.tokenRefreshInterval) return;
		clearInterval(this.tokenRefreshInterval);
		this.tokenRefreshInterval = undefined;
	}

	private syncContextUsage(ctx?: ExtensionContext): void {
		const state = this.activeTurn?.state;
		const usage = (ctx ?? this.uiContext)?.getContextUsage?.();
		if (!state || !usage) return;
		syncLatestTokenCount(state, usage.tokens, "context");
	}

	clearQueuedTurnBoundary(ctx?: ExtensionContext): void {
		if (!this.awaitingQueuedTurnStart) return;
		this.awaitingQueuedTurnStart = false;
		this.disableLiveTranscriptMode(ctx ?? this.uiContext);
	}

	private refreshStatus(): void {
		if (!this.uiContext?.hasUI) return;
		this.uiContext.ui.setStatus(STATUS_KEY, undefined);
	}
}

function deriveTurnCounter(turnId: string): number {
	const match = /^turn-(\d+)-(\d+)$/.exec(turnId);
	if (!match) return 0;
	return Number(match[2] ?? 0);
}

function isActivityBlockMessage(message: { role: string; customType?: string }): boolean {
	return message.role === "custom" && message.customType === MESSAGE_TYPE;
}

export function shouldStartNewBlockAfterMessageStart(
	message: { role: string; customType?: string },
	hasActiveTurn: boolean,
	ignoreNextUserMessageStart: boolean,
): boolean {
	if (!hasActiveTurn) return false;
	if (isActivityBlockMessage(message)) return false;
	if (message.role !== "user") return false;
	if (ignoreNextUserMessageStart) return false;
	return true;
}

function parseExpandCommand(args: string): boolean | undefined {
	const command = args.trim().toLowerCase();
	if (command === "expand") return true;
	if (command === "collapse") return false;
	return undefined;
}

function parseToolHistoryViewMode(args: string): ToolHistoryViewMode | undefined {
	const command = args.trim().toLowerCase();
	if (!command) return undefined;
	if (command === "expand" || command === "all") return "all";
	if (command === "collapse" || command === "latest") return "latest";
	if (command === "recent" || command === "5" || command === "five" || command === "5 latest" || command === "latest 5" || command === "5-latest") return "recent";
	return undefined;
}

function parseZenModeCommand(args: string): boolean | "toggle" | undefined {
	const command = args.trim().toLowerCase();
	if (command === "zen") return "toggle";
	if (command === "zen on" || command === "zen enable" || command === "zen enabled") return true;
	if (command === "zen off" || command === "zen disable" || command === "zen disabled") return false;
	return undefined;
}

function parseTranscriptViewModeCommand(args: string): TranscriptViewMode | undefined {
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

export default function activityBlockExtension(pi: ExtensionAPI): void {
	const controller = new ActivityBlockController();

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as ActivityBlockMessageDetails | undefined;
		return new ActivityBlockMessageComponent(
			theme,
			() => (details?.turnId ? controller.getSnapshot(details.turnId) : undefined),
			() => Date.now(),
			() => controller.getToolHistoryViewMode(),
			() => controller.getThinkingExpanded(),
			() => controller.getCompactionCount(),
			() => controller.shouldHideTurn(details?.turnId),
		);
	});

	pi.registerCommand("activity-block", {
		description: "Cycle tool history view: latest, 5 latest, all. Use latest, recent, all, mode block|default, or zen [on|off]. Thinking text stays on /activity-block-thinking or ctrl+alt+t.",
		handler: async (args, ctx) => {
			const viewMode = parseTranscriptViewModeCommand(args);
			if (viewMode) {
				controller.setTranscriptViewMode(viewMode, ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(viewMode === "block" ? "Activity block view enabled." : "Default pi tool-call view enabled.", "info");
				}
				return;
			}
			const zenCommand = parseZenModeCommand(args);
			if (zenCommand !== undefined) {
				const enabled = zenCommand === "toggle" ? controller.toggleZenMode(ctx) : controller.setZenMode(zenCommand, ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(enabled ? "Zen mode enabled — hiding the activity block while pi is working." : "Zen mode disabled — showing the activity block again.", "info");
				}
				return;
			}
			const nextMode = parseToolHistoryViewMode(args);
			if (nextMode) {
				controller.setToolHistoryViewMode(nextMode, ctx);
				return;
			}
			controller.cycleToolHistoryViewMode(ctx);
		},
	});

	pi.registerCommand("activity-block-thinking", {
		description: "Toggle the current thinking view inside activity blocks. Use expand or collapse to set an explicit state.",
		handler: async (args, ctx) => {
			if (!controller.hasBlocks()) {
				ctx.ui.notify("No activity block to expand.", "info");
				return;
			}
			controller.toggleThinkingExpanded(ctx, parseExpandCommand(args));
		},
	});

	pi.registerShortcut(BLOCK_TOGGLE_SHORTCUT, {
		description: "Cycle activity block tool history view",
		handler: async (ctx) => {
			controller.cycleToolHistoryViewMode(ctx);
		},
	});

	pi.registerShortcut(THINKING_TOGGLE_SHORTCUT, {
		description: "Toggle the current thinking view inside activity blocks",
		handler: async (ctx) => {
			if (!controller.hasBlocks()) return;
			controller.toggleThinkingExpanded(ctx);
		},
	});

	pi.registerShortcut(ZEN_MODE_TOGGLE_SHORTCUT, {
		description: "Toggle activity block zen mode",
		handler: async (ctx) => {
			const enabled = controller.toggleZenMode(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(enabled ? "Zen mode enabled — hiding the activity block while pi is working." : "Zen mode disabled — showing the activity block again.", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		controller.attach(ctx);
		controller.hydrateFromEntries(ctx.sessionManager.getBranch());
		controller.setToolHistoryViewMode(controller.getToolHistoryViewMode(), ctx);
		controller.toggleThinkingExpanded(ctx, controller.getThinkingExpanded());
		controller.applyCurrentTranscriptMode(ctx);
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => !isActivityBlockMessage(message as { role: string; customType?: string })),
		};
	});

	// @ts-ignore queued-turn lifecycle comes from the local pi-core patch stack.
	pi.on("before_turn_response", async (event: { triggerMessages?: Array<unknown> }, ctx) => {
		const triggerMessages = Array.isArray(event.triggerMessages) ? event.triggerMessages : [];
		const prepared = controller.prepareTurn(ctx, Date.now(), triggerMessages.length > 0);
		if (prepared.completed) {
			pi.appendEntry(STATE_TYPE, prepared.completed);
		}
		if (!prepared.message) {
			return undefined;
		}
		return { message: prepared.message };
	});

	pi.on("input", async (_event, ctx) => {
		if (controller.hasActiveTurn() && !ctx.isIdle()) {
			controller.markQueuedTurnBoundary();
			return;
		}
		controller.clearDockedTurn(ctx);
	});

	pi.on("turn_start", async () => {
		controller.onTurnStart();
	});

	pi.on("message_start", async (event: MessageStartEvent, ctx) => {
		if (!controller.shouldSplitAfterMessageStart(event.message as { role: string; customType?: string })) {
			controller.consumeExpectedUserMessageStart(event.message as { role: string; customType?: string });
			return;
		}
		const persisted = controller.splitAfterQueuedTrigger(ctx, Date.now());
		if (persisted) {
			pi.appendEntry(STATE_TYPE, persisted);
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		controller.onMessageUpdate(event, Date.now(), ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		controller.onToolStart(event, Date.now(), ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		controller.onToolUpdate(event, Date.now(), ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		controller.onToolEnd(event, Date.now(), ctx);
	});

	pi.on("turn_end", async (event) => {
		controller.onTurnEnd(event);
	});

	pi.on("agent_end", async (event, ctx) => {
		const persisted = controller.finishCurrentTurn(event, Date.now());
		if (persisted) {
			pi.appendEntry(STATE_TYPE, persisted);
			return;
		}
		controller.clearQueuedTurnBoundary(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		controller.attach(ctx);
		controller.hydrateFromEntries(ctx.sessionManager.getBranch());
		controller.applyCurrentTranscriptMode(ctx);
	});

	pi.on("session_shutdown", async () => {
		controller.reset();
	});
}
