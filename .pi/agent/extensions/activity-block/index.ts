// @lat: [[activity-block#Activity block]]
// Wiring only: pi events -> ActivityBlockController. Lifecycle rules live in lib/activity-block-controller.ts.

import type { CustomEntry, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { OPENCODE_SCANNER_INTERVAL_MS } from "../lib/shared/opencode-scanner.ts";
import {
	parseExpandCommand,
	parseToolHistoryViewMode,
	parseTranscriptViewModeCommand,
	parseZenModeCommand,
} from "./lib/activity-block-commands.ts";
import {
	ActivityBlockController,
	ANCHOR_TYPE,
	DOCK_WIDGET_KEY,
	type ActivityBlockHost,
} from "./lib/activity-block-controller.ts";
import { parseActivityBlockDetails } from "./lib/activity-block-history.ts";
import { registerHiddenToolRows } from "./lib/activity-block-tool-rows.ts";

export { getNextToolHistoryViewMode } from "./lib/activity-block-commands.ts";
export { isTriggerMessage } from "./lib/activity-block-controller.ts";

const BLOCK_TOGGLE_SHORTCUT = "ctrl+alt+a";
const THINKING_TOGGLE_SHORTCUT = "ctrl+alt+t";
const ZEN_MODE_TOGGLE_SHORTCUT = "ctrl+alt+z";

const ZEN_ON_MESSAGE = "Zen mode enabled — hiding the activity block while pi is working.";
const ZEN_OFF_MESSAGE = "Zen mode disabled — showing the activity block again.";

/** Production host: pi session entries and real timers. Tests override `now`/timers through `clock`. */
function createHost(pi: ExtensionAPI, clock: Partial<Omit<ActivityBlockHost, "appendEntry">>): ActivityBlockHost {
	return {
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		now: clock.now ?? (() => Date.now()),
		setInterval: clock.setInterval ?? ((callback, ms) => setInterval(callback, ms)),
		clearInterval: clock.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)),
	};
}

export default function activityBlockExtension(
	pi: ExtensionAPI,
	clock: Partial<Omit<ActivityBlockHost, "appendEntry">> = {},
): void {
	const controller = new ActivityBlockController(createHost(pi, clock), OPENCODE_SCANNER_INTERVAL_MS);

	registerHiddenToolRows(pi, () => controller.shouldHideToolRows());

	// Current anchors: custom entries written on the first assistant message of each block.
	pi.registerEntryRenderer(ANCHOR_TYPE, (entry: CustomEntry, _options, theme) =>
		controller.createTranscriptComponent(parseActivityBlockDetails(entry.data), theme),
	);
	// Pre-1.3.0 sessions stored anchors as displayed custom messages; keep them readable.
	pi.registerMessageRenderer(ANCHOR_TYPE, (message, _options, theme) =>
		controller.createTranscriptComponent(parseActivityBlockDetails(message.details), theme),
	);
	// Legacy anchors are part of model context (custom_message). They carry no information for the model.
	pi.on("context", async (event) => ({
		messages: event.messages.filter((message) => !(message.role === "custom" && message.customType === ANCHOR_TYPE)),
	}));

	pi.on("session_start", async (_event, ctx) => {
		controller.attachSession(ctx);
		if (ctx.hasUI) {
			ctx.ui.setWidget(DOCK_WIDGET_KEY, (tui, theme) => controller.createDockComponent(tui, theme), { placement: "aboveEditor" });
		}
	});
	pi.on("session_tree", async (_event, ctx) => {
		controller.attachSession(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		controller.onCompaction(ctx);
	});
	pi.on("session_shutdown", async () => {
		controller.shutdown();
	});

	pi.on("agent_start", async (_event, ctx) => {
		controller.onAgentStart(ctx);
	});
	pi.on("message_start", async (event, ctx) => {
		controller.onMessageStart(event.message, ctx);
	});
	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		controller.onMessageUpdate(event, ctx);
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		// Nested calls (codemode scripts) are reported by their parent tool row.
		if (event.parentToolCallId) return;
		controller.onToolStart(event, ctx);
	});
	pi.on("tool_execution_update", async (event, ctx) => {
		if (event.parentToolCallId) return;
		controller.onToolUpdate(event, ctx);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.parentToolCallId) return;
		controller.onToolEnd(event, ctx);
	});
	pi.on("turn_end", async (event) => {
		controller.onTurnEnd(event);
	});
	pi.on("agent_end", async (event) => {
		controller.onAgentEnd(event);
	});
	pi.on("agent_settled", async () => {
		controller.onAgentSettled();
	});

	pi.registerCommand("activity-block", {
		description: "Cycle tool history view: latest, 5 latest, all. Use latest, recent, all, mode block|default, or zen [on|off]. Thinking text stays on /activity-block-thinking or ctrl+alt+t.",
		handler: async (args, ctx) => {
			const viewMode = parseTranscriptViewModeCommand(args);
			if (viewMode) {
				controller.setTranscriptViewMode(viewMode);
				ctx.ui.notify(
					viewMode === "block"
						? "Activity block view enabled for new tool calls."
						: "Default pi tool-call view enabled for new tool calls. Existing rows change after the chat is rebuilt (resume or reload).",
					"info",
				);
				return;
			}
			const zenCommand = parseZenModeCommand(args);
			if (zenCommand !== undefined) {
				const enabled = controller.setZenMode(zenCommand === "toggle" ? !controller.isZenMode() : zenCommand);
				ctx.ui.notify(enabled ? ZEN_ON_MESSAGE : ZEN_OFF_MESSAGE, "info");
				return;
			}
			const nextMode = parseToolHistoryViewMode(args);
			if (nextMode) {
				controller.setToolHistoryViewMode(nextMode);
				return;
			}
			controller.cycleToolHistoryViewMode();
		},
	});

	pi.registerCommand("activity-block-thinking", {
		description: "Toggle the current thinking view inside activity blocks. Use expand or collapse to set an explicit state.",
		handler: async (args, ctx) => {
			if (!controller.hasBlocks()) {
				ctx.ui.notify("No activity block to expand.", "info");
				return;
			}
			controller.toggleThinkingExpanded(parseExpandCommand(args));
		},
	});

	pi.registerShortcut(BLOCK_TOGGLE_SHORTCUT, {
		description: "Cycle activity block tool history view",
		handler: async () => {
			controller.cycleToolHistoryViewMode();
		},
	});

	pi.registerShortcut(THINKING_TOGGLE_SHORTCUT, {
		description: "Toggle the current thinking view inside activity blocks",
		handler: async () => {
			if (!controller.hasBlocks()) return;
			controller.toggleThinkingExpanded();
		},
	});

	pi.registerShortcut(ZEN_MODE_TOGGLE_SHORTCUT, {
		description: "Toggle activity block zen mode",
		handler: async (ctx) => {
			const enabled = controller.setZenMode(!controller.isZenMode());
			ctx.ui.notify(enabled ? ZEN_ON_MESSAGE : ZEN_OFF_MESSAGE, "info");
		},
	});
}
