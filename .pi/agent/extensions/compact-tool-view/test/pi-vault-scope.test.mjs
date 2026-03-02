import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  isPathInsideRoot,
  resolveScopedVaultRoot,
  shouldEnableWithinVaultScope,
} from "../lib/shared/pi-vault-scope.ts";

test("isPathInsideRoot enforces vault boundary", () => {
  const root = path.resolve("/tmp/pi-vault-scope/root");
  assert.equal(isPathInsideRoot(root, root), true);
  assert.equal(isPathInsideRoot(root, path.join(root, "agents", "extensions")), true);
  assert.equal(isPathInsideRoot(root, path.resolve("/tmp/pi-vault-scope")), false);
});

test("resolveScopedVaultRoot prefers valid env root and rejects out-of-bound cwd", () => {
  const vault = path.resolve("/tmp/pi-vault-scope/vault");
  const isVaultRoot = (dir) => path.resolve(dir) === vault;

  assert.equal(
    resolveScopedVaultRoot(path.join(vault, "agents"), { envRoot: vault, isVaultRoot }),
    vault,
  );

  assert.equal(
    resolveScopedVaultRoot(path.resolve("/tmp/pi-vault-scope/outside"), { envRoot: vault, isVaultRoot }),
    "",
  );
});

test("resolveScopedVaultRoot falls back to ancestor walk when env root is absent", () => {
  const vault = path.resolve("/tmp/pi-vault-scope/fallback-vault");
  const nested = path.join(vault, "agents", "extensions", "lib");
  const isVaultRoot = (dir) => path.resolve(dir) === vault;

  assert.equal(resolveScopedVaultRoot(nested, { isVaultRoot }), vault);
  assert.equal(resolveScopedVaultRoot(path.resolve("/tmp/pi-vault-scope/other"), { isVaultRoot }), "");
});

test("shouldEnableWithinVaultScope is fail-closed on predicate errors", () => {
  const result = shouldEnableWithinVaultScope("/tmp/pi-vault-scope/crash", {
    isVaultRoot: () => {
      throw new Error("boom");
    },
  });

  assert.equal(result, false);
});
