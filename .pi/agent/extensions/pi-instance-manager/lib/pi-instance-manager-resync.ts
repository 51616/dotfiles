import fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";

export type SessionResyncState = {
  trackedSessionFile: string;
  currentSessionFile: string;
  trackedSessionFileMtimeMs: number;
  trackedSessionFileSizeBytes: number;
  pendingSessionResync: boolean;
  lastSessionResyncAt: number;
};

export function createSessionResyncState(): SessionResyncState {
  return {
    trackedSessionFile: "",
    currentSessionFile: "",
    trackedSessionFileMtimeMs: 0,
    trackedSessionFileSizeBytes: 0,
    pendingSessionResync: false,
    lastSessionResyncAt: 0,
  };
}

export function refreshTrackedSessionFile(state: SessionResyncState, ctx: ExtensionContext) {
  state.trackedSessionFile = asString(ctx.sessionManager.getSessionFile()).trim();
  state.currentSessionFile = state.trackedSessionFile;

  if (!state.trackedSessionFile) {
    state.trackedSessionFileMtimeMs = 0;
    state.trackedSessionFileSizeBytes = 0;
    state.pendingSessionResync = false;
    return;
  }

  try {
    const stat = fs.statSync(state.trackedSessionFile);
    state.trackedSessionFileMtimeMs = stat.mtimeMs;
    state.trackedSessionFileSizeBytes = stat.size;
  } catch {
    state.trackedSessionFileMtimeMs = 0;
    state.trackedSessionFileSizeBytes = 0;
  }
}

export function noteSessionFileMutation(
  state: SessionResyncState,
  lastLocalSubmitAt: number,
  forcePendingResync = false,
) {
  if (!state.trackedSessionFile) return;

  try {
    const stat = fs.statSync(state.trackedSessionFile);
    const nextMtime = stat.mtimeMs;
    const nextSize = stat.size;
    const changed = nextMtime > state.trackedSessionFileMtimeMs || nextSize !== state.trackedSessionFileSizeBytes;
    if (changed) {
      state.trackedSessionFileMtimeMs = nextMtime;
      state.trackedSessionFileSizeBytes = nextSize;
      if (forcePendingResync || Date.now() - lastLocalSubmitAt > 1200) {
        state.pendingSessionResync = true;
      }
    }
  } catch {
    // ignore stat races
  }
}

export async function maybeRunPendingSessionResync({
  state,
  ctx,
  currentSessionId,
  activeTurnLockToken,
  activeTurnLockSessionId,
  queueDepth,
  compacting,
  hasActiveSessionLock,
}: {
  state: SessionResyncState;
  ctx: ExtensionContext;
  currentSessionId: string;
  activeTurnLockToken: string;
  activeTurnLockSessionId: string;
  queueDepth: number;
  compacting: boolean;
  hasActiveSessionLock: boolean;
}) {
  if (!state.pendingSessionResync) return;
  if (!currentSessionId) return;

  const sessionPath = state.trackedSessionFile || state.currentSessionFile;
  if (!sessionPath) return;

  if (Date.now() - state.lastSessionResyncAt < 1500) return;
  if (activeTurnLockToken && activeTurnLockSessionId === currentSessionId) return;
  if (hasActiveSessionLock) return;
  if (queueDepth > 0) return;
  if (compacting) return;
  if (!ctx.isIdle()) return;

  state.pendingSessionResync = false;
  state.lastSessionResyncAt = Date.now();

  try {
    await ctx.switchSession(sessionPath);
    refreshTrackedSessionFile(state, ctx);
  } catch {
    state.pendingSessionResync = true;
  }
}

export function clearSessionResyncState(state: SessionResyncState) {
  state.trackedSessionFile = "";
  state.currentSessionFile = "";
  state.trackedSessionFileMtimeMs = 0;
  state.trackedSessionFileSizeBytes = 0;
  state.pendingSessionResync = false;
}
