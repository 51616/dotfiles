export type DoNotStopRuntimeSnapshot = {
  enabled: boolean;
  repeatTarget: number;
  pendingRepeats: number;
  completedRepeats: number;
};

type DoNotStopRuntimeStore = {
  bySession: Record<string, DoNotStopRuntimeSnapshot>;
  lastActive: DoNotStopRuntimeSnapshot | null;
};

const STORE_KEY = "__PI_DO_NOT_STOP_RUNTIME__";

function getStore(): DoNotStopRuntimeStore {
  const g = globalThis as Record<string, unknown>;
  const existing = g[STORE_KEY];
  if (existing && typeof existing === "object") {
    return existing as DoNotStopRuntimeStore;
  }

  const created: DoNotStopRuntimeStore = {
    bySession: {},
    lastActive: null,
  };
  g[STORE_KEY] = created;
  return created;
}

function cloneSnapshot(snapshot: DoNotStopRuntimeSnapshot): DoNotStopRuntimeSnapshot {
  return {
    enabled: Boolean(snapshot.enabled),
    repeatTarget: Number(snapshot.repeatTarget),
    pendingRepeats: Number(snapshot.pendingRepeats),
    completedRepeats: Number(snapshot.completedRepeats),
  };
}

export function getLastActiveDoNotStopSnapshot(): DoNotStopRuntimeSnapshot | null {
  const last = getStore().lastActive;
  return last ? cloneSnapshot(last) : null;
}

export function getDoNotStopSnapshotForSession(sessionId: string): DoNotStopRuntimeSnapshot | null {
  const key = String(sessionId ?? "").trim();
  if (!key) return null;

  const snapshot = getStore().bySession[key];
  return snapshot ? cloneSnapshot(snapshot) : null;
}

export function saveDoNotStopSnapshot(sessionId: string | null | undefined, snapshot: DoNotStopRuntimeSnapshot): void {
  const store = getStore();
  const cloned = cloneSnapshot(snapshot);

  store.lastActive = cloned;

  const key = String(sessionId ?? "").trim();
  if (!key) return;

  store.bySession[key] = cloned;
}

export function __resetDoNotStopRuntimeStoreForTests(): void {
  const store = getStore();
  store.lastActive = null;
  store.bySession = {};
}
