import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  registerTuiBrokerFooterModelEffortSuffixProvider,
  requestTuiBrokerFooterRefresh,
  unregisterTuiBrokerFooterModelEffortSuffixProvider,
} from "../tui-broker/lib/runtime.ts";

const CONTRIBUTION_KEY = "codex-fast-mode";
const STATE_FILENAME = "codex-fast-mode.json";
// Codex CLI exposes a user-facing "fast" speed tier, but pi's active Codex provider path
// rejects literal service_tier=fast. Use the closest documented Responses API tier by default.
const DEFAULT_FAST_SERVICE_TIER = "priority";
const PUBLIC_RESPONSES_SERVICE_TIERS = ["auto", "default", "flex", "priority"] as const;
const SERVICE_TIER_ENV = "PI_CODEX_FAST_MODE_SERVICE_TIER";

type CodexFastModeState = {
  enabled: boolean;
};

type ModelLike = Pick<NonNullable<ExtensionContext["model"]>, "provider"> | undefined;

type CodexFastModeServiceTier = (typeof PUBLIC_RESPONSES_SERVICE_TIERS)[number];

type ToggleAction = "on" | "off" | "toggle" | "status";

type PayloadRecord = Record<string, unknown>;

type RuntimeDiagnostics = {
  injectedRequestCount: number;
  inFlightInjectedRequests: number;
  lastInjectedAt: string | null;
  lastInjectedModelId: string | undefined;
  lastResponseStatus: number | null;
};

function resolveAgentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function resolveStatePath(agentDir = resolveAgentDir()): string {
  return join(agentDir, STATE_FILENAME);
}

function isRecord(value: unknown): value is PayloadRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: string, path: string): CodexFastModeState {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") {
    throw new Error(`Invalid codex-fast-mode state file at ${path}: expected { "enabled": boolean }`);
  }
  return { enabled: parsed.enabled };
}

export function readCodexFastModeState(agentDir = resolveAgentDir()): CodexFastModeState {
  const path = resolveStatePath(agentDir);
  if (!existsSync(path)) return { enabled: false };
  return parseState(readFileSync(path, "utf8"), path);
}

export function writeCodexFastModeState(state: CodexFastModeState, agentDir = resolveAgentDir()): void {
  mkdirSync(agentDir, { recursive: true });
  const path = resolveStatePath(agentDir);
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ enabled: state.enabled }, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

export function shouldUseCodexFastMode(state: CodexFastModeState, model: ModelLike): boolean {
  return state.enabled && model?.provider === "openai-codex";
}

function isCodexFastModeServiceTier(value: string): value is CodexFastModeServiceTier {
  return PUBLIC_RESPONSES_SERVICE_TIERS.includes(value as CodexFastModeServiceTier);
}

export function resolveCodexFastModeServiceTier(): CodexFastModeServiceTier {
  const configured = process.env[SERVICE_TIER_ENV]?.trim().toLowerCase();
  if (!configured) return DEFAULT_FAST_SERVICE_TIER;
  if (isCodexFastModeServiceTier(configured)) return configured;
  throw new Error(
    `Invalid ${SERVICE_TIER_ENV}=${JSON.stringify(configured)}; expected one of ${PUBLIC_RESPONSES_SERVICE_TIERS.join(", ")}`,
  );
}

export function withCodexFastServiceTier(
  payload: unknown,
  serviceTier: CodexFastModeServiceTier = resolveCodexFastModeServiceTier(),
): PayloadRecord | null {
  if (!isRecord(payload)) return null;
  return { ...payload, service_tier: serviceTier };
}

function parseToggleAction(args: string): ToggleAction | null {
  const [firstArg] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!firstArg) return "toggle";
  if (["on", "enable", "enabled", "true", "1"].includes(firstArg)) return "on";
  if (["off", "disable", "disabled", "false", "0"].includes(firstArg)) return "off";
  if (["toggle", "switch"].includes(firstArg)) return "toggle";
  if (["status", "show", "state"].includes(firstArg)) return "status";
  return null;
}

