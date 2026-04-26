import type { AutocompleteProvider } from "@mariozechner/pi-tui";

const ACTIVE_KEY = "__PI_TUI_BROKER_ACTIVE__";
const AUTOCOMPLETE_WRAPPERS_KEY = "__PI_TUI_BROKER_AUTOCOMPLETE_WRAPPERS__";
const EDITOR_BADGES_KEY = "__PI_TUI_BROKER_EDITOR_BADGES__";
const FOOTER_PATH_PROVIDERS_KEY = "__PI_TUI_BROKER_FOOTER_PATH_PROVIDERS__";
const FOOTER_REFRESH_LISTENERS_KEY = "__PI_TUI_BROKER_FOOTER_REFRESH_LISTENERS__";
const EDITOR_REINSTALL_HANDLER_KEY = "__PI_TUI_BROKER_EDITOR_REINSTALL_HANDLER__";

export type TuiBrokerAutocompleteProviderWrapper = (provider: AutocompleteProvider) => AutocompleteProvider;
export type TuiBrokerEditorBadge = {
  text: string;
  priority?: number;
};
export type TuiBrokerFooterPathArgs = {
  sessionName: string | null | undefined;
};
export type TuiBrokerFooterPathContribution = {
  text: string;
  priority?: number;
};

type GlobalState = Record<string, unknown>;
type TuiBrokerEditorBadgeProvider = () => TuiBrokerEditorBadge | null | undefined;
type TuiBrokerFooterPathProvider = (
  args: TuiBrokerFooterPathArgs,
) => TuiBrokerFooterPathContribution | null | undefined;
type ContributionWithKey<T extends object> = T & { key: string; priority: number };

function getGlobalState(): GlobalState {
  return globalThis as GlobalState;
}

function getMap<T>(key: string): Map<string, T> {
  const state = getGlobalState();
  const existing = state[key];
  if (existing instanceof Map) {
    return existing as Map<string, T>;
  }

  const created = new Map<string, T>();
  state[key] = created;
  return created;
}

function getListeners(key: string): Set<() => void> {
  const state = getGlobalState();
  const existing = state[key];
  if (existing instanceof Set) {
    return existing as Set<() => void>;
  }

  const created = new Set<() => void>();
  state[key] = created;
  return created;
}

function normalizePriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value);
}

function sortByPriorityThenKey<T extends { key: string; priority: number }>(left: T, right: T): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.key.localeCompare(right.key);
}

function collectContributions<T extends object>(
  entries: Iterable<[string, () => T | null | undefined]>,
): ContributionWithKey<T>[] {
  const resolved: ContributionWithKey<T>[] = [];

  for (const [key, provider] of entries) {
    const value = provider();
    if (!value) continue;
    resolved.push({
      ...value,
      key,
      priority: normalizePriority((value as { priority?: number }).priority),
    });
  }

  return resolved.sort(sortByPriorityThenKey);
}

export function markTuiBrokerInstalled(): void {
  getGlobalState()[ACTIVE_KEY] = true;
}

export function isTuiBrokerInstalled(): boolean {
  return getGlobalState()[ACTIVE_KEY] === true;
}

export function registerTuiBrokerAutocompleteProviderWrapper(
  key: string,
  wrapper: TuiBrokerAutocompleteProviderWrapper,
): void {
  getMap<TuiBrokerAutocompleteProviderWrapper>(AUTOCOMPLETE_WRAPPERS_KEY).set(key, wrapper);
}

export function unregisterTuiBrokerAutocompleteProviderWrapper(key: string): void {
  getMap<TuiBrokerAutocompleteProviderWrapper>(AUTOCOMPLETE_WRAPPERS_KEY).delete(key);
}

export function getTuiBrokerAutocompleteProviderWrappers(): TuiBrokerAutocompleteProviderWrapper[] {
  return Array.from(getMap<TuiBrokerAutocompleteProviderWrapper>(AUTOCOMPLETE_WRAPPERS_KEY).values());
}

export function registerTuiBrokerEditorBadgeProvider(key: string, provider: TuiBrokerEditorBadgeProvider): void {
  getMap<TuiBrokerEditorBadgeProvider>(EDITOR_BADGES_KEY).set(key, provider);
}

