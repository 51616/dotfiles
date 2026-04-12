import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveManagerStatusMode,
  isSessionEffectivelyCompacting,
  lockHeldByOtherSessionToken,
} from "../pi-instance-manager/lib/pi-instance-manager-status.ts";

test("lockHeldByOtherSessionToken detects foreign lock holder", () => {
  assert.equal(lockHeldByOtherSessionToken("token-a", "token-a"), false);
  assert.equal(lockHeldByOtherSessionToken("token-a", "token-b"), true);
  assert.equal(lockHeldByOtherSessionToken("", "token-b"), false);
});

test("isSessionEffectivelyCompacting combines local lease and manager state", () => {
  const nowMs = Date.now();
  assert.equal(
    isSessionEffectivelyCompacting({
      sessionId: "s1",
      managerCompactingThisSession: false,
      localCompactingUntil: nowMs + 5000,
      localCompactingSessionId: "s1",
      nowMs,
    }),
    true,
  );

  assert.equal(
    isSessionEffectivelyCompacting({
      sessionId: "s1",
      managerCompactingThisSession: true,
      localCompactingUntil: 0,
      localCompactingSessionId: "",
      nowMs,
    }),
    true,
  );

  assert.equal(
    isSessionEffectivelyCompacting({
      sessionId: "",
      managerCompactingThisSession: true,
      localCompactingUntil: nowMs + 5000,
      localCompactingSessionId: "s1",
      nowMs,
    }),
    false,
  );
});

test("deriveManagerStatusMode resolves priority ordering", () => {
  assert.equal(
    deriveManagerStatusMode({
      currentSessionId: "s1",
      effectiveCompacting: true,
      managerUnavailableError: "",
      managerDownSince: 0,
      awaitingTurnEnd: false,
      activeTurnLockSessionId: "",
      lockHeldByOther: false,
      queueDrainInFlight: false,
      remoteDiscordQueueDepth: 0,
      localQueueDepth: 0,
      nowMs: 5000,
    }),
    "compacting",
  );

  assert.equal(
    deriveManagerStatusMode({
      currentSessionId: "s1",
      effectiveCompacting: false,
      managerUnavailableError: "state.get failed",
      managerDownSince: 1000,
      awaitingTurnEnd: false,
      activeTurnLockSessionId: "",
      lockHeldByOther: false,
      queueDrainInFlight: false,
      remoteDiscordQueueDepth: 0,
      localQueueDepth: 0,
      nowMs: 2500,
    }),
    "manager_down",
  );

  assert.equal(
    deriveManagerStatusMode({
      currentSessionId: "s1",
      effectiveCompacting: false,
      managerUnavailableError: "",
      managerDownSince: 0,
      awaitingTurnEnd: false,
      activeTurnLockSessionId: "",
      lockHeldByOther: false,
      queueDrainInFlight: false,
      remoteDiscordQueueDepth: 1,
      localQueueDepth: 0,
      nowMs: 2500,
    }),
    "waiting_lock",
  );
});
