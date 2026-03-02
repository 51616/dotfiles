import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveMasterVaultRoot,
  shouldEnableMasterServices,
  unitBadge,
} from "../pi-instance-master/lib/pi-instance-master-services.ts";

test("unitBadge renders active/failed states", () => {
  assert.equal(
    unitBadge("Hub", {
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      result: "success",
      restarts: 2,
      error: "",
    }),
    "Hub 🟢 r=2",
  );

  assert.equal(
    unitBadge("Discord", {
      loadState: "loaded",
      activeState: "failed",
      subState: "failed",
      result: "exit-code",
      restarts: 1,
      error: "",
    }),
    "Discord 🔴failed (exit-code) r=1",
  );
});

test("shouldEnableMasterServices respects PI_VAULT_ROOT boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-master-svc-"));
  const vault = path.join(root, "vault");
  const nested = path.join(vault, "agents", "scripts", "pi-router");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# test\n", "utf8");

  const previous = process.env.PI_VAULT_ROOT;
  process.env.PI_VAULT_ROOT = vault;
  try {
    assert.equal(shouldEnableMasterServices(vault), true);
    assert.equal(shouldEnableMasterServices(path.join(vault, "agents")), true);
    assert.equal(shouldEnableMasterServices(root), false);
  } finally {
    if (previous === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveMasterVaultRoot prefers PI_VAULT_ROOT and falls back to cwd ancestry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-master-root-"));
  const vault = path.join(root, "vault");
  const nested = path.join(vault, "agents", "scripts", "pi-router");
  const deep = path.join(vault, "work", "notes");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(vault, "AGENTS.md"), "# test\n", "utf8");

  const previous = process.env.PI_VAULT_ROOT;
  try {
    process.env.PI_VAULT_ROOT = vault;
    assert.equal(resolveMasterVaultRoot(root), vault);

    delete process.env.PI_VAULT_ROOT;
    assert.equal(resolveMasterVaultRoot(deep), vault);
    assert.equal(resolveMasterVaultRoot(root), "");
  } finally {
    if (previous === undefined) delete process.env.PI_VAULT_ROOT;
    else process.env.PI_VAULT_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
