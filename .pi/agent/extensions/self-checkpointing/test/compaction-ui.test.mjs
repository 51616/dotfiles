import assert from "node:assert/strict";
import test from "node:test";

import { compactThenResume } from "../lib/self-checkpointing-compaction.ts";

function createDeps() {
  let pendingCompactionRequested = false;
  const events = [];
  const releaseReasons = [];
  const resumeReasons = [];
  const statuses = [];
  const pendingWrites = [];

  return {
    deps: {
      pid: 123,
      getPendingCompactionRequested: () => pendingCompactionRequested,
      setPendingCompactionRequested: (next) => {
        pendingCompactionRequested = next;
      },
      ensureCompactionLock: () => true,
      releaseCompactionLock: (_ctx, reason) => {
        releaseReasons.push(reason);
      },
      setCheckpointCycleActive: () => {},
      buildResumeText: (checkpointPath) => `resume:${checkpointPath}`,
      buildCustomInstructions: (checkpointPath, extraInstructions) =>
        `compact:${checkpointPath}:${extraInstructions || ""}`,
      writePending: (_ctx, pending) => {
        pendingWrites.push(pending);
      },
      sessionIdFor: () => "session-1",
      trySendPendingResume: (_ctx, reason) => {
        resumeReasons.push(reason);
        return true;
      },
      pushDebug: () => {},
      setStatus: (_ctx, text) => {
        statuses.push(text);
      },
      showCompactionLoader: (_ctx, label) => {
        events.push({ type: "show", label });
      },
      clearCompactionLoader: () => {
        events.push({ type: "clear" });
      },
      cleanupAutotest: () => {},
      getDebugEnabled: () => false,
      notify: () => {},
      updateArmedStatus: () => {},
    },
    getPendingCompactionRequested: () => pendingCompactionRequested,
    events,
    releaseReasons,
    resumeReasons,
    statuses,
    pendingWrites,
  };
}

test("compactThenResume shows and clears the compaction loader on completion", async () => {
  const state = createDeps();
  let compactOptions;
  const ctx = {
    hasUI: true,
    compact: (options) => {
      compactOptions = options;
    },
  };

  compactThenResume(state.deps, ctx, "work/log/checkpoints/done.md", "focus recent changes");

  assert.equal(state.getPendingCompactionRequested(), true);
  assert.deepEqual(state.events, [{ type: "show", label: undefined }]);
  assert.equal(state.pendingWrites.length, 1);
  assert.equal(
    compactOptions?.customInstructions,
    "compact:work/log/checkpoints/done.md:focus recent changes",
  );

  await compactOptions?.onComplete?.();

  assert.equal(state.getPendingCompactionRequested(), false);
  assert.deepEqual(state.events, [{ type: "show", label: undefined }, { type: "clear" }]);
  assert.deepEqual(state.releaseReasons, ["compaction_complete"]);
  assert.deepEqual(state.resumeReasons, ["compaction_complete"]);
});

test("compactThenResume clears the compaction loader when ctx.compact throws", () => {
  const state = createDeps();
  const ctx = {
    hasUI: true,
    compact: () => {
      throw new Error("boom");
    },
  };

  compactThenResume(state.deps, ctx, "work/log/checkpoints/fail.md");

  assert.equal(state.getPendingCompactionRequested(), false);
  assert.deepEqual(state.events, [{ type: "show", label: undefined }, { type: "clear" }]);
  assert.deepEqual(state.releaseReasons, ["compaction_throw"]);
  assert.deepEqual(state.resumeReasons, ["compaction_throw"]);
  assert.equal(state.statuses.at(-1), "| Checkpoint: compaction failed (boom) 🔴");
});
