import test from "node:test";
import assert from "node:assert/strict";
import goalExtension from "../goal/index.ts";
import {
  __resetGoalRuntimeStoreForTests,
  getGoalSnapshotForSession,
} from "../goal/lib/goal-runtime.ts";
import {
  resetCheckpointCycleState,
  setCheckpointCycleActive,
} from "../lib/autockpt/autockpt-runtime-state.ts";

function flushTimers() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function createIdleGoalAndClearStarter(harness, objective) {
  await harness.commands.get("goal").handler(objective, harness.ctx);
  await flushTimers();
  harness.sentMessages.length = 0;
}

function createHarness(options = {}) {
  __resetGoalRuntimeStoreForTests();
  resetCheckpointCycleState();

  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];
  const notifications = [];
  const editorComponentCalls = [];
  const appendedEntries = [];
  const statuses = [];
  const confirmations = [];
  const branchEntries = options.branchEntries ?? [];

  const pi = {
    __goalExtensionAuditStartDelayMs: options.auditStartDelayMs ?? 0,
    __goalExtensionAuditRunner:
      options.auditRunner ??
      (async () => ({
        ok: true,
        attempts: 1,
        auditSessionPath: "/tmp/audit.jsonl",
        commands: [],
        audit: {
          decision: "unknown",
          confidence: "low",
          summary: "test default audit",
          completedItems: [],
          remainingItems: ["continue"],
          evidence: ["test"],
          sourcePaths: ["test"],
          continuationMessage: "Continue from the test default audit.",
        },
      })),
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
      branchEntries.push({ type: "custom", customType, data });
    },
    exec() {
      throw new Error("live audit must be mocked in tests");
    },
    sendUserMessage(text, sendOptions) {
      sentMessages.push({ text, sendOptions });
      if (typeof options.sendUserMessage === "function") {
        return options.sendUserMessage(text, sendOptions);
      }
      return undefined;
    },
  };

  const ctx = {
    cwd: options.cwd ?? "/tmp/pi-goal-test",
    model: options.model ?? { provider: "test-provider", id: "test-model" },
    signal: undefined,
    hasUI: options.hasUI ?? true,
    isIdle: () => options.isIdle?.() ?? true,
    hasPendingMessages: () => options.hasPendingMessages?.() ?? false,
    sessionManager: {
      getSessionId: () => (typeof options.sessionId === "function" ? options.sessionId() : options.sessionId ?? "session-1"),
      getSessionFile: () => options.sessionFile ?? "/tmp/pi-goal-session.jsonl",
      getBranch: () => branchEntries,
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setEditorComponent(value) {
        editorComponentCalls.push(value);
      },
      setStatus(key, text) {
        statuses.push({ key, text });
      },
      async confirm(title, message) {
        confirmations.push({ title, message });
        return options.confirmResult ?? true;
      },
    },
  };

  goalExtension(pi);

  return {
    handlers,
    commands,
    sentMessages,
    notifications,
    editorComponentCalls,
    appendedEntries,
    statuses,
    confirmations,
    branchEntries,
    ctx,
  };
}

test("/goal creates an active unlimited goal and starts the first continuation from idle without audit", async () => {
  let auditCalls = 0;
  const harness = createHarness({
    auditRunner: async () => {
      auditCalls += 1;
      throw new Error("first goal start should not audit");
    },
  });

  harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("goal").handler("finish the migration", harness.ctx);
  assert.deepEqual(getGoalSnapshotForSession("session-1"), {
    goalId: getGoalSnapshotForSession("session-1").goalId,
    objective: "finish the migration",
    status: "active",
    turnBudget: null,
    turnsUsed: 0,
    startedAtMs: getGoalSnapshotForSession("session-1").startedAtMs,
    updatedAtMs: getGoalSnapshotForSession("session-1").updatedAtMs,
  });

  await flushTimers();
  assert.equal(auditCalls, 0);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /^Objective:\nfinish the migration/m);
  assert.doesNotMatch(harness.sentMessages[0].text, /Budget\/progress/);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 1);

  harness.handlers.get("input")({ text: "ordinary user input", source: "interactive" }, harness.ctx);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 1);
});

