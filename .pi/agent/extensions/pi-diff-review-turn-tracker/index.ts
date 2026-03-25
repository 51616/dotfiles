import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewTurnTracker } from "./lib/tracker.ts";

function turnIdFromInput(text: string): string {
  const discord = text.match(/^\[from discord\][^\n]*\bmsg_id=([^\s]+)/m);
  if (discord?.[1]) return discord[1];
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function piDiffReviewTurnTracker(pi: ExtensionAPI) {
  const tracker = new DiffReviewTurnTracker();
  let pendingTurnId: string | null = null;

  const reset = () => {
    pendingTurnId = null;
    tracker.reset();
  };

  pi.on("session_start", reset);
  pi.on("session_switch", reset);
  pi.on("session_shutdown", reset);

  pi.on("input", async (event) => {
    pendingTurnId = turnIdFromInput(event.text);
    return { action: "continue" };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const sessionId = String(ctx.sessionManager.getSessionId() ?? "").trim();
    tracker.startTurn({
      sessionId,
      turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      cwd: ctx.cwd,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const filePath = typeof event.input?.path === "string" ? event.input.path : "";
      if (filePath) tracker.touchPath(filePath, ctx.cwd);
      return;
    }
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      tracker.recordBash(command, ctx.cwd);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    tracker.finalize(ctx.cwd);
    pendingTurnId = null;
  });
}
