import {
  clearPublishedPiSshSession,
  getActivePiSshSession,
  type PiSshSession,
} from "./pi-ssh-session-runtime.ts";

const REUSABLE_RUNTIME_KEY = "__PI_SSH_REUSABLE_RUNTIME__";

type GlobalState = Record<string, unknown>;

export type ReusablePiSshShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface DisposablePiSshTransport {
  dispose(): Promise<void>;
}

export interface ReusablePiSshRuntime<
  TConnection,
  TTransport extends DisposablePiSshTransport,
  TPromptContext,
> {
  cacheKey: string;
  connection: TConnection;
  transport: TTransport;
  session: PiSshSession;
  remotePromptContext: TPromptContext;
}

type StoredReusablePiSshRuntime = ReusablePiSshRuntime<unknown, DisposablePiSshTransport, unknown>;

interface ReusablePiSshRuntimeStore {
  runtime: StoredReusablePiSshRuntime | null;
}

function getGlobalState(): GlobalState {
  return globalThis as GlobalState;
}

function getReusablePiSshRuntimeStore(): ReusablePiSshRuntimeStore {
  const state = getGlobalState();
  const existing = state[REUSABLE_RUNTIME_KEY];
  if (existing && typeof existing === "object" && "runtime" in existing) {
    return existing as ReusablePiSshRuntimeStore;
  }

  const created: ReusablePiSshRuntimeStore = { runtime: null };
  state[REUSABLE_RUNTIME_KEY] = created;
  return created;
}

async function disposeReusablePiSshRuntime(runtime: StoredReusablePiSshRuntime): Promise<void> {
  try {
    await runtime.transport.dispose();
  } finally {
    if (getActivePiSshSession() === runtime.session) {
      clearPublishedPiSshSession();
    }
  }
}

export function buildReusablePiSshRuntimeKey(input: {
  sshFlag: string;
  port: number;
  localCwd: string;
  localHome: string;
}): string {
  return JSON.stringify({
    sshFlag: input.sshFlag.trim(),
    port: input.port,
    localCwd: input.localCwd,
    localHome: input.localHome,
  });
}

export function shouldKeepReusablePiSshRuntime(reason: ReusablePiSshShutdownReason | string): boolean {
  return reason === "new" || reason === "resume" || reason === "fork";
}

export async function storeReusablePiSshRuntime<
  TConnection,
  TTransport extends DisposablePiSshTransport,
  TPromptContext,
>(runtime: ReusablePiSshRuntime<TConnection, TTransport, TPromptContext>): Promise<void> {
  const store = getReusablePiSshRuntimeStore();
  const previous = store.runtime;
  const next = runtime as StoredReusablePiSshRuntime;
  if (previous && previous !== next) {
    await disposeReusablePiSshRuntime(previous);
  }
  store.runtime = next;
}

export function takeReusablePiSshRuntime<
  TConnection,
  TTransport extends DisposablePiSshTransport,
  TPromptContext,
>(cacheKey: string): ReusablePiSshRuntime<TConnection, TTransport, TPromptContext> | null {
  const store = getReusablePiSshRuntimeStore();
  const runtime = store.runtime;
  if (!runtime || runtime.cacheKey !== cacheKey) {
    return null;
  }

  store.runtime = null;
  return runtime as ReusablePiSshRuntime<TConnection, TTransport, TPromptContext>;
}

export async function clearReusablePiSshRuntime(): Promise<void> {
  const store = getReusablePiSshRuntimeStore();
  const runtime = store.runtime;
  store.runtime = null;
  if (runtime) {
    await disposeReusablePiSshRuntime(runtime);
  }
}

export function __getReusablePiSshRuntimeForTests(): StoredReusablePiSshRuntime | null {
  return getReusablePiSshRuntimeStore().runtime;
}

export async function __resetReusablePiSshRuntimeForTests(): Promise<void> {
  await clearReusablePiSshRuntime();
}
