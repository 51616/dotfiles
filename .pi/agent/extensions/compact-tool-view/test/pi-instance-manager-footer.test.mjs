import test from "node:test";
import assert from "node:assert/strict";
import { applyFooterStatus, computeFooterStatusMode } from "../pi-instance-manager/lib/pi-instance-manager-footer.ts";

test("computeFooterStatusMode returns manager_down when manager is unavailable", () => {
  const mode = computeFooterStatusMode({
    currentSessionId: "s-1",
    managerCompactingThisSession: false,
    localCompactingUntil: 0,
    localCompactingSessionId: "",
    managerUnavailableError: "socket missing",
    managerDownSince: Date.now() - 5000,
    awaitingTurnEnd: false,
    activeTurnLockSessionId: "",
    managerLockToken: "",
    activeTurnLockToken: "",
    queueDrainInFlight: false,
    remoteDiscordQueueDepth: 0,
    localQueueDepth: 0,
    nowMs: Date.now(),
  });

  assert.equal(mode, "manager_down");
});

test("applyFooterStatus uses combined queue depth in status line", () => {
  const statusCalls = [];
  const widgetCalls = [];

  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key, value) {
        statusCalls.push({ key, value });
      },
      setWidget(key, value, options) {
        widgetCalls.push({ key, value, options });
      },
    },
  };

  const spinner = { timer: {}, index: 0, mode: "idle" };

  applyFooterStatus({
    ctx,
    spinner,
    queued: [
      { ticketId: "t1", text: "hello", queuedAt: Date.now(), owner: "pi-tui:prompt:session=s-1" },
    ],
    managerLockOwner: "",
    managerUnavailableError: "",
    remoteDiscordQueueDepth: 2,
    statusInput: {
      currentSessionId: "s-1",
      managerCompactingThisSession: false,
      localCompactingUntil: 0,
      localCompactingSessionId: "",
      managerUnavailableError: "",
      managerDownSince: 0,
      awaitingTurnEnd: false,
      activeTurnLockSessionId: "",
      managerLockToken: "",
      activeTurnLockToken: "",
      queueDrainInFlight: false,
      remoteDiscordQueueDepth: 2,
      localQueueDepth: 1,
      nowMs: Date.now(),
    },
  });

  const managerStatus = statusCalls.find((entry) => entry.key === "pi-instance-manager");
  assert.ok(managerStatus);
  assert.match(String(managerStatus.value || ""), /q=3/);

  const helpWidget = widgetCalls.find((entry) => entry.key === "pi-compact-help");
  assert.ok(helpWidget);
});
