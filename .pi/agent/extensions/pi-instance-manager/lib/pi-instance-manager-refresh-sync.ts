import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerLock } from "./pi-instance-manager-common.ts";
import { noteSessionFileMutation, maybeRunPendingSessionResync, type SessionResyncState } from "./pi-instance-manager-resync.ts";
import { maybeResumeAfterDiscordTurn } from "./pi-instance-manager-session-sync.ts";
import { isDiscordPromptOwner } from "./pi-instance-manager-ui.ts";

export async function syncSessionResyncAfterStateRefresh({
  ctx,
  sid,
  previousLock,
  nextLock,
  sessionResync,
  lastLocalSubmitAt,
  externalWriteExpectedUntil,
  setExternalWriteExpectedUntil,
  activeTurnLockToken,
  activeTurnLockSessionId,
  queueDrainInFlight,
  queueDepth,
  compacting,
  hasActiveSessionLock,
}: {
  ctx: ExtensionContext | null;
  sid: string;
  previousLock: ManagerLock | null;
  nextLock: ManagerLock | null;
  sessionResync: SessionResyncState;
  lastLocalSubmitAt: number;
  externalWriteExpectedUntil: number;
  setExternalWriteExpectedUntil: (value: number) => void;
  activeTurnLockToken: string;
  activeTurnLockSessionId: string;
  queueDrainInFlight: boolean;
  queueDepth: number;
  compacting: boolean;
  hasActiveSessionLock: boolean;
}) {
  const previousLockOwner = asString(previousLock?.owner).trim();
  const nextLockOwner = asString(nextLock?.owner).trim();
  const sawDiscordLock =
    (previousLockOwner && isDiscordPromptOwner(previousLockOwner)) ||
    (nextLockOwner && isDiscordPromptOwner(nextLockOwner));

  if (sawDiscordLock) {
    setExternalWriteExpectedUntil(Math.max(externalWriteExpectedUntil, Date.now() + 6000));
  }

  // IMPORTANT: only trigger session resync based on *external* writers (primarily Discord headless turns).
  // Local TUI actions like `/model` can mutate the session file too, and resyncing on those is noisy
  // (it can spam “Resumed session …” and overwrite command feedback).
  const inExternalWriteWindow = Date.now() < externalWriteExpectedUntil;
  const forcePendingResync = inExternalWriteWindow;

  if (sawDiscordLock || inExternalWriteWindow) {
    noteSessionFileMutation(sessionResync, lastLocalSubmitAt, forcePendingResync);
    if (sessionResync.pendingSessionResync) {
      setExternalWriteExpectedUntil(0);
    }
  }

  if (ctx && sid) {
    await maybeResumeAfterDiscordTurn({
      ctx,
      sessionFilePath: sessionResync.trackedSessionFile || sessionResync.currentSessionFile,
      previousLock,
      nextLock,
      hasLocalTurnLock: Boolean(activeTurnLockToken && activeTurnLockSessionId === sid),
      hasPendingQueue: Boolean(queueDrainInFlight || queueDepth > 0),
      compacting,
    });
  }

  if (ctx) {
    await maybeRunPendingSessionResync({
      state: sessionResync,
      ctx,
      currentSessionId: sid,
      activeTurnLockToken,
      activeTurnLockSessionId,
      queueDepth: queueDrainInFlight ? 1 : queueDepth,
      compacting,
      hasActiveSessionLock,
    });
  }
}
