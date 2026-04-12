import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@mariozechner/pi-coding-agent";

type GlobalState = Record<string, unknown>;
const PROVIDERS_KEY = "__PI_SKILL_URI_BACKEND_PROVIDERS__";

export interface SkillStageTransport {
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>;
  writeFile(path: string, content: Buffer, signal?: AbortSignal): Promise<void>;
}

export interface SkillUriBackendRemoteContext {
  remoteHome: string;
  transport: SkillStageTransport;
}

export interface SkillUriBackendProvider {
  key: string;
  isActive(): boolean;
  createReadOps(signal?: AbortSignal): ReadOperations;
  createWriteOps(signal?: AbortSignal): WriteOperations;
  createEditOps(signal?: AbortSignal): EditOperations;
  createBashOps(): BashOperations;
  getRemoteContext(signal?: AbortSignal): SkillUriBackendRemoteContext | null;
}

function getGlobalState(): GlobalState {
  return globalThis as GlobalState;
}

function getProviders(): Map<string, SkillUriBackendProvider> {
  const state = getGlobalState();
  const existing = state[PROVIDERS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, SkillUriBackendProvider>;
  }

  const created = new Map<string, SkillUriBackendProvider>();
  state[PROVIDERS_KEY] = created;
  return created;
}

export function registerSkillUriBackendProvider(provider: SkillUriBackendProvider): void {
  getProviders().set(provider.key, provider);
}

export function unregisterSkillUriBackendProvider(key: string): void {
  getProviders().delete(key);
}

export function getActiveSkillUriBackend(): SkillUriBackendProvider | null {
  const providers = Array.from(getProviders().values());
  for (let index = providers.length - 1; index >= 0; index -= 1) {
    const provider = providers[index];
    if (provider?.isActive()) {
      return provider;
    }
  }
  return null;
}

export function __resetSkillUriBackendProvidersForTests(): void {
  getProviders().clear();
}
