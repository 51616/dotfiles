import test from "node:test";
import assert from "node:assert/strict";
import { triggerManagerAutoHealRuntime } from "../pi-instance-manager/lib/pi-instance-manager-autoheal-runtime.ts";

test("triggerManagerAutoHealRuntime throttles missing-service-script failures", () => {
  const probe = {
    state: null,
    errorMessage: "connect ENOENT",
    errorCode: "ENOENT",
    socketPath: "/tmp/manager.sock",
    socketPresent: false,
  };

  let lastAutoHealAt = 0;
  let managerUnavailableError = "";
  let statusUpdated = 0;
  let scheduledRetry = 0;

  const prev = process.env.PI_VAULT_ROOT;
  try {
    process.env.PI_VAULT_ROOT = "/tmp/not-a-real-vault-root";

    triggerManagerAutoHealRuntime({
      ctx: null,
      probe,
      autoHealInFlight: false,
      lastAutoHealAt: 0,
      managerDownSince: 0,
      setAutoHealInFlight: () => {},
      setLastAutoHealAt: (value) => {
        lastAutoHealAt = value;
      },
      setManagerUnavailableError: (value) => {
        managerUnavailableError = value;
      },
      scheduleQueueRetry: () => {
        scheduledRetry += 1;
      },
      onStatusUpdated: () => {
        statusUpdated += 1;
      },
    });

    assert.ok(lastAutoHealAt > 0);
    assert.match(managerUnavailableError, /auto-heal unavailable: missing service\.sh/);
    assert.equal(statusUpdated, 1);
    assert.equal(scheduledRetry, 0);
  } finally {
    if (prev === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = prev;
  }
});
