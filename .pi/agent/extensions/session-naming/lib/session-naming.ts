import { createHash } from "node:crypto";
import type { AgentMessage, ReadonlySessionManager } from "@mariozechner/pi-coding-agent";
import type { Model, TextContent } from "@mariozechner/pi-ai";

export const SESSION_NAMING_STATE_TYPE = "session-naming-state";
export const SESSION_NAMING_MODEL_ID = "gpt-5.3-codex-spark";
export const PROVISIONAL_NAME_MAX_LENGTH = 30;
export const FINAL_NAME_MAX_LENGTH = 48;
export const MAX_NAMING_TRANSCRIPT_CHARS = 600;
export const MAX_NAMING_LINE_CHARS = 200;

export type SessionNamingStage =
  | "idle"
  | "pending-semantic"
  | "done"
  | "failed"
  | "manual-override"
  | "ineligible";

export interface SessionNamingState {
  version: 1;
  stage: SessionNamingStage;
  eligible: boolean;
  provisionalName?: string;
  provisionalNameEntryId?: string;
  finalName?: string;
  firstInputHash?: string;
  failureReason?: string;
}

interface BranchEntryLike {
  type: string;
  id?: string;
  name?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
  };
}

export interface PersistedSessionNamingState {
  state: SessionNamingState;
  index: number;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  if (maxLength === 1) return "…";
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function normalizeNamingSourceText(text: string): string | undefined {
  const normalized = collapseWhitespace(redactSensitiveText(text));
  return normalized || undefined;
}

export function fingerprintNormalizedNamingText(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function fingerprintNamingSourceText(text: string): string | undefined {
  const normalized = normalizeNamingSourceText(text);
  if (!normalized) return undefined;
  return fingerprintNormalizedNamingText(normalized);
}

export function normalizeProvisionalName(text: string): string | undefined {
  const normalized = normalizeNamingSourceText(text);
  if (!normalized) return undefined;
  return truncateWithEllipsis(normalized, PROVISIONAL_NAME_MAX_LENGTH);
}

const PRESERVED_UPPERCASE_WORDS = new Set([
  "API",
  "CLI",
  "CPU",
  "GPU",
  "GPT",
  "HTML",
  "HTTP",
  "HTTPS",
  "ID",
  "JSON",
  "JWT",
  "LLM",
  "RPC",
  "REDACTED",
  "SDK",
  "SSH",
  "TUI",
  "UI",
  "URL",
  "XML",
  "YAML",
]);

function toTitleCaseWord(word: string): string {
  const lettersOnly = word.replace(/[^A-Za-z]/g, "");
  if (PRESERVED_UPPERCASE_WORDS.has(lettersOnly.toUpperCase())) return word.toUpperCase();
  if (/[A-Z]/.test(word) && /[a-z]/.test(word)) return word;
  const lower = word.toLowerCase();
  return lower.replace(/(^|[-+./])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
}

function toTitleCase(text: string): string {
  return text.replace(/[A-Za-z0-9.+-]+/g, (word) => toTitleCaseWord(word));
}

export function sanitizeFinalTitleCandidate(text: string): string | undefined {
  const firstLine = redactSensitiveText(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  let normalized = collapseWhitespace(firstLine)
    .replace(/^title\s*:\s*/i, "")
    .replace(/^(?:[-*•]\s+)+/u, "")
    .replace(/["'“”‘’`*_#>]+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .trim();

  normalized = normalized.replace(/[.!?,;:]+$/u, "").trim();
  if (!normalized) return undefined;

  return truncateWithEllipsis(toTitleCase(normalized), FINAL_NAME_MAX_LENGTH);
}

export function isEligibleFreshSession(sessionManager: ReadonlySessionManager, currentName: string | undefined): boolean {
  if (collapseWhitespace(currentName ?? "")) return false;
  return !hasMeaningfulHistory(sessionManager.getEntries());
}

export function hasMeaningfulHistory(entries: Array<{ type: string }>): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary",
  );
}

export function readPersistedStateRecord(entries: BranchEntryLike[]): PersistedSessionNamingState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_NAMING_STATE_TYPE || !entry.data) continue;
    const parsed = parseState(entry.data);
    if (parsed) return { state: parsed, index };
  }
  return undefined;
}

export function readPersistedState(entries: BranchEntryLike[]): SessionNamingState | undefined {
  return readPersistedStateRecord(entries)?.state;
}

export interface SessionInfoEntryRecord {
  index: number;
  id?: string;
  name?: string;
}

export function getLatestSessionInfoEntry(entries: BranchEntryLike[]): SessionInfoEntryRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "session_info") continue;
    return {
      index,
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : undefined,
    };
  }
  return undefined;
}

