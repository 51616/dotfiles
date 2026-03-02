export type QueuedInput = {
  ticketId: string;
  text: string;
  queuedAt: number;
  owner?: string;
};

export class SessionInputQueue {
  #bySession = new Map<string, QueuedInput[]>();

  #normalizeSessionId(sessionId: string): string {
    return String(sessionId || "").trim();
  }

  #normalizeTicketId(ticketId: string): string {
    return String(ticketId || "").trim();
  }

  #normalizeItem(item: QueuedInput): QueuedInput | null {
    const ticketId = this.#normalizeTicketId(item?.ticketId || "");
    if (!ticketId) return null;

    const queuedAtRaw = Number(item?.queuedAt);
    return {
      ticketId,
      text: String(item?.text || ""),
      queuedAt: Number.isFinite(queuedAtRaw) ? queuedAtRaw : Date.now(),
      owner: item?.owner,
    };
  }

  #dedupeItems(items: QueuedInput[]): QueuedInput[] {
    const out: QueuedInput[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const normalized = this.#normalizeItem(item);
      if (!normalized) continue;
      if (seen.has(normalized.ticketId)) continue;
      seen.add(normalized.ticketId);
      out.push(normalized);
    }
    return out;
  }

  list(sessionId: string): QueuedInput[] {
    const sid = this.#normalizeSessionId(sessionId);
    if (!sid) return [];
    const items = this.#bySession.get(sid) ?? [];
    return items.slice();
  }

  enqueue(sessionId: string, item: QueuedInput): number {
    const sid = this.#normalizeSessionId(sessionId);
    if (!sid) return 0;

    const normalized = this.#normalizeItem(item);
    const current = this.#bySession.get(sid) ?? [];
    if (!normalized) return current.length;

    const next = current.filter((row) => this.#normalizeTicketId(row.ticketId) !== normalized.ticketId).concat(normalized);
    this.#bySession.set(sid, next);
    return next.length;
  }

  shift(sessionId: string): QueuedInput | null {
    const sid = this.#normalizeSessionId(sessionId);
    if (!sid) return null;
    const q = this.#bySession.get(sid) ?? [];
    if (q.length === 0) return null;
    const [first, ...rest] = q;
    if (rest.length === 0) this.#bySession.delete(sid);
    else this.#bySession.set(sid, rest);
    return first;
  }

  unshift(sessionId: string, item: QueuedInput) {
    const sid = this.#normalizeSessionId(sessionId);
    if (!sid) return;

    const normalized = this.#normalizeItem(item);
    const current = this.#bySession.get(sid) ?? [];
    if (!normalized) return;

    const next = [normalized, ...current.filter((row) => this.#normalizeTicketId(row.ticketId) !== normalized.ticketId)];
    this.#bySession.set(sid, next);
  }

  removeByTicket(sessionId: string, ticketId: string): QueuedInput | null {
    const sid = this.#normalizeSessionId(sessionId);
    const tid = this.#normalizeTicketId(ticketId || "");
    if (!sid || !tid) return null;
    const q = this.#bySession.get(sid) ?? [];
    const idx = q.findIndex((it) => this.#normalizeTicketId(it.ticketId) === tid);
    if (idx < 0) return null;

    const removed = q[idx] ?? null;
    const next = q.slice(0, idx).concat(q.slice(idx + 1));
    if (next.length === 0) this.#bySession.delete(sid);
    else this.#bySession.set(sid, next);
    return removed;
  }

  replace(sessionId: string, items: QueuedInput[]) {
    const sid = this.#normalizeSessionId(sessionId);
    if (!sid) return;
    const next = this.#dedupeItems(Array.isArray(items) ? items : []);
    if (next.length === 0) {
      this.#bySession.delete(sid);
      return;
    }
    this.#bySession.set(sid, next);
  }
}

export function truncateOneLine(text: string, max = 80): string {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`;
}

export function buildFooterLines({
  mode,
  queued,
  owner,
  managerError,
  remoteDiscordQueueDepth,
}: {
  mode: "idle" | "compacting" | "waiting_lock" | "in_turn" | "manager_down";
  queued: QueuedInput[];
  owner: string;
  managerError: string;
  remoteDiscordQueueDepth: number;
}): string[] {
  const lines: string[] = [];

  if (mode === "compacting") {
    lines.push("| Compaction is active for this session.");
  }

  if (mode === "in_turn") {
    lines.push("| A turn is in progress for this session.");
  }

  if (mode === "waiting_lock") {
    lines.push(`| Conversation lock active${owner ? ` (owner: ${owner})` : ""}.`);
  }

  if (mode === "manager_down") {
    lines.push(`| Instance manager unavailable: ${truncateOneLine(managerError, 100)}`);
    lines.push("| Fail-closed: new sends are paused until manager recovers.");
  }

  if (remoteDiscordQueueDepth > 0) {
    lines.push(`| Pending (Discord): ${remoteDiscordQueueDepth} message${remoteDiscordQueueDepth === 1 ? "" : "s"}.`);
  }

  if (queued.length > 0) {
    lines.push(`| Pending (TUI): ${queued.length} message${queued.length === 1 ? "" : "s"}.`);
    for (const item of queued.slice(-2)) {
      lines.push(`|   • ${truncateOneLine(item.text)}`);
    }
    lines.push("| Queue will auto-flush in shared lock order.");
  }

  return lines;
}
