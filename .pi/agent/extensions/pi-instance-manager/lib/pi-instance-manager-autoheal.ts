import fs from "node:fs";
import path from "node:path";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";

function resolveServiceScriptFromVaultRoot(vaultRoot: string): string {
  const trimmed = asString(vaultRoot).trim();
  if (!trimmed) return "";

  const root = path.resolve(trimmed);
  const candidate = path.join(root, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");
  return fs.existsSync(candidate) ? candidate : "";
}

function resolveServiceScriptFromCwd(cwd: string): string {
  const trimmed = asString(cwd).trim();
  if (!trimmed) return "";

  let current = path.resolve(trimmed);
  while (true) {
    const candidate = path.join(current, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return "";
}

export function resolveManagerServiceScriptPath(options?: { cwd?: string }): string {
  const envRoot = asString(process.env.PI_VAULT_ROOT).trim();
  if (envRoot) {
    return resolveServiceScriptFromVaultRoot(envRoot);
  }

  const cwd = asString(options?.cwd ?? process.cwd()).trim();
  return resolveServiceScriptFromCwd(cwd);
}

export function shouldAutoHealManager(
  probe: ManagerStateProbe,
  {
    autoHealInFlight,
    lastAutoHealAt,
    managerDownSince,
    nowMs = Date.now(),
  }: {
    autoHealInFlight: boolean;
    lastAutoHealAt: number;
    managerDownSince: number;
    nowMs?: number;
  },
): boolean {
  if (probe.state) return false;
  if (autoHealInFlight) return false;
  if (nowMs - lastAutoHealAt < 30_000) return false;
  if (managerDownSince > 0 && nowMs - managerDownSince < 1_500) return false;

  const code = asString(probe.errorCode).trim().toUpperCase();
  if (probe.socketPresent && code === "ECONNREFUSED") return true;
  if (!probe.socketPresent && (code === "ENOENT" || code === "SOCKET_CLOSED" || code === "TIMEOUT")) return true;
  return false;
}
