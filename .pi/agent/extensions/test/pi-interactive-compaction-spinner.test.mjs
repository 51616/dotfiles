import test from "node:test";
import assert from "node:assert/strict";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";

function createMode({ activeKind }) {
  let clearCount = 0;
  let renderCount = 0;
  let disposeCount = 0;

  const mode = Object.create(InteractiveMode.prototype);
  mode.isInitialized = true;
  mode.runtimeHost = { session: { settingsManager: { getShowTerminalProgress: () => false } } };
  mode.footer = { invalidate() {} };
  mode.activeStatusIndicator = activeKind
    ? {
        kind: activeKind,
        dispose() {
          disposeCount += 1;
        },
      }
    : undefined;
  mode.statusContainer = {
    clear() {
      clearCount += 1;
    },
    addChild() {},
  };
  mode.chatContainer = {
    removeChild() {},
  };
  mode.streamingComponent = undefined;
  mode.streamingMessage = undefined;
  mode.pendingTools = new Map();
  mode.checkShutdownRequested = async () => {};
  mode.ui = {
    terminal: { setProgress() {} },
    getClearOnShrink: () => false,
    requestRender() {
      renderCount += 1;
    },
  };

  return {
    mode,
    getState: () => ({ clearCount, renderCount, disposeCount, activeStatusIndicator: mode.activeStatusIndicator }),
  };
}

test("agent_end preserves the built-in compaction status indicator when compaction is active", async () => {
  const { mode, getState } = createMode({ activeKind: "compaction" });

  await mode.handleEvent({ type: "agent_end" });

  const state = getState();
  assert.equal(state.disposeCount, 0);
  assert.equal(state.clearCount, 0);
  assert.equal(state.activeStatusIndicator?.kind, "compaction");
  assert.equal(state.renderCount, 1);
});

test("agent_end still clears the working status indicator when compaction is not active", async () => {
  const { mode, getState } = createMode({ activeKind: "working" });

  await mode.handleEvent({ type: "agent_end" });

  const state = getState();
  assert.equal(state.disposeCount, 1);
  assert.equal(state.clearCount, 1);
  assert.equal(state.activeStatusIndicator, undefined);
  assert.equal(state.renderCount, 1);
});
