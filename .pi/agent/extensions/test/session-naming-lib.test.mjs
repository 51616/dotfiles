// @lat: [[tests#Session naming auto-title flow stays one-shot and respects manual overrides]]
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNamingPrompt,
  fingerprintNamingSourceText,
  getFirstTurnConversation,
  getFirstTurnUserText,
  getLatestSessionInfoEntry,
  hasManualNameOverride,
  hasManualSessionInfoOverride,
  hasUnsafePendingHistory,
  initialStateForSession,
  normalizeProvisionalName,
  pickSessionNamingModel,
  readPersistedState,
  readPersistedStateRecord,
  sanitizeFinalTitleCandidate,
  serializeNamingConversation,
  SESSION_NAMING_MODEL_ID,
  SESSION_NAMING_STATE_TYPE,
} from "../session-naming/lib/session-naming.ts";

function makeSessionManager(entries, name) {
  return {
    getEntries() {
      return entries;
    },
    getBranch() {
      return entries;
    },
    getSessionName() {
      return name;
    },
  };
}

test("normalizeProvisionalName redacts obvious secrets, collapses whitespace, and keeps ellipsis inside the 30-char budget", () => {
  const result = normalizeProvisionalName("  api key: abc1234567890\nthis title should be much longer than allowed  ");
  assert.equal(result, "api key=[REDACTED] this title…");
  assert.equal(result.length, 30);
});

test("sanitizeFinalTitleCandidate strips wrappers, redacts secrets, trailing punctuation, and normalizes to Title Case", () => {
  assert.equal(sanitizeFinalTitleCandidate('Title: "discord bot compaction bug."\nMore text'), "Discord Bot Compaction Bug");
  assert.equal(sanitizeFinalTitleCandidate("DISCORD BOT COMPACTION FAILURE"), "Discord Bot Compaction Failure");
  assert.equal(sanitizeFinalTitleCandidate("DISCORD-BOT COMPACTION FAILURE"), "Discord-Bot Compaction Failure");
  assert.equal(sanitizeFinalTitleCandidate("GPT-5.3 API FAILURE"), "GPT-5.3 API Failure");
  assert.equal(sanitizeFinalTitleCandidate("• 'gpt api failure'"), "GPT API Failure");
  assert.equal(sanitizeFinalTitleCandidate("api key: sk-abcdefghijklmnopqrstuvwxyz"), "API Key=[REDACTED]");
});

test("pickSessionNamingModel prefers openai-codex before openai", () => {
  const calls = [];
  const registry = {
    find(provider, modelId) {
      calls.push([provider, modelId]);
      if (provider === "openai") return { provider, id: modelId };
      return undefined;
    },
  };

  const model = pickSessionNamingModel(registry);
  assert.deepEqual(calls, [
    ["openai-codex", SESSION_NAMING_MODEL_ID],
    ["openai", SESSION_NAMING_MODEL_ID],
  ]);
  assert.deepEqual(model, { provider: "openai", id: SESSION_NAMING_MODEL_ID });
});

test("initialStateForSession allows only fresh unnamed sessions", () => {
  const fresh = initialStateForSession(makeSessionManager([], undefined), undefined);
  assert.deepEqual(fresh, { version: 1, stage: "idle", eligible: true });

  const withHistory = initialStateForSession(makeSessionManager([{ type: "message" }], undefined), undefined);
  assert.deepEqual(withHistory, { version: 1, stage: "ineligible", eligible: false });

  const modelOnly = initialStateForSession(makeSessionManager([{ type: "model_change" }], undefined), undefined);
  assert.deepEqual(modelOnly, { version: 1, stage: "idle", eligible: true });

  const named = initialStateForSession(makeSessionManager([], "Existing Name"), "Existing Name");
  assert.deepEqual(named, { version: 1, stage: "ineligible", eligible: false });
});

test("readPersistedState returns the latest valid custom state entry", () => {
  const entries = [
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "idle", eligible: true } },
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "done", eligible: false, provisionalNameEntryId: "session-info-1", finalName: "Discord Bot Compaction Bug", firstInputHash: "abc123" } },
  ];
  const state = readPersistedState(entries);
  const record = readPersistedStateRecord(entries);

  assert.deepEqual(state, {
    version: 1,
    stage: "done",
    eligible: false,
    provisionalNameEntryId: "session-info-1",
    finalName: "Discord Bot Compaction Bug",
    firstInputHash: "abc123",
  });
  assert.equal(record?.index, 1);
});

