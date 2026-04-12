import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerInstanceManagerEventHooks } from "../pi-instance-manager/lib/pi-instance-manager-event-hooks.ts";
import { SessionInputQueue } from "../pi-instance-manager/lib/pi-instance-manager-queue.ts";
import { expandPromptTemplateCommand } from "../pi-instance-manager/lib/pi-instance-manager-command-expansion.ts";

function noop() {}
async function noopAsync() {}

test("input hook expands prompt-template commands before queueing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-hook-"));
  const templatePath = path.join(dir, "implement.md");
  fs.writeFileSync(templatePath, "Implement $1 with $2\n", "utf8");

  const handlers = new Map();
  const queue = new SessionInputQueue();
  const enqueuedTexts = [];
  const editorTexts = [];
  const notifications = [];
  let currentSessionId = "";
  let currentSessionFile = "";
  let lastSubmitAt = 0;

  const pi = {
    on(name, handler) {
      const key = String(name);
      const list = handlers.get(key) || [];
      list.push(handler);
      handlers.set(key, list);
    },
  };

  const commandLookup = {
    getCommands: () => [
      {
        name: "implement",
        source: "prompt",
        sourceInfo: { path: templatePath },
      },
    ],
  };

  registerInstanceManagerEventHooks({
    pi,
    queue,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (value) => {
      currentSessionId = value;
    },
    setLastCtx: noop,
    setSessionResyncCurrentFile: (value) => {
      currentSessionFile = value;
    },
    resetExternalWriteExpected: noop,
    refreshTrackedSessionFile: noop,
    resetSessionScopedState: noop,
    ensurePollTimer: noopAsync,
    clearPollTimer: noop,
    clearQueueRetryTimer: noop,
    clearSpinnerTimer: noop,
    stopTurnLockRenew: noop,
    clearSessionResyncState: noop,
    getActiveTurnTicketId: () => "",
    clearActiveTurnTicketId: noop,
    finishTurnTicket: noopAsync,
    getActiveCompactionId: () => "",
    endCompactionById: noopAsync,
    clearActiveCompactionId: noop,
    releaseTurnLock: noopAsync,
    clearUiState: noop,
    beginCompaction: noopAsync,
    endCompaction: noopAsync,
    guardBranchNavigation: async () => ({ cancel: false }),
    getActiveTurnLockToken: () => "",
    getActiveTurnLockSessionId: () => "",
    setAwaitingTurnEnd: noop,
    refreshManagerState: noopAsync,
    pumpInputQueue: noopAsync,
    setManagerUnavailableError: noop,
    setLastLocalSubmitAt: (value) => {
      lastSubmitAt = value;
    },
    enqueueTurnTicket: async (sessionId, text) => {
      enqueuedTexts.push({ sessionId, text });
      return "ticket-1";
    },
    setFooter: noop,
    expandQueuedCommandText: (text) => expandPromptTemplateCommand(text, commandLookup),
  });

  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session-1.jsonl",
    },
    ui: {
      setEditorText: (value) => {
        editorTexts.push(value);
      },
      notify: (text, level) => {
        notifications.push({ text, level });
      },
    },
  };

  try {
    const inputHandlers = handlers.get("input") || [];
    assert.equal(inputHandlers.length, 1);

    const result = await inputHandlers[0]({ source: "user", text: "/implement cache hooks" }, ctx);
    const queued = queue.list("session-1");

    assert.deepEqual(result, { action: "handled" });
    assert.equal(currentSessionId, "session-1");
    assert.equal(currentSessionFile, "/tmp/session-1.jsonl");
    assert.ok(lastSubmitAt > 0);
    assert.equal(enqueuedTexts.length, 1);
    assert.equal(enqueuedTexts[0].sessionId, "session-1");
    assert.equal(enqueuedTexts[0].text.trim(), "Implement cache with hooks");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].text.trim(), "Implement cache with hooks");
    assert.deepEqual(editorTexts, [""]);
    assert.deepEqual(notifications, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