function formatModeStatus(
  state: CodexFastModeState,
  ctx: ExtensionContext,
  serviceTier: CodexFastModeServiceTier,
  diagnostics: RuntimeDiagnostics,
): string {
  const appliesToCurrentModel = shouldUseCodexFastMode(state, ctx.model);
  const status = appliesToCurrentModel
    ? "Codex fast mode is enabled for the current Codex model."
    : state.enabled
      ? "Codex fast mode is enabled, but the current model is not an openai-codex model."
      : "Codex fast mode is disabled.";
  const lastRequest = diagnostics.lastInjectedAt
    ? `Last injected request: ${diagnostics.lastInjectedAt} model=${diagnostics.lastInjectedModelId ?? "unknown"} status=${diagnostics.lastResponseStatus ?? "pending"}.`
    : "No request has been injected since this extension loaded.";

  return [
    status,
    `Responses API service_tier=${serviceTier}. Codex CLI's literal service_tier=fast is not accepted by pi's active OpenAI Codex provider path.`,
    `Injected requests since load: ${diagnostics.injectedRequestCount}.`,
    lastRequest,
  ].join("\n");
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(text, level);
}

export default function codexFastMode(pi: ExtensionAPI) {
  const serviceTier = resolveCodexFastModeServiceTier();
  let state = readCodexFastModeState();
  const diagnostics: RuntimeDiagnostics = {
    injectedRequestCount: 0,
    inFlightInjectedRequests: 0,
    lastInjectedAt: null,
    lastInjectedModelId: undefined,
    lastResponseStatus: null,
  };

  registerTuiBrokerFooterModelEffortSuffixProvider(CONTRIBUTION_KEY, ({ provider }) => {
    if (!state.enabled || provider !== "openai-codex") return null;
    return { text: "fast", priority: 100 };
  });

  const setEnabled = (enabled: boolean, ctx: ExtensionContext): void => {
    if (state.enabled !== enabled) {
      state = { enabled };
      writeCodexFastModeState(state);
    }
    requestTuiBrokerFooterRefresh();
    notify(ctx, formatModeStatus(state, ctx, serviceTier, diagnostics), "info");
  };

  pi.registerCommand("codex-fast-mode", {
    description: `Toggle OpenAI Codex Responses API service_tier=${serviceTier} for future Codex requests`,
    handler: async (args, ctx) => {
      const action = parseToggleAction(args);
      if (!action) {
        notify(ctx, "Usage: /codex-fast-mode [on|off|toggle|status], /fast, or /normal", "warning");
        return;
      }

      if (action === "status") {
        notify(ctx, formatModeStatus(state, ctx, serviceTier, diagnostics), "info");
        return;
      }

      setEnabled(action === "toggle" ? !state.enabled : action === "on", ctx);
    },
  });

  pi.registerCommand("fast", {
    description: `Enable OpenAI Codex Responses API service_tier=${serviceTier} for future Codex requests`,
    handler: async (_args, ctx) => {
      setEnabled(true, ctx);
    },
  });

  pi.registerCommand("normal", {
    description: `Disable OpenAI Codex Responses API service_tier=${serviceTier} for future Codex requests`,
    handler: async (_args, ctx) => {
      setEnabled(false, ctx);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!shouldUseCodexFastMode(state, ctx.model)) return undefined;

    const payload = withCodexFastServiceTier(event.payload, serviceTier);
    if (!payload) return undefined;

    diagnostics.injectedRequestCount += 1;
    diagnostics.inFlightInjectedRequests += 1;
    diagnostics.lastInjectedAt = new Date().toISOString();
    diagnostics.lastInjectedModelId = ctx.model?.id;
    diagnostics.lastResponseStatus = null;
    return payload;
  });

  pi.on("after_provider_response", (event) => {
    if (diagnostics.inFlightInjectedRequests <= 0) return;
    diagnostics.inFlightInjectedRequests -= 1;
    diagnostics.lastResponseStatus = event.status;
  });

  pi.on("model_select", () => {
    requestTuiBrokerFooterRefresh();
  });

  pi.on("session_start", () => {
    requestTuiBrokerFooterRefresh();
  });

  pi.on("session_shutdown", () => {
    unregisterTuiBrokerFooterModelEffortSuffixProvider(CONTRIBUTION_KEY);
    requestTuiBrokerFooterRefresh();
  });
}
