import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveManagerServiceScriptPath,
  shouldAutoHealManager,
} from "../pi-instance-manager/lib/pi-instance-manager-autoheal.ts";

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

test("resolveManagerServiceScriptPath prefers PI_VAULT_ROOT when it points at a valid service script root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-autoheal-"));
  const vault = path.join(root, "vault");
  const serviceScript = path.join(vault, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");
  fs.mkdirSync(path.dirname(serviceScript), { recursive: true });
  fs.writeFileSync(serviceScript, "#!/usr/bin/env bash\n", "utf8");

  const prev = process.env.PI_VAULT_ROOT;
  try {
    process.env.PI_VAULT_ROOT = vault;
    assert.equal(resolveManagerServiceScriptPath(), serviceScript);
  } finally {
    if (prev === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveManagerServiceScriptPath fails fast when PI_VAULT_ROOT is set but invalid", () => {
  const prev = process.env.PI_VAULT_ROOT;
  try {
    process.env.PI_VAULT_ROOT = "/tmp/not-a-real-vault-root";
    assert.equal(resolveManagerServiceScriptPath(), "");
  } finally {
    if (prev === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = prev;
  }
});

test("resolveManagerServiceScriptPath falls back to the nearest cwd ancestor with the manager service script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-im-autoheal-cwd-"));
  const vault = path.join(root, "vault");
  const nestedProject = path.join(vault, "projects", "demo");
  const serviceScript = path.join(vault, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");
  fs.mkdirSync(path.dirname(serviceScript), { recursive: true });
  fs.mkdirSync(nestedProject, { recursive: true });
  fs.writeFileSync(serviceScript, "#!/usr/bin/env bash\n", "utf8");

  const prev = process.env.PI_VAULT_ROOT;
  try {
    delete process.env.PI_VAULT_ROOT;
    assert.equal(resolveManagerServiceScriptPath({ cwd: nestedProject }), serviceScript);
    assert.equal(resolveManagerServiceScriptPath({ cwd: root }), "");
  } finally {
    if (prev === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
