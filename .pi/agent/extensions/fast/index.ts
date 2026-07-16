// @lat: [[extensions#Fast service tier toggle]]

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  registerTuiBrokerFooterModelEffortSuffixProvider,
  requestTuiBrokerFooterRefresh,
  unregisterTuiBrokerFooterModelEffortSuffixProvider,
} from "../tui-broker/lib/runtime.ts";

type ServiceTier = "default" | "priority";
type PlainPayload = Record<string, unknown>;
type PersistResult = { ok: true } | { ok: false; error: string };

const BROKER_KEY = "fast-service-tier";
const FAST_LABEL = "⚡Fast";
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 256 * 1024;

let serviceTier: ServiceTier = readPersistedServiceTier();

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function logPath(): string {
  return join(agentDir(), "logs", "fast-service-tier.jsonl");
}

function statePath(): string {
  return join(agentDir(), "fast-service-tier.json");
}

function isPlainPayload(value: unknown): value is PlainPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseServiceTier(value: unknown): ServiceTier | undefined {
  return value === "default" || value === "priority" ? value : undefined;
}

function readPersistedServiceTier(): ServiceTier {
  const path = statePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "default";
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainPayload(parsed)) {
      logEvent({ event: "state_invalid", reason: "not_object", path });
      return "default";
    }

    const parsedTier = parseServiceTier(parsed.serviceTier);
    if (!parsedTier) {
      logEvent({ event: "state_invalid", reason: "invalid_service_tier", path });
      return "default";
    }

    return parsedTier;
  } catch (error) {
    logEvent({ event: "state_invalid", reason: "invalid_json", path, error: formatError(error) });
    return "default";
  }
}

function writePersistedServiceTier(nextTier: ServiceTier): PersistResult {
  const path = statePath();
  const tempPath = `${path}.tmp-${process.pid}`;
  const state = {
    serviceTier: nextTier,
    updatedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function isSupportedOpenAiProvider(ctx: ExtensionContext): boolean {
  const provider = ctx.model?.provider;
  return provider === "openai" || provider === "openai-codex";
}

function pruneLog(path: string, now: number): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  if (Buffer.byteLength(raw, "utf8") <= MAX_LOG_BYTES) return;

  const retained = raw
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const parsed = JSON.parse(line) as { ts?: unknown };
        if (typeof parsed.ts !== "string") return true;
        const timestamp = Date.parse(parsed.ts);
        return Number.isNaN(timestamp) || now - timestamp <= LOG_RETENTION_MS;
      } catch {
        return true;
      }
    })
    .join("\n");

  writeFileSync(path, retained ? `${retained}\n` : "", "utf8");
}

function logEvent(event: PlainPayload): void {
  const path = logPath();
  const now = Date.now();
  try {
    mkdirSync(dirname(path), { recursive: true });
    pruneLog(path, now);
    appendFileSync(path, `${JSON.stringify({ ts: new Date(now).toISOString(), ...event })}\n`, "utf8");
  } catch {
    // Logging must never break a provider request or slash command.
  }
}

function refreshFastLabel(): void {
  requestTuiBrokerFooterRefresh();
}

function registerFastLabelProvider(): void {
  registerTuiBrokerFooterModelEffortSuffixProvider(BROKER_KEY, ({ provider }) => {
    if (serviceTier !== "priority") return null;
    if (provider !== "openai" && provider !== "openai-codex") return null;
    return { text: FAST_LABEL, priority: 100 };
  });
}

function parseFastCommand(args: string): ServiceTier | "status" | "invalid" {
  const normalized = args.trim().toLowerCase();
  if (normalized === "") return serviceTier === "priority" ? "default" : "priority";
  if (["on", "priority", "prioritize", "fast", "enable"].includes(normalized)) return "priority";
  if (["off", "default", "normal", "disable"].includes(normalized)) return "default";
  if (["status", "show", "?", "help"].includes(normalized)) return "status";
  return "invalid";
}

function describeTier(): string {
  return serviceTier === "priority"
    ? "Fast mode enabled: OpenAI requests use service_tier=priority."
    : "Fast mode disabled: OpenAI requests use the provider default service tier.";
}

function setServiceTier(nextTier: ServiceTier, ctx: ExtensionContext, source: string): PersistResult {
  const previousTier = serviceTier;
  serviceTier = nextTier;
  const persistResult = writePersistedServiceTier(nextTier);
  refreshFastLabel();
  logEvent({
    event: "service_tier_set",
    source,
    previousTier,
    serviceTier,
    persisted: persistResult.ok,
    persistError: persistResult.ok ? null : persistResult.error,
    provider: ctx.model?.provider ?? null,
    model: ctx.model?.id ?? null,
  });
  return persistResult;
}

export default function fastServiceTier(pi: ExtensionAPI): void {
  registerFastLabelProvider();

  pi.registerCommand("fast", {
    description: "Toggle OpenAI fast mode by switching service_tier between priority and provider default. Use /fast status, /fast on, or /fast off.",
    handler: async (args, ctx) => {
      const parsed = parseFastCommand(args ?? "");

      if (parsed === "invalid") {
        ctx.ui.notify("Usage: /fast [status|on|off|priority|default]", "warning");
        return;
      }

      const persistResult = parsed !== "status" ? setServiceTier(parsed, ctx, "command") : { ok: true as const };
      if (parsed === "status") {
        refreshFastLabel();
      }

      ctx.ui.notify(describeTier(), "info");
      if (!persistResult.ok) {
        ctx.ui.notify(`Fast mode changed for this session, but persistence failed: ${persistResult.error}`, "warning");
      }
    },
  });

  pi.on("session_start", (_event, _ctx) => {
    serviceTier = readPersistedServiceTier();
    registerFastLabelProvider();
    refreshFastLabel();
    logEvent({ event: "session_start", serviceTier, statePath: statePath() });
  });

  pi.on("model_select", () => {
    refreshFastLabel();
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (serviceTier !== "priority") return event.payload;

    const payload = event.payload;
    if (!isPlainPayload(payload) || !isSupportedOpenAiProvider(ctx)) {
      logEvent({
        event: "priority_skipped",
        reason: !isPlainPayload(payload) ? "non_object_payload" : "unsupported_provider",
        provider: ctx.model?.provider ?? null,
        model: ctx.model?.id ?? null,
      });
      return payload;
    }

    logEvent({
      event: "priority_injected",
      provider: ctx.model?.provider ?? null,
      model: ctx.model?.id ?? null,
      previousServiceTier: payload.service_tier ?? null,
    });

    return { ...payload, service_tier: "priority" };
  });

  pi.on("session_shutdown", () => {
    unregisterTuiBrokerFooterModelEffortSuffixProvider(BROKER_KEY);
    refreshFastLabel();
  });
}
