import test from "node:test";
import assert from "node:assert/strict";
import {
  beginCompactionLifecycle,
  endCompactionLifecycle,
} from "../pi-instance-manager/lib/pi-instance-manager-compaction-lifecycle.ts";

test("beginCompactionLifecycle sets local markers and records active compaction id", async () => {
  let currentSessionId = "";
  let localCompactingSessionId = "";
  let localCompactingUntil = 0;
  let activeCompactionId = "";
  let footerCalls = 0;
  let refreshCalls = 0;

  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "s1" },
  };

  await beginCompactionLifecycle({
    ctx,
    managerRequest: async (op) => {
      assert.equal(op, "compaction.begin");
      return { compactionId: "c-1" };
    },
    setCurrentSessionId: (value) => {
      currentSessionId = value;
    },
    refreshTrackedSessionFile: () => {
      refreshCalls += 1;
    },
    setLocalCompactingSessionId: (value) => {
      localCompactingSessionId = value;
    },
    setLocalCompactingUntil: (value) => {
      localCompactingUntil = value;
    },
    setFooter: () => {
      footerCalls += 1;
    },
    setActiveCompactionId: (value) => {
      activeCompactionId = value;
    },
    leaseMs: 5000,
  });

  assert.equal(currentSessionId, "s1");
  assert.equal(localCompactingSessionId, "s1");
  assert.ok(localCompactingUntil > Date.now());
  assert.equal(activeCompactionId, "c-1");
  assert.equal(footerCalls, 1);
  assert.equal(refreshCalls, 1);
});

test("endCompactionLifecycle clears markers and pumps queue", async () => {
  let localCompactingSessionId = "s1";
  let localCompactingUntil = Date.now() + 1000;
  let activeCompactionId = "c-1";
  let footerCalls = 0;
  let pumpCalls = 0;
  const managerCalls = [];

  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "s1" },
  };

  await endCompactionLifecycle({
    ctx,
    managerRequest: async (op, payload) => {
      managerCalls.push({ op, payload });
      return {};
    },
    activeCompactionId,
    setLocalCompactingSessionId: (value) => {
      localCompactingSessionId = value;
    },
    setLocalCompactingUntil: (value) => {
      localCompactingUntil = value;
    },
    setActiveCompactionId: (value) => {
      activeCompactionId = value;
    },
    setFooter: () => {
      footerCalls += 1;
    },
    pumpInputQueue: async () => {
      pumpCalls += 1;
    },
  });

  assert.equal(localCompactingSessionId, "");
  assert.equal(localCompactingUntil, 0);
  assert.equal(activeCompactionId, "");
  assert.equal(footerCalls, 1);
  assert.equal(pumpCalls, 1);
  assert.deepEqual(managerCalls, [{ op: "compaction.end", payload: { compactionId: "c-1" } }]);
});
