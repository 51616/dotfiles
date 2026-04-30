import assert from "node:assert/strict";
import test from "node:test";

import { handleAssistantMessageEnd } from "../lib/self-checkpointing-footer-handler.ts";

function createDeps(events) {
  return {
    autoKick: {
      isInFlight: () => true,
      clearInFlight: (_ctx, reason) => events.push(["clearInFlight", reason]),
      markFooterMatched: () => events.push(["markFooterMatched"]),
    },
    getHandledThisTurn: () => false,
    setHandledThisTurn: (next) => events.push(["setHandledThisTurn", next]),
    setArmed: (next) => events.push(["setArmed", next]),
    getLastHandledFooter: () => null,
    setLastHandledFooter: (next) => events.push(["setLastHandledFooter", next.checkpointPath]),
    getUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
    getThresholdPercent: () => 65,
    getThresholdTokens: () => 192000,
    maxCheckpointAgeMs: 60_000,
    footerDedupeWindowMs: 15_000,
    checkpointProbe: {
      isFreshCheckpointFile: (checkpointPath) => {
        events.push(["isFreshCheckpointFile", checkpointPath]);
        return checkpointPath === "/remote/home/repo/work/log/checkpoints/demo.md";
      },
      inferLatestCheckpointPath: () => null,
    },
    ensureCompactionLock: (_ctx, checkpointPath) => {
      events.push(["ensureCompactionLock", checkpointPath]);
      return true;
    },
    setCheckpointCycleActive: (_ctx, active) => events.push(["setCheckpointCycleActive", active]),
    pushDebug: (_ctx, line) => events.push(["pushDebug", line]),
    isDebugEnabled: () => false,
    notify: (_ctx, msg, level) => events.push(["notify", level, msg]),
    updateArmedStatus: () => events.push(["updateArmedStatus"]),
    startCompaction: (_ctx, checkpointPath, instructions) => events.push(["startCompaction", checkpointPath, instructions]),
  };
}

test("handleAssistantMessageEnd starts compaction synchronously in headless mode", () => {
  const events = [];
  const deps = createDeps(events);
  const ctx = { hasUI: false };
  const event = {
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Checkpoint done.",
            "__pi_compact_instructions_begin__",
            "Preserve state",
            "__pi_compact_instructions_end__",
            "__pi_autocheckpoint_done__ path=/remote/home/repo/work/log/checkpoints/demo.md",
          ].join("\n"),
        },
      ],
    },
  };

  handleAssistantMessageEnd(deps, event, ctx);

  assert.deepEqual(events.map(([name]) => name), [
    "pushDebug",
    "isFreshCheckpointFile",
    "pushDebug",
    "ensureCompactionLock",
    "setLastHandledFooter",
    "pushDebug",
    "setHandledThisTurn",
    "setArmed",
    "markFooterMatched",
    "setCheckpointCycleActive",
    "startCompaction",
  ]);
  assert.equal(events[1][1], "/remote/home/repo/work/log/checkpoints/demo.md");
  assert.equal(events[10][1], "/remote/home/repo/work/log/checkpoints/demo.md");
});

test("handleAssistantMessageEnd drops deferred TUI compaction when ctx becomes stale", async () => {
  const events = [];
  const deps = createDeps(events);
  let active = true;
  const ctx = {
    get hasUI() {
      if (!active) throw new Error("stale ctx");
      return true;
    },
  };
  const event = {
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Checkpoint done.",
            "__pi_compact_instructions_begin__",
            "Preserve state",
            "__pi_compact_instructions_end__",
            "__pi_autocheckpoint_done__ path=/remote/home/repo/work/log/checkpoints/demo.md",
          ].join("\n"),
        },
      ],
    },
  };

  handleAssistantMessageEnd(deps, event, ctx);
  active = false;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(events.some(([name]) => name === "startCompaction"), false);
});
