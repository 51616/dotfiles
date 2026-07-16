// @lat: [[extensions#Fast service tier toggle]]

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ServiceTier = "default" | "priority";
type PlainPayload = Record<string, unknown>;

const STATUS_KEY = "fast-service-tier";
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 256 * 1024;

let serviceTier: ServiceTier = "default";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function logPath(): string {
  return join(agentDir(), "logs", "fast-service-tier.jsonl");
}

function isPlainPayload(value: unknown): value is PlainPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function statusText(): string | undefined {
  return serviceTier === "priority" ? "fast:priority" : undefined;
}

function publishStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, statusText());
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

function setServiceTier(nextTier: ServiceTier, ctx: ExtensionContext, source: string): void {
  const previousTier = serviceTier;
  serviceTier = nextTier;
  publishStatus(ctx);
  logEvent({
    event: "service_tier_set",
    source,
    previousTier,
    serviceTier,
    provider: ctx.model?.provider ?? null,
    model: ctx.model?.id ?? null,
  });
}

export default function fastServiceTier(pi: ExtensionAPI): void {
  pi.registerCommand("fast", {
    description: "Toggle OpenAI fast mode by switching service_tier between priority and provider default. Use /fast status, /fast on, or /fast off.",
    handler: async (args, ctx) => {
      const parsed = parseFastCommand(args ?? "");

      if (parsed === "invalid") {
        ctx.ui.notify("Usage: /fast [status|on|off|priority|default]", "warning");
        return;
      }

      if (parsed !== "status") {
        setServiceTier(parsed, ctx, "command");
      } else {
        publishStatus(ctx);
      }

      ctx.ui.notify(describeTier(), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    publishStatus(ctx);
    logEvent({ event: "session_start", serviceTier });
  });

  pi.on("model_select", (_event, ctx) => {
    publishStatus(ctx);
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

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
