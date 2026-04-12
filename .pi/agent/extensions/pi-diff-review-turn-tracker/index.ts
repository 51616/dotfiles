// @lat: [[pi-diff-review-turn-tracker#Pi diff review turn tracker]]

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewTurnTracker } from "./lib/tracker.ts";
import { getSharedSshHelperClient, makeSshScopeKey } from "../lib/diff-review-ssh-helper/client.ts";

function turnIdFromInput(text: string): string {
  const discord = text.match(/^\[from discord\][^\n]*\bmsg_id=([^\s]+)/m);
  if (discord?.[1]) return discord[1];
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function piDiffReviewTurnTracker(pi: ExtensionAPI) {
  const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
  let pendingTurnId: string | null = null;

  const reset = () => {
    pendingTurnId = null;
    tracker.reset();
  };

  // session_start covers startup, reload, new, resume, and fork in pi-mono v0.65.0+
  // so the old session_switch hook is unnecessary and blocks type-clean upgrades.
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("input", async (event) => {
    pendingTurnId = turnIdFromInput(event.text);
    return { action: "continue" };
  });

  pi.on("agent_start", async (_event, ctx) => {
    const sessionId = String(ctx.sessionManager.getSessionId() ?? "").trim();

    const helper = await getSharedSshHelperClient(pi);
    if (helper) {
      try {
        const repoRoot = await helper.repoRoot(helper.probe.remote_cwd);
        const scopeKey = makeSshScopeKey(helper.target, repoRoot);
        tracker.startTurn({
          sessionId,
          turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          cwd: ctx.cwd,
          ssh: { helper, repoRoot, scopeKey },
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-diff-review-turn-tracker] ssh helper repo.root failed: ${message}`);
      }
    }

    tracker.startTurn({
      sessionId,
      turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      cwd: ctx.cwd,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      const filePath = typeof event.input?.path === "string" ? event.input.path : "";
      if (filePath) await tracker.touchPath(filePath, ctx.cwd);
      return;
    }
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (command) await tracker.recordBash(command, ctx.cwd);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await tracker.finalize(ctx.cwd);
    pendingTurnId = null;
  });
}
