import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";
import { buildFooterLines, type QueuedInput } from "./pi-instance-manager-queue.ts";
import {
  deriveManagerStatusMode,
  isSessionEffectivelyCompacting,
  lockHeldByOtherSessionToken,
} from "./pi-instance-manager-status.ts";
import {
  ensureManagerSpinnerStatus,
  instanceManagerStatusLine,
  type ManagerStatusMode,
  type SpinnerState,
} from "./pi-instance-manager-ui.ts";

export type FooterStatusInput = {
  currentSessionId: string;
  managerCompactingThisSession: boolean;
  localCompactingUntil: number;
  localCompactingSessionId: string;
  managerUnavailableError: string;
  managerDownSince: number;
  awaitingTurnEnd: boolean;
  activeTurnLockSessionId: string;
  managerLockToken: string;
  activeTurnLockToken: string;
  queueDrainInFlight: boolean;
  remoteDiscordQueueDepth: number;
  localQueueDepth: number;
  nowMs: number;
};

export function computeFooterStatusMode(input: FooterStatusInput): ManagerStatusMode {
  const sid = asString(input.currentSessionId).trim();
  if (!sid) return "idle";

  const effectiveCompacting = isSessionEffectivelyCompacting({
    sessionId: sid,
    managerCompactingThisSession: input.managerCompactingThisSession,
    localCompactingUntil: input.localCompactingUntil,
    localCompactingSessionId: input.localCompactingSessionId,
    nowMs: input.nowMs,
  });

  const lockHeldByOther = lockHeldByOtherSessionToken(asString(input.managerLockToken).trim(), input.activeTurnLockToken);

  return deriveManagerStatusMode({
    currentSessionId: sid,
    effectiveCompacting,
    managerUnavailableError: input.managerUnavailableError,
    managerDownSince: input.managerDownSince,
    awaitingTurnEnd: input.awaitingTurnEnd,
    activeTurnLockSessionId: input.activeTurnLockSessionId,
    lockHeldByOther,
    queueDrainInFlight: input.queueDrainInFlight,
    remoteDiscordQueueDepth: input.remoteDiscordQueueDepth,
    localQueueDepth: input.localQueueDepth,
    nowMs: input.nowMs,
  });
}

export function applyFooterStatus({
  ctx,
  spinner,
  queued,
  managerLockOwner,
  managerUnavailableError,
  remoteDiscordQueueDepth,
  statusInput,
}: {
  ctx: ExtensionContext;
  spinner: SpinnerState;
  queued: QueuedInput[];
  managerLockOwner: string;
  managerUnavailableError: string;
  remoteDiscordQueueDepth: number;
  statusInput: FooterStatusInput;
}) {
  if (!ctx.hasUI) return;

  const mode = computeFooterStatusMode(statusInput);
  const owner = asString(managerLockOwner).trim();
  const lines = buildFooterLines({
    mode,
    queued,
    owner,
    managerError: managerUnavailableError,
    remoteDiscordQueueDepth,
  });

  const totalQueued = queued.length + Math.max(0, Number(remoteDiscordQueueDepth || 0));
  ctx.ui.setStatus("pi-instance-manager", instanceManagerStatusLine(mode, owner, totalQueued));

  if (lines.length > 0) {
    ctx.ui.setWidget("pi-compact-help", lines, { placement: "belowEditor" });
  } else {
    ctx.ui.setWidget("pi-compact-help", undefined, { placement: "belowEditor" });
  }

  ensureManagerSpinnerStatus(ctx, mode, totalQueued, spinner);
}