test("hasManualNameOverride treats clears and renames as manual divergence", () => {
  assert.equal(hasManualNameOverride("Manual Name", "provisional name"), true);
  assert.equal(hasManualNameOverride(undefined, "provisional name"), true);
  assert.equal(hasManualNameOverride("provisional name", "provisional name"), false);
});

test("session info entry drift detects manual rename even when the visible title stays the same", () => {
  const entries = [
    { type: "session_info", id: "session-info-1", name: "trace resume bug" },
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true, provisionalName: "trace resume bug", provisionalNameEntryId: "session-info-1" } },
    { type: "session_info", id: "session-info-2", name: "trace resume bug" },
  ];

  assert.deepEqual(getLatestSessionInfoEntry(entries), { index: 2, id: "session-info-2", name: "trace resume bug" });
  assert.equal(hasManualSessionInfoOverride(entries, "session-info-1"), true);
  assert.equal(hasManualSessionInfoOverride(entries, "session-info-2"), false);
});

test("fingerprintNamingSourceText uses normalized redacted text", () => {
  const left = fingerprintNamingSourceText("api key: abc1234567890\ntrace resume bug");
  const right = fingerprintNamingSourceText(" api key=[REDACTED] trace   resume bug ");
  assert.equal(left, right);
  assert.equal(left?.length, 16);
});


test("hasUnsafePendingHistory allows only the first committed user message after pending state", () => {
  assert.equal(hasUnsafePendingHistory([
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true } },
    { type: "message", message: { role: "user" } },
  ], 0), false);

  assert.equal(hasUnsafePendingHistory([
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
  ], 0), true);

  assert.equal(hasUnsafePendingHistory([
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "user" } },
  ], 0), true);

  assert.equal(hasUnsafePendingHistory([
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true } },
    { type: "branch_summary" },
  ], 0), true);

  assert.equal(hasUnsafePendingHistory([
    { type: "custom", customType: SESSION_NAMING_STATE_TYPE, data: { version: 1, stage: "pending-semantic", eligible: true } },
    { type: "message", message: { role: "toolResult" } },
  ], 0), true);
});

test("buildNamingPrompt includes the bounded conversation transcript", () => {
  const prompt = buildNamingPrompt("user: debug compaction\nassistant: investigating");
  assert.match(prompt, /Maximum 48 characters\./);
  assert.match(prompt, /Conversation:/);
  assert.match(prompt, /debug compaction/);
});

test("getFirstTurnConversation ignores tool results and stops after the first completed assistant response or second user", () => {
  const conversation = getFirstTurnConversation([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", stopReason: "toolUse", content: [] },
    { role: "toolResult", content: [{ type: "text", text: "secret" }], toolName: "read", toolCallId: "1" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "later" }] },
  ]);

  assert.deepEqual(conversation.map((message) => message.role), ["user", "assistant", "assistant"]);
  assert.ok(conversation.every((message) => message.role !== "toolResult"));
  assert.equal(conversation.at(-1)?.content?.[0]?.text, "done");
});

test("serializeNamingConversation keeps only bounded user/assistant text, excluding tool args and redacting likely secrets", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: `debug resume path api key: shhh AKIA1234567890ABCDEF github_pat_abcdefghijklmnopqrstuvwxyz eyJaaaaaaaaaa.bbbbbbbbbbb.cccccccccccc ${"x".repeat(800)}` }],
    },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I will inspect the logs" },
        { type: "toolCall", toolName: "read", args: { path: ".env", secret: "TOKEN" } },
      ],
    },
    { role: "toolResult", content: [{ type: "text", text: "TOKEN=abc" }], toolName: "read", toolCallId: "1" },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "The resume bug is in compaction." }] },
  ];
  const transcript = serializeNamingConversation(messages);

  assert.equal(getFirstTurnUserText(messages), "debug resume path api key=[REDACTED] [REDACTED] [REDACTED] [REDACTED]" + ` ${"x".repeat(800)}`);
  assert.match(transcript, /User: debug resume path api key=\[REDACTED\]/);
  assert.doesNotMatch(transcript, /AKIA|github_pat_|eyJ/);
  assert.match(transcript, /Assistant: I will inspect the logs/);
  assert.match(transcript, /Assistant: The resume bug is in compaction\./);
  assert.doesNotMatch(transcript, /TOKEN/);
  assert.doesNotMatch(transcript, /\.env/);
  assert.ok(transcript.length <= 600);
});

test("getFirstTurnConversation still stops at the second user even when assistant stopReason is missing", () => {
  const conversation = getFirstTurnConversation([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "working" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", content: [{ type: "text", text: "later" }] },
  ]);

  assert.deepEqual(conversation.map((message) => message.role), ["user", "assistant"]);
});
