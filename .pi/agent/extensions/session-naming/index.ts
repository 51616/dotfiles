// @lat: [[session-naming#Session naming]]
import { complete } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  buildNamingPrompt,
  collapseWhitespace,
  fingerprintNamingSourceText,
  getFirstTurnUserText,
  getLatestSessionInfoEntry,
  hasManualNameOverride,
  hasManualSessionInfoOverride,
  hasUnsafePendingHistory,
  initialStateForSession,
  normalizeProvisionalName,
  pickSessionNamingModel,
  readPersistedStateRecord,
  sanitizeFinalTitleCandidate,
  serializeNamingConversation,
  SESSION_NAMING_STATE_TYPE,
  type SessionNamingState,
} from "./lib/session-naming.ts";

const SYSTEM_PROMPT = [
  "You write concise session names for a coding assistant.",
  "Return exactly one session title.",
  "Use Title Case.",
  "No quotes, markdown, emoji, or trailing punctuation.",
].join(" ");

function persistState(pi: ExtensionAPI, state: SessionNamingState): void {
  pi.appendEntry(SESSION_NAMING_STATE_TYPE, state);
}

function hydrateState(ctx: ExtensionContext): SessionNamingState {
  const currentName = ctx.sessionManager.getSessionName();
  const branchEntries = ctx.sessionManager.getBranch();
  const persisted = readPersistedStateRecord(branchEntries);
  const hydrated = persisted?.state ?? initialStateForSession(ctx.sessionManager, currentName);

  if (hydrated.stage !== "pending-semantic") return hydrated;
  if (!hydrated.provisionalName) {
    return {
      ...hydrated,
      stage: "failed",
      eligible: false,
      failureReason: hydrated.failureReason ?? "missing-provisional-name-on-hydrate",
    };
  }
  if (!hydrated.provisionalNameEntryId) {
    return {
      ...hydrated,
      stage: "failed",
      eligible: false,
      failureReason: hydrated.failureReason ?? "missing-provisional-name-entry-id-on-hydrate",
    };
  }
  if (
    hasManualSessionInfoOverride(branchEntries, hydrated.provisionalNameEntryId)
    || (currentName && hasManualNameOverride(currentName, hydrated.provisionalName))
  ) {
    return {
      ...hydrated,
      stage: "manual-override",
      eligible: false,
    };
  }
  if (!currentName) {
    return {
      ...hydrated,
      stage: "failed",
      eligible: false,
      failureReason: hydrated.failureReason ?? "missing-session-name-on-hydrate",
    };
  }
  if (persisted && hasUnsafePendingHistory(branchEntries, persisted.index)) {
    return {
      ...hydrated,
      stage: "failed",
      eligible: false,
      failureReason: hydrated.failureReason ?? "interrupted-pending-semantic",
    };
  }
  return hydrated;
}

export interface SessionNamingDeps {
  completeModel: typeof complete;
}

