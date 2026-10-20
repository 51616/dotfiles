// @lat: [[activity-block#Transcript ownership on pi 1.3]]
// Hides pi's built-in tool rows while the activity block owns tool activity.

import type { ExtensionAPI, ToolRenderers } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";

/** Zero-height component. pi's ToolExecutionComponent renders `[]` for a self-shelled row with no lines. */
class EmptyComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

const EMPTY_COMPONENT = new EmptyComponent();

/**
 * Renderers that make a tool row draw nothing.
 *
 * `renderShell: "self"` removes pi's padded/background shell and its leading spacer, and empty call/result
 * components make the row's self-rendered content empty, so `ToolExecutionComponent.render()` returns `[]`.
 * Image blocks in tool results are drawn by pi outside the renderer and stay visible.
 */
export const HIDDEN_TOOL_ROW_RENDERERS: ToolRenderers = {
	renderShell: "self",
	renderCall: () => EMPTY_COMPONENT,
	renderResult: () => EMPTY_COMPONENT,
};

/**
 * Register a resolver that hides every tool row while `shouldHide()` is true.
 *
 * pi resolves renderers when it creates a row (live streaming, tool start, and transcript replay), so a mode
 * change applies to rows created afterwards. Existing rows keep their renderer until the chat is rebuilt.
 */
export function registerHiddenToolRows(pi: Pick<ExtensionAPI, "registerToolRenderer">, shouldHide: () => boolean): void {
	pi.registerToolRenderer((_toolName, next) => (shouldHide() ? HIDDEN_TOOL_ROW_RENDERERS : next()));
}
