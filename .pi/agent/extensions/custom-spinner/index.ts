// @lat: [[extensions#Working spinner customization]]

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WORKING_MESSAGE = "Cooking...";

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

function applyWorkingMessage(ctx: UiContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWorkingMessage(WORKING_MESSAGE);
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applyWorkingMessage(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applyWorkingMessage(ctx);
  });
}
