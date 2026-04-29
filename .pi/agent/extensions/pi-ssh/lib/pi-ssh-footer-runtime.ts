type PiSshFooterSnapshot = {
  remoteDisplayTarget: string;
  remoteHome: string;
  remoteCwd: string;
};

type PiSshFooterStore = {
  snapshot: PiSshFooterSnapshot | null;
  listeners: Set<() => void>;
};

const STORE_KEY = "__PI_SSH_FOOTER_RUNTIME__";
const REMOTE_FOOTER_ICON = "";

function getStore(): PiSshFooterStore {
  const g = globalThis as Record<string, unknown>;
  const existing = g[STORE_KEY];
  if (existing && typeof existing === "object") {
    return existing as PiSshFooterStore;
  }

  const created: PiSshFooterStore = {
    snapshot: null,
    listeners: new Set(),
  };
  g[STORE_KEY] = created;
  return created;
}

function cloneSnapshot(snapshot: PiSshFooterSnapshot): PiSshFooterSnapshot {
  return {
    remoteDisplayTarget: String(snapshot.remoteDisplayTarget ?? "").trim(),
    remoteHome: String(snapshot.remoteHome ?? "").trim(),
    remoteCwd: String(snapshot.remoteCwd ?? "").trim(),
  };
}

export function getPiSshFooterSnapshot(): PiSshFooterSnapshot | null {
  const snapshot = getStore().snapshot;
  return snapshot ? cloneSnapshot(snapshot) : null;
}

export function setPiSshFooterSnapshot(snapshot: PiSshFooterSnapshot): void {
  const store = getStore();
  store.snapshot = cloneSnapshot(snapshot);
  for (const listener of store.listeners) listener();
}

export function clearPiSshFooterSnapshot(): void {
  const store = getStore();
  store.snapshot = null;
  for (const listener of store.listeners) listener();
}

export function subscribePiSshFooterSnapshot(listener: () => void): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function formatDisplayPath(path: string, home: string): string {
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export function buildPiSshFooterLabel(
  snapshot: PiSshFooterSnapshot,
  sessionName: string | null | undefined,
): string {
  let location = formatDisplayPath(snapshot.remoteCwd, snapshot.remoteHome);
  if (sessionName) {
    location = `${location} • ${sessionName}`;
  }
  return `${REMOTE_FOOTER_ICON} ${snapshot.remoteDisplayTarget}:${location}`;
}

export function __resetPiSshFooterRuntimeForTests(): void {
  const store = getStore();
  store.snapshot = null;
  store.listeners.clear();
}
