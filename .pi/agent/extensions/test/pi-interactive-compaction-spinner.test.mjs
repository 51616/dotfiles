import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js";

function createMode({ isCompacting, hasAutoCompactionLoader }) {
  let clearCount = 0;
  let renderCount = 0;
  let loadingStopped = 0;

  const mode = Object.create(InteractiveMode.prototype);
  mode.isInitialized = true;
  mode.runtimeHost = {
    session: {
      isCompacting,
      settingsManager: { getShowTerminalProgress: () => false },
    },
  };
  mode.footer = { invalidate() {} };
  mode.loadingAnimation = {
    stop() {
      loadingStopped += 1;
    },
  };
  mode.autoCompactionLoader = hasAutoCompactionLoader ? { stop() {} } : undefined;
  mode.statusContainer = {
    clear() {
      clearCount += 1;
    },
  };
  mode.chatContainer = {
    removeChild() {},
  };
  mode.streamingComponent = undefined;
  mode.streamingMessage = undefined;
  mode.pendingTools = new Map();
  mode.checkShutdownRequested = async () => {};
  mode.ui = {
    requestRender() {
      renderCount += 1;
    },
  };

  return {
    mode,
    getState: () => ({ clearCount, renderCount, loadingStopped }),
  };
}

test("agent_end preserves the built-in compaction loader when compaction is active", async () => {
  const { mode, getState } = createMode({ isCompacting: true, hasAutoCompactionLoader: true });

  await mode.handleEvent({ type: "agent_end" });

  const state = getState();
  assert.equal(state.loadingStopped, 1);
  assert.equal(state.clearCount, 0);
  assert.equal(state.renderCount, 1);
});

test("agent_end still clears the status container when compaction is not active", async () => {
  const { mode, getState } = createMode({ isCompacting: false, hasAutoCompactionLoader: false });

  await mode.handleEvent({ type: "agent_end" });

  const state = getState();
  assert.equal(state.loadingStopped, 1);
  assert.equal(state.clearCount, 1);
  assert.equal(state.renderCount, 1);
});
