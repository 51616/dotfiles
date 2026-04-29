import {
  asString,
  type ManagerLock,
  type ManagerState,
  type ManagerTurnItem,
} from "./pi-instance-manager-common.ts";

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

export function getSessionTurnItems(state: ManagerState | null | undefined, sessionId: string): ManagerTurnItem[] {
  const sid = asString(sessionId).trim();
  if (!sid) return [];
  if (!state || !Array.isArray((state as any).turnQueues)) return [];

  const row = (state as any).turnQueues.find((q: any) => asString(q?.sessionId).trim() === sid);
  return Array.isArray(row?.items) ? (row.items as ManagerTurnItem[]) : [];
}

export function toLocalTicketIdSet(items: Array<{ ticketId?: string }>): Set<string> {
  return new Set(items.map((row) => asString(row?.ticketId).trim()).filter(Boolean));
}

export function isDiscordTurnOwner(owner: unknown): boolean {
  return /^pi-discord-bot:/.test(asString(owner).trim());
}

export function isTuiTurnOwner(owner: unknown): boolean {
  return /^pi-tui:/.test(asString(owner).trim());
}

export function ownerPid(owner: unknown): number {
  const match = asString(owner).trim().match(/(?:^|:)pid=(\d+)(?::|$)/);
  if (!match) return 0;
  const pid = Math.trunc(Number(match[1]));
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

export function countRemoteQueuedTurns(
  state: ManagerState | null | undefined,
  sessionId: string,
  localTicketIds: Set<string>,
): number {
  const items = getSessionTurnItems(state, sessionId);

  const remoteQueued = items.filter((item: ManagerTurnItem) => {
    const ticketId = asString(item?.ticketId).trim();
    const status = asString(item?.state).trim();
    if (status !== "queued") return false;
    if (!ticketId) return false;
    if (localTicketIds.has(ticketId)) return false;
    return isDiscordTurnOwner(item?.owner);
  }).length;

  return Math.max(0, remoteQueued);
}
