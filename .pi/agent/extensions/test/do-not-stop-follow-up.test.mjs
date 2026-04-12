import test from "node:test";
import assert from "node:assert/strict";
import doNotStop from "../do-not-stop/index.ts";
import { DO_NOT_STOP_PROMPT } from "../do-not-stop/lib/do-not-stop.ts";
import {
  __resetDoNotStopRuntimeStoreForTests,
  getDoNotStopSnapshotForSession,
} from "../do-not-stop/lib/do-not-stop-runtime.ts";

function flushTimers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(options = {}) {
  __resetDoNotStopRuntimeStoreForTests();

  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];
  const notifications = [];
  const editorComponentCalls = [];

  const pi = {
    on(name, handler) {
      handlers.set(String(name), handler);
    },
    registerCommand(name, spec) {
      commands.set(String(name), spec);
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
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setEditorComponent(value) {
        editorComponentCalls.push(value);
      },
    },
  };

  doNotStop(pi);

  return {
    handlers,
    commands,
    sentMessages,
    notifications,
    editorComponentCalls,
    ctx,
  };
}

test("do-not-stop queues a follow-up turn and persists repeat progress", async () => {
  const harness = createHarness();
  const { handlers, commands, ctx } = harness;

  handlers.get("session_start")({}, ctx);
  await commands.get("do-not-stop").handler("on", ctx);
  await commands.get("do-not-stop").handler("repeats 2", ctx);

  handlers.get("input")({ text: "Finish the migration", source: "interactive" }, ctx);
  handlers.get("agent_end")({}, ctx);
  await flushTimers();

  assert.deepEqual(harness.sentMessages, [
    {
      text: DO_NOT_STOP_PROMPT,
      sendOptions: { deliverAs: "followUp" },
    },
  ]);

  assert.deepEqual(getDoNotStopSnapshotForSession("session-1"), {
    enabled: true,
    repeatTarget: 2,
    pendingRepeats: 1,
    completedRepeats: 1,
  });
});

test("do-not-stop restores repeat counters when the follow-up cannot be queued", async () => {
  const harness = createHarness({
    sendUserMessage() {
      throw new Error("queue jam");
    },
  });
  const { handlers, commands, ctx } = harness;

  handlers.get("session_start")({}, ctx);
  await commands.get("do-not-stop").handler("on", ctx);
  await commands.get("do-not-stop").handler("repeats 1", ctx);

  handlers.get("input")({ text: "Audit the queue", source: "interactive" }, ctx);
  handlers.get("agent_end")({}, ctx);
  await flushTimers();

  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(getDoNotStopSnapshotForSession("session-1"), {
    enabled: true,
    repeatTarget: 1,
    pendingRepeats: 1,
    completedRepeats: 0,
  });
  assert.deepEqual(harness.notifications.at(-1), {
    message: "do-not-stop failed to queue follow-up: queue jam",
    level: "warning",
  });
});
