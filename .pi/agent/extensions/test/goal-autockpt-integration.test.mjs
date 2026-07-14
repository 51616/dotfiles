import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import goalExtension, { GOAL_DISPATCH_MARKER_TYPE } from "../goal/index.ts";
import { __resetGoalRuntimeStoreForTests } from "../goal/lib/goal-runtime.ts";
import selfCheckpointing from "../self-checkpointing/index.ts";
import {
  isCheckpointCycleActive,
  resetCheckpointCycleState,
} from "../lib/autockpt/autockpt-runtime-state.ts";

function delay(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAll(handlers, eventName, event, ctx) {
  for (const fn of handlers.get(eventName) || []) {
    await fn(event, ctx);
  }
}

async function settleAgent(handlers, ctx, setIdle) {
  // Match pi 0.80.6: agent_end is emitted while the run is still active; only
  // agent_settled follows the transition back to idle.
  setIdle(false);
  await callAll(handlers, "agent_end", {}, ctx);
  setIdle(true);
  await callAll(handlers, "agent_settled", {}, ctx);
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function latestPendingPath(dir) {
  const files = fs.readdirSync(dir).filter((name) => name.startsWith("pending-resume.") && name.endsWith(".json"));
  if (!files.length) return null;
  files.sort();
  return path.join(dir, files.at(-1));
}

function pendingPathForSession(dir, sessionId) {
  const hash = createHash("sha1").update(sessionId).digest("hex").slice(0, 12);
  return path.join(dir, `pending-resume.${hash}.json`);
}

function writePendingResume(dir, sessionId, checkpointPath) {
  fs.writeFileSync(
    pendingPathForSession(dir, sessionId),
    `${JSON.stringify(
      {
        v: 1,
        checkpointPath,
        resumeText: "We just auto-checkpointed and compacted context. Please continue your work.",
        createdAt: Date.now(),
        attempts: 0,
        ownerPid: process.pid,
        sessionId,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHarness(tmpDir, options = {}) {
  __resetGoalRuntimeStoreForTests();
  resetCheckpointCycleState();

  const handlers = new Map();
  const commands = new Map();
  const branchEntries = [];
  const sentUserMessages = [];
  let compactOptions = null;
  let isIdle = true;
  let auditCalls = 0;

  const pi = {
    __goalExtensionAuditStartDelayMs: 0,
    __goalExtensionAuditRunner: async () => {
      auditCalls += 1;
      return {
        ok: true,
        attempts: 1,
        auditSessionPath: "/tmp/audit.jsonl",
        commands: [],
        audit: {
          decision: "continue",
          confidence: "high",
          summary: "continue",
          completedItems: [],
          remainingItems: ["next"],
          evidence: ["plan.md"],
          sourcePaths: ["plan.md"],
          continuationMessage: "Continue after audit.",
        },
      };
    },
    on(name, handler) {
      const key = String(name);
      const list = handlers.get(key) || [];
      list.push(handler);
      handlers.set(key, list);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
    },
    appendEntry(customType, data) {
      branchEntries.push({ type: "custom", customType, data });
    },
    sendUserMessage(text, options) {
      sentUserMessages.push({ text, options });
      void callAll(
        handlers,
        "before_agent_start",
        {
          prompt: text,
          source: "user",
          triggerMessage: { role: "user", content: [{ type: "text", text }] },
        },
        ctx,
      );
    },
    sendMessage(message) {
      if (message.customType !== GOAL_DISPATCH_MARKER_TYPE) return;
      const triggerMessage = { role: "custom", ...message };
      void (async () => {
        await callAll(handlers, "agent_start", {}, ctx);
        await callAll(handlers, "message_start", { message: triggerMessage }, ctx);
        for (const fn of handlers.get("before_turn_response") || []) {
          const result = await fn({ triggerMessages: [triggerMessage] }, ctx);
          if (result?.message) {
            sentUserMessages.push({ text: String(result.message.content ?? ""), options: { triggerTurn: true } });
          }
        }
      })();
    },
    exec() {
      throw new Error("live audit must be mocked in tests");
    },
  };

  const ctx = {
    cwd: tmpDir,
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: { hasConfiguredAuth: () => true },
    signal: undefined,
    hasUI: false,
    isIdle: () => isIdle,
    hasPendingMessages: () => false,
    abort() {},
    getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
    compact(options) {
      compactOptions = options;
    },
    sessionManager: {
      getSessionId: () => "goal-autockpt-session",
      getSessionFile: () => path.join(tmpDir, "session.jsonl"),
      getBranch: () => branchEntries,
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      setEditorComponent() {},
      confirm: async () => true,
    },
  };

  if (options.goalFirst) {
    goalExtension(pi);
    selfCheckpointing(pi);
  } else {
    selfCheckpointing(pi);
    goalExtension(pi);
  }

  return {
    handlers,
    commands,
    sentUserMessages,
    ctx,
    setIdle(next) {
      isIdle = next;
    },
    getCompactOptions() {
      return compactOptions;
    },
    getAuditCalls() {
      return auditCalls;
    },
  };
}

test("session_start restores checkpoint-cycle blocking from an outstanding pending resume", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-autockpt-session-start-"));
  const checkpointPath = path.join(tmpDir, "checkpoint.md");
  const sessionId = "goal-autockpt-session";
  fs.writeFileSync(checkpointPath, "# checkpoint\n", "utf8");
  writePendingResume(tmpDir, sessionId, checkpointPath);

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: "65",
      },
      async () => {
        const harness = createHarness(tmpDir);
        const { handlers, commands, ctx } = harness;

        await callAll(handlers, "session_start", {}, ctx);
        assert.equal(isCheckpointCycleActive(ctx), true, "pending resume should block goal immediately after session_start");

        await commands.get("goal").handler("finish the auto-checkpoint session-start interaction test", ctx);
        await delay();
        assert.equal(harness.getAuditCalls(), 0);
        assert.equal(harness.sentUserMessages.length, 0, "goal must not start before checkpoint resume is consumed");

        await settleAgent(handlers, ctx, harness.setIdle);
        await delay();
        assert.equal(harness.getAuditCalls(), 0, "goal audit remains blocked by the restored pending resume");

        await callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    resetCheckpointCycleState();
    __resetGoalRuntimeStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session_compact with an existing pending resume beats goal scheduling regardless of handler order", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-autockpt-session-compact-"));
  const checkpointPath = path.join(tmpDir, "checkpoint.md");
  const sessionId = "goal-autockpt-session";
  fs.writeFileSync(checkpointPath, "# checkpoint\n", "utf8");

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: "65",
      },
      async () => {
        const harness = createHarness(tmpDir, { goalFirst: true });
        const { handlers, commands, ctx } = harness;

        await callAll(handlers, "session_start", {}, ctx);
        await commands.get("goal").handler("finish the auto-checkpoint compaction-order interaction test", ctx);
        await delay();
        harness.sentUserMessages.length = 0;

        writePendingResume(tmpDir, sessionId, checkpointPath);
        resetCheckpointCycleState();
        assert.equal(isCheckpointCycleActive(ctx), false, "test starts with only durable pending-resume state");

        await callAll(handlers, "session_compact", { compactionEntry: { id: "c1" }, fromExtension: false }, ctx);
        await delay();

        assert.equal(harness.getAuditCalls(), 0, "goal audit must not win the post-compaction pending-resume race");
        assert.equal(harness.sentUserMessages.length, 1);
        assert.match(harness.sentUserMessages[0].text, /auto-checkpointed and compacted context/);
        assert.equal(isCheckpointCycleActive(ctx), true, "sent-but-unconsumed resume keeps the checkpoint cycle active");

        await callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    resetCheckpointCycleState();
    __resetGoalRuntimeStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/goal audit stays muted while auto-checkpoint pending resume is outstanding", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-autockpt-integration-"));
  const checkpointPath = path.join(tmpDir, "checkpoint.md");
  fs.writeFileSync(checkpointPath, "# checkpoint\n", "utf8");

  try {
    await withEnv(
      {
        PI_SELF_CHECKPOINT_ENABLE: "1",
        PI_SELF_CHECKPOINT_STATE_DIR: tmpDir,
        PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME: "65",
      },
      async () => {
        const harness = createHarness(tmpDir);
        const { handlers, commands, ctx } = harness;

        await callAll(handlers, "session_start", {}, ctx);
        await commands.get("goal").handler("finish the auto-checkpoint interaction test", ctx);
        await delay();
        harness.sentUserMessages.length = 0;

        const footerText = [
          "Checkpoint written.",
          "__pi_compact_instructions_begin__",
          "preserve current goal and checkpoint state",
          "__pi_compact_instructions_end__",
          `__pi_autocheckpoint_done__ path=${checkpointPath}`,
        ].join("\n");

        await callAll(
          handlers,
          "message_end",
          { message: { role: "assistant", content: [{ type: "text", text: footerText }] } },
          ctx,
        );
        await delay();

        const compactOptions = harness.getCompactOptions();
        assert.ok(compactOptions, "checkpoint footer should start compaction");

        harness.setIdle(false);
        await callAll(handlers, "session_compact", { compactionEntry: { id: "c1" }, fromExtension: false }, ctx);
        await compactOptions.onComplete?.({ summary: "summary", firstKeptEntryId: "x", tokensBefore: 100 });

        const pendingPath = latestPendingPath(tmpDir);
        assert.ok(pendingPath, "pending resume should remain when ctx is not idle");
        assert.equal(isCheckpointCycleActive(ctx), true, "pending resume keeps checkpoint cycle active");

        harness.setIdle(true);
        await settleAgent(handlers, ctx, harness.setIdle);
        await delay();

        assert.equal(harness.getAuditCalls(), 0, "goal audit must not start before resume is consumed");
        assert.equal(harness.sentUserMessages.length, 0);

        const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
        await callAll(handlers, "input", { text: pending.resumeText, source: "extension" }, ctx);
        assert.equal(isCheckpointCycleActive(ctx), false, "resume input clears checkpoint cycle active state");

        await settleAgent(handlers, ctx, harness.setIdle);
        await delay();
        assert.equal(harness.getAuditCalls(), 1, "goal may audit again after auto-checkpoint resumes");

        await callAll(handlers, "session_shutdown", {}, ctx);
      },
    );
  } finally {
    resetCheckpointCycleState();
    __resetGoalRuntimeStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
