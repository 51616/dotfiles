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
const FAST_SERVICE_TIER = "fast";

type CodexFastModeState = {
  enabled: boolean;
};

type ModelLike = Pick<NonNullable<ExtensionContext["model"]>, "provider"> | undefined;

type ToggleAction = "on" | "off" | "toggle" | "status";

type PayloadRecord = Record<string, unknown>;

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

export function withCodexFastServiceTier(payload: unknown): PayloadRecord | null {
  if (!isRecord(payload)) return null;
  return { ...payload, service_tier: FAST_SERVICE_TIER };
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

function formatModeStatus(state: CodexFastModeState, ctx: ExtensionContext): string {
  const appliesToCurrentModel = shouldUseCodexFastMode(state, ctx.model);
  if (appliesToCurrentModel) return "Codex fast mode is enabled for the current Codex model.";
  if (state.enabled) return "Codex fast mode is enabled, but the current model is not an openai-codex model.";
  return "Codex fast mode is disabled.";
}

function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(text, level);
}

export default function codexFastMode(pi: ExtensionAPI) {
  let state = readCodexFastModeState();

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
    notify(ctx, formatModeStatus(state, ctx), "info");
  };

  pi.registerCommand("codex-fast-mode", {
    description: "Toggle OpenAI Codex service_tier=fast for future Codex requests",
    handler: async (args, ctx) => {
      const action = parseToggleAction(args);
      if (!action) {
        notify(ctx, "Usage: /codex-fast-mode [on|off|toggle|status], /fast, or /normal", "warning");
        return;
      }

      if (action === "status") {
        notify(ctx, formatModeStatus(state, ctx), "info");
        return;
      }

      setEnabled(action === "toggle" ? !state.enabled : action === "on", ctx);
    },
  });

  pi.registerCommand("fast", {
    description: "Enable OpenAI Codex service_tier=fast for future Codex requests",
    handler: async (_args, ctx) => {
      setEnabled(true, ctx);
    },
  });

  pi.registerCommand("normal", {
    description: "Disable OpenAI Codex service_tier=fast for future Codex requests",
    handler: async (_args, ctx) => {
      setEnabled(false, ctx);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!shouldUseCodexFastMode(state, ctx.model)) return undefined;

    const payload = withCodexFastServiceTier(event.payload);
    return payload ?? undefined;
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