export function createSessionNamingExtension(deps: SessionNamingDeps = { completeModel: complete }) {
  return function sessionNamingExtension(pi: ExtensionAPI) {
    let state: SessionNamingState = {
      version: 1,
      stage: "ineligible",
      eligible: false,
    };
    let semanticAbortController: AbortController | undefined;

    function abortSemanticRequest(): void {
      semanticAbortController?.abort();
      semanticAbortController = undefined;
    }

    function failPending(reason: string): void {
      abortSemanticRequest();
      if (state.stage !== "pending-semantic") return;
      state = {
        ...state,
        stage: "failed",
        eligible: false,
        failureReason: state.failureReason ?? reason,
      };
      persistState(pi, state);
    }

    async function maybeApplySemanticName(semanticName: string, ctx: ExtensionContext): Promise<void> {
      const currentName = pi.getSessionName();
      const branchEntries = ctx.sessionManager.getBranch();
      if (
        hasManualSessionInfoOverride(branchEntries, state.provisionalNameEntryId)
        || hasManualNameOverride(currentName, state.provisionalName)
      ) {
        state = {
          ...state,
          stage: "manual-override",
          eligible: false,
        };
        persistState(pi, state);
        return;
      }

      pi.setSessionName(semanticName);
      state = {
        ...state,
        stage: "done",
        eligible: false,
        finalName: semanticName,
      };
      persistState(pi, state);
    }

    function refreshState(ctx: ExtensionContext): void {
      const nextState = hydrateState(ctx);
      const didChange = JSON.stringify(nextState) !== JSON.stringify(state);
      state = nextState;
      if (didChange && (state.stage === "failed" || state.stage === "manual-override")) {
        persistState(pi, state);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("session_before_switch", async (_event, _ctx) => {
      failPending("interrupted-pending-semantic");
    });

    pi.on("session_switch", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("session_before_fork", async (_event, _ctx) => {
      failPending("interrupted-pending-semantic");
    });

    pi.on("session_fork", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("session_before_tree", async (_event, _ctx) => {
      failPending("interrupted-pending-semantic");
    });

    pi.on("session_tree", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("session_before_compact", async (_event, _ctx) => {
      failPending("interrupted-pending-semantic");
    });

    pi.on("session_compact", async (_event, ctx) => {
      refreshState(ctx);
    });

    pi.on("input", async (event, ctx) => {
      if (event.source === "extension") return;
      if (state.stage === "pending-semantic") {
        failPending("interrupted-pending-semantic");
        return;
      }
      if (!state.eligible || state.stage !== "idle") return;

      const provisionalName = normalizeProvisionalName(event.text);
      const firstInputHash = fingerprintNamingSourceText(event.text);
      if (!provisionalName || !firstInputHash) return;
      if (collapseWhitespace(pi.getSessionName() ?? "")) {
        state = {
          version: 1,
          stage: "ineligible",
          eligible: false,
        };
        persistState(pi, state);
        return;
      }

      pi.setSessionName(provisionalName);
      const provisionalNameEntryId = getLatestSessionInfoEntry(ctx.sessionManager.getBranch())?.id;
      if (!provisionalNameEntryId) {
        state = {
          version: 1,
          stage: "failed",
          eligible: false,
          provisionalName,
          failureReason: "missing-provisional-name-entry-id",
        };
        persistState(pi, state);
        return;
      }

      state = {
        version: 1,
        stage: "pending-semantic",
        eligible: true,
        provisionalName,
        provisionalNameEntryId,
        firstInputHash,
      };
      persistState(pi, state);
    });

    pi.on("agent_end", (event, ctx) => {
      if (!state.eligible || state.stage !== "pending-semantic" || !state.provisionalName) return;

      // Capture an immutable view of the pending state so any later session switch/hydration
      // (or user edits) will prevent this delayed async call from mutating the wrong branch.
      const expectedProvisionalName = state.provisionalName;
      const expectedProvisionalNameEntryId = state.provisionalNameEntryId;
      const expectedFirstInputHash = state.firstInputHash;
      let requestAbortController: AbortController | undefined;

      const isStillSamePendingState = (): boolean =>
        state.eligible &&
        state.stage === "pending-semantic" &&
        state.provisionalName === expectedProvisionalName &&
        state.provisionalNameEntryId === expectedProvisionalNameEntryId &&
        state.firstInputHash === expectedFirstInputHash &&
        semanticAbortController === requestAbortController;

      void (async () => {
        try {
          if (!isStillSamePendingState()) return;

          if (
            hasManualSessionInfoOverride(ctx.sessionManager.getBranch(), state.provisionalNameEntryId)
            || hasManualNameOverride(pi.getSessionName(), expectedProvisionalName)
          ) {
            state = {
              ...state,
              stage: "manual-override",
              eligible: false,
            };
            persistState(pi, state);
            return;
          }

          const model = pickSessionNamingModel(ctx.modelRegistry);
          if (!model) {
            if (!isStillSamePendingState()) return;
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "model-unavailable",
            };
            persistState(pi, state);
            return;
          }

          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) {
            if (!isStillSamePendingState()) return;
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "auth-failed",
            };
            persistState(pi, state);
            return;
          }
          if (!auth.apiKey) {
            if (!isStillSamePendingState()) return;
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "missing-api-key",
            };
            persistState(pi, state);
            return;
          }

          if (!isStillSamePendingState()) return;

          if (!expectedProvisionalNameEntryId) {
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "missing-provisional-name-entry-id",
            };
            persistState(pi, state);
            return;
          }

          if (!expectedFirstInputHash) {
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "missing-first-input-hash",
            };
            persistState(pi, state);
            return;
          }

          const firstTurnUserText = getFirstTurnUserText(event.messages);
          const actualFirstInputHash = firstTurnUserText ? fingerprintNamingSourceText(firstTurnUserText) : undefined;
          if (!actualFirstInputHash || actualFirstInputHash !== expectedFirstInputHash) {
            if (!isStillSamePendingState()) return;
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "input-mismatch",
            };
            persistState(pi, state);
            return;
          }

          const conversationText = serializeNamingConversation(event.messages);
          if (!conversationText.trim()) {
            if (!isStillSamePendingState()) return;
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "empty-conversation",
            };
            persistState(pi, state);
            return;
          }

          if (!isStillSamePendingState()) return;

          requestAbortController = new AbortController();
          semanticAbortController = requestAbortController;
          const signal = ctx.signal
            ? AbortSignal.any([ctx.signal, requestAbortController.signal])
            : requestAbortController.signal;

          const response = await deps.completeModel(
            model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: buildNamingPrompt(conversationText) }],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              maxTokens: 64,
              signal,
            },
          );

          if (!isStillSamePendingState()) return;

          const semanticName = sanitizeFinalTitleCandidate(
            response.content
              .filter((item): item is { type: "text"; text: string } => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          );

          if (!semanticName) {
            state = {
              ...state,
              stage: "failed",
              eligible: false,
              failureReason: "empty-response",
            };
            persistState(pi, state);
            return;
          }

          await maybeApplySemanticName(semanticName, ctx);
        } catch (error) {
          if (!isStillSamePendingState()) return;
          const failureReason = error instanceof Error && error.name === "AbortError"
            ? "aborted"
            : "request-failed";
          state = {
            ...state,
            stage: "failed",
            eligible: false,
            failureReason,
          };
          persistState(pi, state);
        } finally {
          if (semanticAbortController === requestAbortController) {
            semanticAbortController = undefined;
          }
        }
      })();
    });

    pi.on("session_shutdown", async () => {
      abortSemanticRequest();
      state = {
        version: 1,
        stage: "ineligible",
        eligible: false,
      };
    });
  };
}

export default createSessionNamingExtension();