export function parseState(value: unknown): SessionNamingState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return undefined;
  if (typeof input.stage !== "string") return undefined;
  if (typeof input.eligible !== "boolean") return undefined;

  const stage = input.stage as SessionNamingStage;
  const allowedStages = new Set<SessionNamingStage>([
    "idle",
    "pending-semantic",
    "done",
    "failed",
    "manual-override",
    "ineligible",
  ]);
  if (!allowedStages.has(stage)) return undefined;

  const state: SessionNamingState = {
    version: 1,
    stage,
    eligible: input.eligible,
  };

  if (typeof input.provisionalName === "string") state.provisionalName = input.provisionalName;
  if (typeof input.provisionalNameEntryId === "string") state.provisionalNameEntryId = input.provisionalNameEntryId;
  if (typeof input.finalName === "string") state.finalName = input.finalName;
  if (typeof input.firstInputHash === "string") state.firstInputHash = input.firstInputHash;
  if (typeof input.failureReason === "string") state.failureReason = input.failureReason;
  return state;
}

export function hasManualNameOverride(currentName: string | undefined, provisionalName: string | undefined): boolean {
  return collapseWhitespace(currentName ?? "") !== collapseWhitespace(provisionalName ?? "");
}

export function hasManualSessionInfoOverride(entries: BranchEntryLike[], provisionalNameEntryId: string | undefined): boolean {
  if (!provisionalNameEntryId) return false;
  const latestSessionInfo = getLatestSessionInfoEntry(entries);
  return Boolean(latestSessionInfo?.id && latestSessionInfo.id !== provisionalNameEntryId);
}

export function hasUnsafePendingHistory(entries: BranchEntryLike[], pendingStateIndex: number): boolean {
  let userMessagesAfterState = 0;
  for (const entry of entries.slice(pendingStateIndex + 1)) {
    if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return true;
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user") return true;
    userMessagesAfterState += 1;
    if (userMessagesAfterState > 1) return true;
  }
  return false;
}

export function buildNamingPrompt(conversationText: string): string {
  return [
    "Name this coding-assistant session based on the first-turn conversation.",
    "Return exactly one short session title.",
    "Rules:",
    "- Use a concise Title Case noun phrase.",
    `- Maximum ${FINAL_NAME_MAX_LENGTH} characters.`,
    "- No quotes, markdown, emojis, or trailing punctuation.",
    "- Focus on the concrete topic or task, not generic wording like Help or Question.",
    "- Prefer specific technical nouns when present.",
    "- Use only the user/assistant text shown below.",
    "",
    "Conversation:",
    conversationText,
  ].join("\n");
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b(api(?:[\s_-]+)?key|token|secret|password)\b\s*[:=]\s*\S+/gi, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z-_]{10,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, "[REDACTED]");
}

function extractTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is TextContent => Boolean(item) && typeof item === "object" && "type" in item && item.type === "text")
    .map((item) => item.text)
    .join(" ");
  const normalized = collapseWhitespace(redactSensitiveText(text));
  return normalized || undefined;
}

export function getFirstTurnConversation(messages: AgentMessage[]): AgentMessage[] {
  const relevantMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");
  if (relevantMessages.length === 0) return [];

  const startIndex = relevantMessages.findIndex((message) => message.role === "user");
  const slice = startIndex >= 0 ? relevantMessages.slice(startIndex) : relevantMessages;
  const bounded: AgentMessage[] = [];
  let sawAssistant = false;

  for (const message of slice) {
    if (message.role === "user" && sawAssistant) break;
    bounded.push(message);
    if (message.role !== "assistant") continue;
    sawAssistant = true;
    if ("stopReason" in message && message.stopReason !== "toolUse") break;
  }

  return bounded;
}

export function getFirstTurnUserText(messages: AgentMessage[]): string | undefined {
  for (const message of getFirstTurnConversation(messages)) {
    if (message.role !== "user") continue;
    return extractTextContent(message.content);
  }
  return undefined;
}

export function extractFirstTurnUserText(messages: AgentMessage[]): string | undefined {
  const firstUser = getFirstTurnConversation(messages).find((message) => message.role === "user");
  if (!firstUser) return undefined;
  return extractTextContent(firstUser.content);
}

export function fingerprintFirstTurnUserMessage(messages: AgentMessage[]): string | undefined {
  const normalized = extractFirstTurnUserText(messages);
  if (!normalized) return undefined;
  return fingerprintNormalizedNamingText(normalized);
}

export function serializeNamingConversation(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const message of getFirstTurnConversation(messages)) {
    const text = extractTextContent(message.content);
    if (!text) continue;
    const speaker = message.role === "user" ? "User" : "Assistant";
    lines.push(`${speaker}: ${truncateWithEllipsis(text, MAX_NAMING_LINE_CHARS)}`);
  }
  return truncateWithEllipsis(lines.join("\n"), MAX_NAMING_TRANSCRIPT_CHARS);
}

export function pickSessionNamingModel<TModel extends Model<any>>(registry: {
  find(provider: string, modelId: string): TModel | undefined;
}): TModel | undefined {
  return registry.find("openai-codex", SESSION_NAMING_MODEL_ID) ?? registry.find("openai", SESSION_NAMING_MODEL_ID);
}

export function initialStateForSession(sessionManager: ReadonlySessionManager, currentName: string | undefined): SessionNamingState {
  if (!isEligibleFreshSession(sessionManager, currentName)) {
    return {
      version: 1,
      stage: "ineligible",
      eligible: false,
    };
  }

  return {
    version: 1,
    stage: "idle",
    eligible: true,
  };
}
