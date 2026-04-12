import { asString, type ManagerLock, type ManagerState } from "./pi-instance-manager-common.ts";

export function isSessionCompacting(state: ManagerState | null | undefined, sessionId: string): boolean {
  const sid = asString(sessionId).trim();
  if (!sid) return false;
  if (!state || !Array.isArray(state.activeCompactions)) return false;
  return state.activeCompactions.some((row) => asString((row as any)?.sessionId).trim() === sid);
}

export function findSessionLock(state: ManagerState | null | undefined, sessionId: string): ManagerLock | null {
  const sid = asString(sessionId).trim();
  if (!sid) return null;
  if (!state || !Array.isArray(state.activeLocks)) return null;
  return (state.activeLocks.find((lock) => asString((lock as any)?.sessionId).trim() === sid) ?? null) as ManagerLock | null;
}

export function toLocalTicketIdSet(items: Array<{ ticketId?: string }>): Set<string> {
  return new Set(items.map((row) => asString(row?.ticketId).trim()).filter(Boolean));
}

export function countRemoteQueuedTurns(
  state: ManagerState | null | undefined,
  sessionId: string,
  localTicketIds: Set<string>,
): number {
  const sid = asString(sessionId).trim();
  if (!sid) return 0;
  if (!state || !Array.isArray((state as any).turnQueues)) return 0;

  const row = (state as any).turnQueues.find((q: any) => asString(q?.sessionId).trim() === sid);
  const items = Array.isArray(row?.items) ? row.items : [];

  const remoteQueued = items.filter((item: any) => {
    const ticketId = asString(item?.ticketId).trim();
    const status = asString(item?.state).trim();
    if (status !== "queued") return false;
    if (!ticketId) return false;
    return !localTicketIds.has(ticketId);
  }).length;

  return Math.max(0, remoteQueued);
}
