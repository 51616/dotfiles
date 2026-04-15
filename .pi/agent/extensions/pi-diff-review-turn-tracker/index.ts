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

export default function piDiffReviewTurnTracker(_pi: ExtensionAPI) {
  // Temporarily disabled while investigating SSH session stalls during agent startup.
  // Keep the extension entrypoint present so reload/discovery remain stable.
  return;
}
