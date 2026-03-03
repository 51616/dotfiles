import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parsePositiveInt } from "../../lib/shared/pi-number.ts";
import { asString } from "../../lib/shared/pi-string.ts";

const MARKER_PREFIX = "[[pi-router:";
const MARKER_SUFFIX = "]]";
const CONTROL_PREFIX = "__pictl__";
const CONTROL_RESULT_PREFIX = "__pictl_result__";

export async function wsDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  const blobCtor = (globalThis as Record<string, unknown>).Blob;
  if (blobCtor && data instanceof Blob) {
    return await data.text();
  }

  return "";
}

export function pathBasename(p: string): string {
  const parts = p.replace(/\\+/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export function markerText(id: string, text: string): string {
  return `${MARKER_PREFIX}${id}${MARKER_SUFFIX}\n${text}`;
}

export function parseMarkedText(text: string): { id: string; cleanText: string } | null {
  if (!text.startsWith(MARKER_PREFIX)) return null;
  const markerEnd = text.indexOf(MARKER_SUFFIX);
  if (markerEnd <= MARKER_PREFIX.length) return null;

  const id = text.slice(MARKER_PREFIX.length, markerEnd).trim();
  if (!id) return null;

  let cleanText = text.slice(markerEnd + MARKER_SUFFIX.length);
  if (cleanText.startsWith("\n")) cleanText = cleanText.slice(1);

  return { id, cleanText };
}

type ControlPayload = {
  op: string;
  [key: string]: unknown;
};

export function parseControlPayload(text: string): ControlPayload | null {
  const raw = String(text || "").trim();
  if (!raw.startsWith(CONTROL_PREFIX)) return null;

  const json = raw.slice(CONTROL_PREFIX.length).trim();
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as ControlPayload;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.op !== "string" || !parsed.op.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function controlResultText(payload: { ok: boolean; data?: unknown; error?: string }): string {
  return `${CONTROL_RESULT_PREFIX}${JSON.stringify(payload)}`;
}

function normalizeThinkingLevel(value: unknown): "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const raw = asString(value).trim().toLowerCase();
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(raw)) {
    return raw as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  }
  return "";
}

export function currentSessionSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): Record<string, unknown> {
  const model = ctx.model;
  const usage = ctx.getContextUsage();
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionName: ctx.sessionManager.getSessionName() || "",
    messageCount: ctx.sessionManager.getEntries().length,
    provider: model?.provider || "",
    modelId: model?.id || "",
    thinkingLevel: pi.getThinkingLevel(),
    contextUsage: usage || null,
  };
}

export async function handleControlOperation(
  pi: ExtensionAPI,
  control: ControlPayload,
  ctx: ExtensionContext,
): Promise<Record<string, unknown>> {
  const op = asString(control.op).trim();

  if (op === "session.status") {
    return { current: currentSessionSnapshot(pi, ctx) };
  }

  if (op === "model.set") {
    const provider = asString(control.provider).trim();
    const modelId = asString(control.modelId).trim();
    const thinkingLevel = normalizeThinkingLevel(control.thinkingLevel);

    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }

    if (provider && modelId) {
      const registry = ctx.modelRegistry as unknown as {
        refresh?: () => void;
        getAvailable?: () => unknown;
        getAll?: () => unknown;
      };

      if (typeof registry.refresh === "function") {
        registry.refresh();
      }

      let models = typeof registry.getAvailable === "function" ? registry.getAvailable() : [];
      if (models && typeof (models as Promise<unknown>).then === "function") {
        models = await (models as Promise<unknown>);
      }

      if (!Array.isArray(models) || models.length === 0) {
        const allModels = typeof registry.getAll === "function" ? registry.getAll() : [];
        models = Array.isArray(allModels) ? allModels : [];
      }

      const target = (models as Array<{ provider?: string; id?: string }>).find(
        (m) => m?.provider === provider && m?.id === modelId,
      );

      if (!target) {
        throw new Error(`model not found: ${provider}/${modelId}`);
      }

      const switched = await pi.setModel(target as never);
      if (!switched) {
        throw new Error(`failed to activate model (missing auth?): ${provider}/${modelId}`);
      }
    }

    if (thinkingLevel) {
      pi.setThinkingLevel(thinkingLevel);
    }

    return { current: currentSessionSnapshot(pi, ctx) };
  }

  throw new Error(`unsupported control op: ${op}`);
}

export function readTokenFromFile(tokenFile: string): string {
  try {
    if (!tokenFile) return "";
    if (!fs.existsSync(tokenFile)) return "";
    return String(fs.readFileSync(tokenFile, "utf8") || "").trim();
  } catch {
    return "";
  }
}

export function defaultTokenFilePath(): string {
  const home = asString(process.env.HOME).trim();
  if (!home) return "";
  return `${home}/.pi/agent/state/pi-router/router.token`;
}

export function getRouterUrl(): string {
  const direct = asString(process.env.PI_ROUTER_WS_URL).trim();
  if (direct) return direct;

  const host = asString(process.env.PI_ROUTER_HOST).trim() || "127.0.0.1";
  const port = parsePositiveInt(process.env.PI_ROUTER_PORT, 8766);
  return `ws://${host}:${port}`;
}

export function loadProjectConfig(cwd: string): { name?: string; id?: string; tags?: string[] } | null {
  const filePath = asString(process.env.PI_ROUTER_INSTANCE_CONFIG).trim() || `${cwd}/.pi-instance.json`;
  try {
    if (!filePath) return null;

    const candidates = [filePath, `${cwd}/.pi-instance.json`];
    const chosen = candidates.find((p) => p && fs.existsSync(p)) || "";
    if (!chosen) return null;

    const raw = String(fs.readFileSync(chosen, "utf8") || "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const tags = Array.isArray(obj.tags)
      ? obj.tags.map((t) => asString(t).trim()).filter(Boolean).slice(0, 20)
      : [];

    const out: { name?: string; id?: string; tags?: string[] } = {};
    if (name) out.name = name;
    if (id) out.id = id;
    if (tags.length) out.tags = tags;
    return out;
  } catch {
    return null;
  }
}