export function unregisterTuiBrokerEditorBadgeProvider(key: string): void {
  getMap<TuiBrokerEditorBadgeProvider>(EDITOR_BADGES_KEY).delete(key);
}

export function getTuiBrokerEditorBadges(): Array<ContributionWithKey<TuiBrokerEditorBadge>> {
  return collectContributions(getMap<TuiBrokerEditorBadgeProvider>(EDITOR_BADGES_KEY).entries());
}

export function registerTuiBrokerFooterPathProvider(key: string, provider: TuiBrokerFooterPathProvider): void {
  getMap<TuiBrokerFooterPathProvider>(FOOTER_PATH_PROVIDERS_KEY).set(key, provider);
}

export function unregisterTuiBrokerFooterPathProvider(key: string): void {
  getMap<TuiBrokerFooterPathProvider>(FOOTER_PATH_PROVIDERS_KEY).delete(key);
}

export function getTuiBrokerFooterPath(
  args: TuiBrokerFooterPathArgs,
): ContributionWithKey<TuiBrokerFooterPathContribution> | null {
  const resolved: Array<ContributionWithKey<TuiBrokerFooterPathContribution>> = [];
  for (const [key, provider] of getMap<TuiBrokerFooterPathProvider>(FOOTER_PATH_PROVIDERS_KEY).entries()) {
    const value = provider(args);
    if (!value) continue;
    resolved.push({
      ...value,
      key,
      priority: normalizePriority(value.priority),
    });
  }

  resolved.sort(sortByPriorityThenKey);
  return resolved[0] ?? null;
}

export function subscribeTuiBrokerFooterRefresh(listener: () => void): () => void {
  const listeners = getListeners(FOOTER_REFRESH_LISTENERS_KEY);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestTuiBrokerFooterRefresh(): void {
  for (const listener of getListeners(FOOTER_REFRESH_LISTENERS_KEY)) {
    listener();
  }
}

export function setTuiBrokerEditorReinstallHandler(handler: (() => void) | undefined): void {
  const state = getGlobalState();
  if (handler) {
    state[EDITOR_REINSTALL_HANDLER_KEY] = handler;
    return;
  }

  delete state[EDITOR_REINSTALL_HANDLER_KEY];
}

export function requestTuiBrokerEditorReinstall(): void {
  const handler = getGlobalState()[EDITOR_REINSTALL_HANDLER_KEY];
  if (typeof handler === "function") {
    handler();
  }
}

export function getTuiBrokerRuntimeSnapshot(args: TuiBrokerFooterPathArgs = { sessionName: undefined }): {
  autocompleteWrappers: string[];
  editorBadgeKeys: string[];
  editorBadges: string[];
  editorBorderColor: "#fab387";
  footerPathProviderKeys: string[];
  footerPathText: string | null;
  footerPathSourceKey: string | null;
} {
  const badges = getTuiBrokerEditorBadges();
  const footerPath = getTuiBrokerFooterPath(args);

  return {
    autocompleteWrappers: Array.from(getMap<TuiBrokerAutocompleteProviderWrapper>(AUTOCOMPLETE_WRAPPERS_KEY).keys()).sort(),
    editorBadgeKeys: badges.map((entry) => entry.key),
    editorBadges: badges.map((entry) => entry.text),
    editorBorderColor: "#fab387",
    footerPathProviderKeys: Array.from(getMap<TuiBrokerFooterPathProvider>(FOOTER_PATH_PROVIDERS_KEY).keys()).sort(),
    footerPathText: footerPath?.text ?? null,
    footerPathSourceKey: footerPath?.key ?? null,
  };
}

export function __resetTuiBrokerRuntimeForTests(): void {
  const state = getGlobalState();
  delete state[ACTIVE_KEY];
  delete state[EDITOR_REINSTALL_HANDLER_KEY];
  delete state[AUTOCOMPLETE_WRAPPERS_KEY];
  delete state[EDITOR_BADGES_KEY];
  delete state[FOOTER_PATH_PROVIDERS_KEY];
  delete state[FOOTER_REFRESH_LISTENERS_KEY];
}
