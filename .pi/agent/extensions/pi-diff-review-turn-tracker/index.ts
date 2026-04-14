// @lat: [[pi-diff-review-turn-tracker#Pi diff review turn tracker]]

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewTurnTracker } from "./lib/tracker.ts";
import { resolveDiffReviewSshIdentity } from "../lib/pi-diff-review-ssh.ts";
import { getActivePiSshSession } from "../pi-ssh/lib/pi-ssh-session-runtime.ts";

function turnIdFromInput(text: string): string {
  const discord = text.match(/^\[from discord\][^\n]*\bmsg_id=([^\s]+)/m);
  if (discord?.[1]) return discord[1];
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function piDiffReviewTurnTracker(pi: ExtensionAPI) {
  const tracker = new DiffReviewTurnTracker({ enableAgentChangeReport: false });
  let pendingTurnId: string | null = null;

  let skipCurrentTurn = false;

  const reset = () => {
    pendingTurnId = null;
    skipCurrentTurn = false;
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
    const activeSession = getActivePiSshSession();

    if (activeSession) {
      const sshIdentity = await resolveDiffReviewSshIdentity(ctx.cwd).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-diff-review-turn-tracker] ssh session repo root failed: ${message}`);
        return null;
      });
      if (!sshIdentity) {
        skipCurrentTurn = true;
        tracker.reset();
        return;
      }

      skipCurrentTurn = false;
      tracker.startTurn({
        sessionId,
        turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        cwd: ctx.cwd,
        ssh: {
          session: sshIdentity.session,
          repoRoot: sshIdentity.repoRoot,
          scopeKey: sshIdentity.scopeKey,
        },
      });
      return;
    }

    skipCurrentTurn = false;
    tracker.startTurn({
      sessionId,
      turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      cwd: ctx.cwd,
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (skipCurrentTurn) {
      return;
    }
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
    if (!skipCurrentTurn) {
      await tracker.finalize(ctx.cwd);
    }
    pendingTurnId = null;
    skipCurrentTurn = false;
  });
}
