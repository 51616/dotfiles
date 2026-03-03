import { asString } from "../../lib/shared/pi-string.ts";

export function collectAssistantText(value: unknown, out: string[]) {
  if (!value) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectAssistantText(item, out);
    return;
  }

  if (typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (node.type === "thinking") return;

    if (node.type === "text" && typeof node.text === "string") {
      collectAssistantText(node.text, out);
      return;
    }

    if (typeof node.text === "string") {
      collectAssistantText(node.text, out);
    }

    if (node.content) collectAssistantText(node.content, out);
    if (node.output) collectAssistantText(node.output, out);
    if (typeof node.output_text === "string") collectAssistantText(node.output_text, out);
  }
}

export function extractAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown>;
    if (!message || typeof message !== "object") continue;
    if (message.role && message.role !== "assistant") continue;

    const parts: string[] = [];
    collectAssistantText(message.content || message, parts);
    const text = parts.join("\n").trim();
    if (text) return text;
  }

  return "";
}

export function truncateInline(text: string, max = 140): string {
  const normalized = asString(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const json = JSON.stringify(input);
    if (!json) return "";
    if (json.length <= 240) return json;
    return `${json.slice(0, 239)}…`;
  } catch {
    return "";
  }
}

export function extractCommandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string") return "";
  const trimmed = command.trim();
  if (!trimmed) return "";
  return trimmed.length <= 1200 ? trimmed : `${trimmed.slice(0, 1199)}…`;
}

export function tailLines(text: string, maxLines = 8, maxChars = 180): string {
  const normalized = asString(text).replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const tail = lines.slice(-maxLines).join("\n");
  if (tail.length <= maxChars) return tail;
  return `…\n${tail.slice(-(maxChars - 2))}`;
}

export function extractTextSnippet(value: unknown): string {
  const parts: string[] = [];
  collectAssistantText(value, parts);
  return truncateInline(parts.join(" "), 120);
}

export function extractResultTail(content: unknown, details: unknown): string {
  const parts: string[] = [];
  collectAssistantText(content, parts);
  if (parts.length === 0) {
    collectAssistantText(details, parts);
  }
  return tailLines(parts.join("\n"), 5, 140);
}

export function extractReturnCode(details: unknown): number | null {
  if (!details || typeof details !== "object") return null;
  const obj = details as Record<string, unknown>;

  const candidates = [obj.exitCode, obj.code, obj.returnCode];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
  }

  return null;
}
