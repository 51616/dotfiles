import fs from "node:fs";
import path from "node:path";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";

function isVaultRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, "AGENTS.md")) && fs.existsSync(path.join(dir, "agents"));
}

export function resolveVaultRoot(startDir: string): string {
  const envRoot = asString(process.env.PI_VAULT_ROOT).trim();
  if (envRoot && isVaultRoot(envRoot)) return envRoot;

  let cur = path.resolve(startDir || process.cwd());
  while (true) {
    if (isVaultRoot(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return "";
    cur = parent;
  }
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
