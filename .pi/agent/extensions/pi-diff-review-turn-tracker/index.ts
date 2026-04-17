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

    skipCurrentTurn = false;
    tracker.startTurn({
      sessionId,
      turnId: pendingTurnId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      cwd: ctx.cwd,
      requireSsh: Boolean(activeSession),
      sshResolver: activeSession
        ? async () => {
          const sshIdentity = await resolveDiffReviewSshIdentity(ctx.cwd).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[pi-diff-review-turn-tracker] ssh session repo root failed: ${message}`);
            return null;
          });
          if (!sshIdentity) {
            return null;
          }
          return {
            session: sshIdentity.session,
            repoRoot: sshIdentity.repoRoot,
            scopeKey: sshIdentity.scopeKey,
          };
        }
        : undefined,
    });
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      if (!skipCurrentTurn) {
        await tracker.finalize(ctx.cwd);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pi-diff-review-turn-tracker] finalize failed: ${message}`);
      tracker.reset();
    } finally {
      pendingTurnId = null;
      skipCurrentTurn = false;
    }
  });
}
