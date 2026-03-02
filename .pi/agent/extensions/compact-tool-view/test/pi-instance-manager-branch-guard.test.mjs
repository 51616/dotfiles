import test from "node:test";
import assert from "node:assert/strict";
import { guardBranchNavigation } from "../pi-instance-manager/lib/pi-instance-manager-branch-guard.ts";

test("guardBranchNavigation blocks when local turn lock is active", async () => {
  const notices = [];
  const result = await guardBranchNavigation({
    ctx: {
      hasUI: true,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: (text, level) => notices.push({ text, level }) },
    },
    op: "tree",
    activeTurnLockToken: "tok-1",
    activeTurnLockSessionId: "s1",
    managerDownSince: 0,
    setManagerDownSince: () => {},
    setManagerUnavailableError: () => {},
    probeManagerState: async () => ({ state: null, errorMessage: "", errorCode: "", socketPath: "", socketPresent: false }),
    triggerManagerAutoHeal: () => {},
  });

  assert.equal(result.cancel, true);
  assert.match(String(notices[0]?.text || ""), /conversation lock active/);
});

test("guardBranchNavigation fail-closes when manager state is unavailable", async () => {
  let managerDownSince = 0;
  let managerError = "";
  let autoHealCalled = false;

  const result = await guardBranchNavigation({
    ctx: {
      hasUI: false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => {} },
    },
    op: "fork",
    activeTurnLockToken: "",
    activeTurnLockSessionId: "",
    managerDownSince,
    setManagerDownSince: (value) => {
      managerDownSince = value;
    },
    setManagerUnavailableError: (value) => {
      managerError = value;
    },
    probeManagerState: async () => ({ state: null, errorMessage: "state.get failed", errorCode: "", socketPath: "", socketPresent: false }),
    triggerManagerAutoHeal: () => {
      autoHealCalled = true;
    },
  });

  assert.equal(result.cancel, true);
  assert.match(managerError, /state\.get failed/);
  assert.equal(autoHealCalled, true);
  assert.ok(managerDownSince > 0);
});

test("guardBranchNavigation allows branch op when no lock is active", async () => {
  const result = await guardBranchNavigation({
    ctx: {
      hasUI: false,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => {} },
    },
    op: "tree",
    activeTurnLockToken: "",
    activeTurnLockSessionId: "",
    managerDownSince: 0,
    setManagerDownSince: () => {},
    setManagerUnavailableError: () => {},
    probeManagerState: async () => ({
      state: { activeLocks: [], activeCompactions: [], turnQueues: [] },
      errorMessage: "",
      errorCode: "",
      socketPath: "",
      socketPresent: true,
    }),
    triggerManagerAutoHeal: () => {},
  });

  assert.equal(result.cancel, false);
});
