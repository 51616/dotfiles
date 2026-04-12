import test from "node:test";
import assert from "node:assert/strict";
import { compactThenResume } from "../self-checkpointing/lib/self-checkpointing-compaction.ts";

test("compactThenResume still records loader lifecycle hooks and starts compaction in headless mode", () => {
  let pendingRequested = false;
  const statusCalls = [];
  const compactCalls = [];
  const loaderCalls = [];
  const written = [];

  const ctx = {
    hasUI: false,
    compact(options) {
      compactCalls.push(options);
    },
  };

  compactThenResume(
    {
      pid: 123,
      getPendingCompactionRequested: () => pendingRequested,
      setPendingCompactionRequested: (next) => {
        pendingRequested = next;
      },
      ensureCompactionLock: () => true,
      releaseCompactionLock() {},
      setCheckpointCycleActive() {},
      buildResumeText: (checkpointPath) => `resume ${checkpointPath}`,
      buildCustomInstructions: (checkpointPath, extraInstructions) =>
        `${checkpointPath}${extraInstructions ? ` ${extraInstructions}` : ""}`,
      writePending: (_ctx, pending) => {
        written.push(pending);
      },
      sessionIdFor: () => "s-1",
      trySendPendingResume: () => false,
      pushDebug() {},
      setStatus: (_ctx, text) => {
        statusCalls.push(text);
      },
      showCompactionLoader() {
        loaderCalls.push("show");
      },
      clearCompactionLoader() {
        loaderCalls.push("clear");
      },
      cleanupAutotest() {},
      getDebugEnabled: () => false,
      notify() {},
      updateArmedStatus() {},
    },
    ctx,
    "work/log/checkpoints/example.md",
    "keep this",
  );

  assert.equal(pendingRequested, true);
  assert.deepEqual(statusCalls, [undefined]);
  assert.deepEqual(loaderCalls, ["show"]);
  assert.equal(written.length, 1);
  assert.equal(compactCalls.length, 1);
  assert.equal(typeof compactCalls[0].onComplete, "function");
  assert.equal(typeof compactCalls[0].onError, "function");
  assert.match(String(compactCalls[0].customInstructions || ""), /example\.md keep this/);
});