test("/goal rejects vague objectives without arming a goal", async () => {
  const harness = createHarness();
  harness.handlers.get("session_start")({}, harness.ctx);

  await harness.commands.get("goal").handler("goal", harness.ctx);
  await flushTimers();

  assert.equal(getGoalSnapshotForSession("session-1"), null);
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.notifications.at(-1).message, /concrete, verifiable objective/);
});

test("session restore clears an existing vague goal", () => {
  const vagueGoal = {
    goalId: "goal-vague",
    objective: "goal",
    status: "active",
    turnBudget: null,
    turnsUsed: 3,
    startedAtMs: 1000,
    updatedAtMs: 2000,
  };
  const harness = createHarness({
    branchEntries: [{ type: "custom", customType: "goal-state", data: { goal: vagueGoal } }],
  });

  harness.handlers.get("session_start")({}, harness.ctx);

  assert.equal(getGoalSnapshotForSession("session-1"), null);
  assert.equal(harness.appendedEntries.at(-1).customType, "goal-state");
  assert.deepEqual(harness.appendedEntries.at(-1).data.goal, null);
  assert.match(harness.notifications.at(-1).message, /cleared invalid restored goal: goal/);
});

test("blank command during a running turn adopts the previous user message", async () => {
  const harness = createHarness({ isIdle: () => false });
  harness.handlers.get("session_start")({}, harness.ctx);
  harness.handlers.get("before_agent_start")(
    { source: "user", prompt: "fix the failing auth tests", triggerMessage: { role: "user" } },
    harness.ctx,
  );

  await harness.commands.get("goal").handler("", harness.ctx);

  const snapshot = getGoalSnapshotForSession("session-1");
  assert.equal(snapshot.objective, "fix the failing auth tests");
  assert.equal(snapshot.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("blank command does not adopt a previous session message after session switch", async () => {
  let sessionId = "session-a";
  const harness = createHarness({ isIdle: () => false, sessionId: () => sessionId });
  harness.handlers.get("session_start")({}, harness.ctx);
  harness.handlers.get("before_agent_start")(
    { source: "user", prompt: "message from session a", triggerMessage: { role: "user" } },
    harness.ctx,
  );

  sessionId = "session-b";
  harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("goal").handler("", harness.ctx);

  assert.equal(getGoalSnapshotForSession("session-b"), null);
  assert.match(harness.notifications.at(-1).message, /could not find a previous user message/);
});

test("agent_end waits for the configured audit delay before auditing", async () => {
  let auditCalls = 0;
  const harness = createHarness({
    auditStartDelayMs: 35,
    auditRunner: async () => {
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
          continuationMessage: "Next after audit delay.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(auditCalls, 0);
  assert.equal(harness.sentMessages.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(auditCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /Next after audit delay/);
});

test("agent_end runs audit, sends anchored follow-up, and increments turns after dispatch", async () => {
  const harness = createHarness({
    auditRunner: async (_goal, prompt) => {
      assert.match(prompt, /external progress\/completion auditor/);
      return {
        ok: true,
        attempts: 1,
        auditSessionPath: "/tmp/audit.jsonl",
        commands: [],
        audit: {
          decision: "continue",
          confidence: "high",
          summary: "progress found",
          completedItems: ["spec written"],
          remainingItems: ["implement runtime"],
          evidence: ["plan.md"],
          sourcePaths: ["conductor/tracks/x/plan.md"],
          continuationMessage: "Implement runtime next.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish the migration");

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].sendOptions.deliverAs, "followUp");
  assert.match(harness.sentMessages[0].text, /Original objective:\nfinish the migration/);
  assert.match(harness.sentMessages[0].text, /spec written/);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 2);
});

test("continuation gates are rechecked after audit before dispatch", async () => {
  let pending = false;
  const harness = createHarness({
    hasPendingMessages: () => pending,
    auditRunner: async () => {
      pending = true;
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
          continuationMessage: "Next.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 1);
  assert.equal(getGoalSnapshotForSession("session-1").status, "active");
});

test("agent_end defers audit while an auto-checkpoint cycle is active", async () => {
  let auditCalls = 0;
  const harness = createHarness({
    auditRunner: async () => {
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
          continuationMessage: "Next after checkpoint.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  setCheckpointCycleActive(harness.ctx, true);
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(auditCalls, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 1);

  setCheckpointCycleActive(harness.ctx, false);
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(auditCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /Next after checkpoint/);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 2);
});

test("scheduled audit rechecks auto-checkpoint state before dispatch", async () => {
  let auditCalls = 0;
  const harness = createHarness({
    auditRunner: async () => {
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
          continuationMessage: "Next after delayed checkpoint.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  harness.handlers.get("agent_end")({}, harness.ctx);
  setCheckpointCycleActive(harness.ctx, true);
  await flushTimers();

  assert.equal(auditCalls, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 1);

  setCheckpointCycleActive(harness.ctx, false);
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(auditCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /Next after delayed checkpoint/);
  assert.equal(getGoalSnapshotForSession("session-1").turnsUsed, 2);
});

test("high-confidence complete audit auto-clears the goal after a styled stats notification", async () => {
  const harness = createHarness({
    branchEntries: [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, totalTokens: 150 },
        },
      },
    ],
    auditRunner: async () => ({
      ok: true,
      attempts: 1,
      auditSessionPath: "/tmp/audit.jsonl",
      commands: [],
      audit: {
        decision: "complete",
        confidence: "high",
        summary: "all tests passed",
        completedItems: ["implementation"],
        remainingItems: [],
        evidence: ["node --test passed"],
        sourcePaths: ["test/goal.test.mjs"],
        continuationMessage: "",
      },
    }),
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(getGoalSnapshotForSession("session-1"), null);

  assert.ok(harness.statuses.some((status) => status.key === "goal" && status.text === "⚑ auditing |"));
  assert.ok(harness.statuses.some((status) => status.key === "goal" && status.text === "⚑ goal |"));

  const notification = harness.notifications.at(-1);
  assert.equal(notification.level, "info");
  assert.match(notification.message, /^\x1b\[1mGoal complete:\x1b\[22m/);
  assert.match(stripAnsi(notification.message), /^Goal complete: all tests passed/);
  assert.match(stripAnsi(notification.message), /1 turn, .* total time used, 150 total tokens used \(\+25 cache read\)$/);

  const completedEntry = harness.appendedEntries.find((entry) => entry.data?.goal?.status === "complete");
  assert.equal(completedEntry.data.goal.completionSummary, "all tests passed");
  assert.equal(harness.appendedEntries.at(-1).data.goal, null);
});

test("same-goal updates do not cancel or duplicate an in-flight dispatch", async () => {
  const audits = [];
  const harness = createHarness({
    auditRunner: async (goal) => {
      const gate = deferred();
      audits.push({ goalId: goal.goalId, objective: goal.objective, gate });
      await gate.promise;
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
          continuationMessage: "Next.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  assert.equal(audits.length, 1);

  await harness.commands.get("goal").handler("budget 5", harness.ctx);
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  assert.equal(audits.length, 1);

  audits[0].gate.resolve();
  await flushTimers();
  assert.equal(harness.sentMessages.length, 1);
  const snapshot = getGoalSnapshotForSession("session-1");
  assert.equal(snapshot.turnBudget, 5);
  assert.equal(snapshot.turnsUsed, 2);
});

test("stale audit completion does not clear a newer dispatch lock", async () => {
  const audits = [];
  const harness = createHarness({
    auditRunner: async (goal) => {
      const gate = deferred();
      audits.push({ goalId: goal.goalId, objective: goal.objective, gate });
      await gate.promise;
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
          continuationMessage: "Next.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "first goal");
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  assert.equal(audits.length, 1);

  await harness.commands.get("goal").handler("replace second goal", harness.ctx);
  await flushTimers();
  harness.sentMessages.length = 0;
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  assert.equal(audits.length, 2);

  audits[0].gate.resolve();
  await flushTimers();
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  assert.equal(audits.length, 2);

  audits[1].gate.resolve();
  await flushTimers();
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /second goal/);
});

test("audit failure falls back to unanchored continuation and never completes", async () => {
  const harness = createHarness({
    auditRunner: async () => ({
      ok: false,
      failureReason: "audit timed out",
      attempts: 2,
      auditSessionPath: "/tmp/audit.jsonl",
      commands: [],
      audit: {
        decision: "unknown",
        confidence: "low",
        summary: "Audit unavailable: audit timed out",
        completedItems: [],
        remainingItems: [],
        evidence: [],
        sourcePaths: [],
        continuationMessage: "",
      },
    }),
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.sentMessages[0].text, /audit timed out/);
  assert.notEqual(getGoalSnapshotForSession("session-1").status, "complete");
});

test("budget exhaustion marks budget_limited and stops scheduling", async () => {
  let auditCalls = 0;
  const harness = createHarness({
    auditRunner: async () => {
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
          evidence: [],
          sourcePaths: [],
          continuationMessage: "Next.",
        },
      };
    },
  });
  harness.handlers.get("session_start")({}, harness.ctx);
  await createIdleGoalAndClearStarter(harness, "finish tests");
  await harness.commands.get("goal").handler("budget 2", harness.ctx);

  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();
  harness.handlers.get("agent_end")({}, harness.ctx);
  await flushTimers();

  assert.equal(auditCalls, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(getGoalSnapshotForSession("session-1").status, "budget_limited");
});

test("blank command rejects a vague previous user message", async () => {
  const harness = createHarness({ isIdle: () => false });
  harness.handlers.get("session_start")({}, harness.ctx);
  harness.handlers.get("before_agent_start")(
    { source: "user", prompt: "goal", triggerMessage: { role: "user" } },
    harness.ctx,
  );

  await harness.commands.get("goal").handler("", harness.ctx);

  assert.equal(getGoalSnapshotForSession("session-1"), null);
  assert.match(harness.notifications.at(-1).message, /concrete, verifiable objective/);
});

test("replacement requires UI confirmation or explicit replace in non-UI contexts", async () => {
  const noUi = createHarness({ hasUI: false });
  noUi.handlers.get("session_start")({}, noUi.ctx);
  await noUi.commands.get("goal").handler("first goal", noUi.ctx);
  await noUi.commands.get("goal").handler("second goal", noUi.ctx);
  assert.equal(getGoalSnapshotForSession("session-1").objective, "first goal");
  await noUi.commands.get("goal").handler("replace second goal", noUi.ctx);
  assert.equal(getGoalSnapshotForSession("session-1").objective, "second goal");

  const withUi = createHarness({ confirmResult: false, sessionId: "session-2" });
  withUi.handlers.get("session_start")({}, withUi.ctx);
  await withUi.commands.get("goal").handler("first goal", withUi.ctx);
  await withUi.commands.get("goal").handler("second goal", withUi.ctx);
  assert.equal(getGoalSnapshotForSession("session-2").objective, "first goal");
  assert.equal(withUi.confirmations.length, 1);
});

test("legacy toggle and removed repeats commands give guidance", async () => {
  const toggleHarness = createHarness();
  toggleHarness.handlers.get("session_start")({}, toggleHarness.ctx);
  await toggleHarness.commands.get("goal").handler("on", toggleHarness.ctx);
  assert.match(toggleHarness.notifications.at(-1).message, /old goal toggle was removed/);
  assert.equal(getGoalSnapshotForSession("session-1"), null);

  const harness = createHarness({ sessionId: "session-repeats" });
  harness.handlers.get("session_start")({}, harness.ctx);
  await harness.commands.get("goal").handler("repeats 2", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /budget <n>/);
  assert.equal(getGoalSnapshotForSession("session-repeats"), null);
});
