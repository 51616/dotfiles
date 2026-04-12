import type { ManagerStatusMode } from "./pi-instance-manager-ui.ts";

export function lockHeldByOtherSessionToken(managerLockToken: unknown, activeTurnLockToken: unknown): boolean {
  const managerToken = String(managerLockToken || "").trim();
  if (!managerToken) return false;
  const activeToken = String(activeTurnLockToken || "").trim();
  return managerToken !== activeToken;
}

export function isSessionEffectivelyCompacting({
  sessionId,
  managerCompactingThisSession,
  localCompactingUntil,
  localCompactingSessionId,
  nowMs,
}: {
  sessionId: string;
  managerCompactingThisSession: boolean;
  localCompactingUntil: number;
  localCompactingSessionId: string;
  nowMs: number;
}): boolean {
  const sid = String(sessionId || "").trim();
  if (!sid) return false;

  const localSid = String(localCompactingSessionId || "").trim();
  const localCompacting =
    localCompactingUntil > 0 &&
    nowMs < localCompactingUntil &&
    !!localSid &&
    localSid === sid;

  return localCompacting || managerCompactingThisSession;
}

export function deriveManagerStatusMode({
  currentSessionId,
  effectiveCompacting,
  managerUnavailableError,
  managerDownSince,
  awaitingTurnEnd,
  activeTurnLockSessionId,
  lockHeldByOther,
  queueDrainInFlight,
  remoteDiscordQueueDepth,
  localQueueDepth,
  nowMs,
}: {
  currentSessionId: string;
  effectiveCompacting: boolean;
  managerUnavailableError: string;
  managerDownSince: number;
  awaitingTurnEnd: boolean;
  activeTurnLockSessionId: string;
  lockHeldByOther: boolean;
  queueDrainInFlight: boolean;
  remoteDiscordQueueDepth: number;
  localQueueDepth: number;
  nowMs: number;
}): ManagerStatusMode {
  if (effectiveCompacting) return "compacting";
  if (managerUnavailableError && managerDownSince > 0 && nowMs - managerDownSince >= 1200) return "manager_down";
  if (awaitingTurnEnd && activeTurnLockSessionId === currentSessionId) return "in_turn";
  if (lockHeldByOther || queueDrainInFlight || remoteDiscordQueueDepth > 0 || localQueueDepth > 0) {
    return "waiting_lock";
  }
  return "idle";
}
