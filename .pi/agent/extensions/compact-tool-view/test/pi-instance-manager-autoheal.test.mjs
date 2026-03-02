import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveVaultRoot, shouldAutoHealManager } from "../pi-instance-manager/lib/pi-instance-manager-autoheal.ts";

function probe({ errorCode = "", socketPresent = false, hasState = false } = {}) {
  return {
    state: hasState ? { compacting: false } : null,
    errorMessage: "",
    errorCode,
    socketPath: "/tmp/manager.sock",
    socketPresent,
  };
}

test("shouldAutoHealManager: allows stale-socket and missing-socket recoverable states", () => {
  const nowMs = Date.now();

  assert.equal(
    shouldAutoHealManager(probe({ errorCode: "ECONNREFUSED", socketPresent: true }), {
      autoHealInFlight: false,
      lastAutoHealAt: 0,
      managerDownSince: 0,
      nowMs,
    }),
    true,
  );

  assert.equal(
    shouldAutoHealManager(probe({ errorCode: "ENOENT", socketPresent: false }), {
      autoHealInFlight: false,
      lastAutoHealAt: 0,
      managerDownSince: 0,
      nowMs,
    }),
    true,
  );
});

test("shouldAutoHealManager: blocks in-flight, cooldown, recent-down, and healthy state", () => {
  const nowMs = Date.now();

  assert.equal(
    shouldAutoHealManager(probe({ errorCode: "ECONNREFUSED", socketPresent: true }), {
      autoHealInFlight: true,
      lastAutoHealAt: 0,
      managerDownSince: 0,
      nowMs,
    }),
    false,
  );

  assert.equal(
    shouldAutoHealManager(probe({ errorCode: "ECONNREFUSED", socketPresent: true }), {
      autoHealInFlight: false,
      lastAutoHealAt: nowMs - 1000,
      managerDownSince: 0,
      nowMs,
    }),
    false,
  );

  assert.equal(
    shouldAutoHealManager(probe({ errorCode: "ECONNREFUSED", socketPresent: true }), {
      autoHealInFlight: false,
      lastAutoHealAt: 0,
      managerDownSince: nowMs - 500,
      nowMs,
    }),
    false,
  );

  assert.equal(
    shouldAutoHealManager(probe({ hasState: true }), {
      autoHealInFlight: false,
      lastAutoHealAt: 0,
      managerDownSince: 0,
      nowMs,
    }),
    false,
  );
});

test("resolveVaultRoot: prefers PI_VAULT_ROOT and falls back to ancestor walk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-autoheal-"));
  const vault = path.join(root, "vault");
  const nested = path.join(vault, "a", "b", "c");
  fs.mkdirSync(path.join(vault, "agents"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# test\n", "utf8");

  const prev = process.env.PI_VAULT_ROOT;
  try {
    process.env.PI_VAULT_ROOT = vault;
    assert.equal(resolveVaultRoot(path.join(root, "outside")), vault);

    delete process.env.PI_VAULT_ROOT;
    assert.equal(resolveVaultRoot(nested), vault);
    assert.equal(resolveVaultRoot(path.join(root, "outside")), "");
  } finally {
    if (prev === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
