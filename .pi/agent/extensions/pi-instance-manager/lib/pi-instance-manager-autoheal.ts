import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_SERVICE_SCRIPT = path.resolve(
  MODULE_DIR,
  "../../../../.pi/scripts/pi-instance-manager/scripts/service.sh",
);

function resolveServiceScriptFromVaultRoot(vaultRoot: string): string {
  const trimmed = asString(vaultRoot).trim();
  if (!trimmed) return "";

  const root = path.resolve(trimmed);
  const candidate = path.join(root, ".pi", "scripts", "pi-instance-manager", "scripts", "service.sh");
  return fs.existsSync(candidate) ? candidate : "";
}

export function resolveManagerServiceScriptPath(): string {
  const envRoot = asString(process.env.PI_VAULT_ROOT).trim();
  if (envRoot) {
    return resolveServiceScriptFromVaultRoot(envRoot);
  }

  return fs.existsSync(FALLBACK_SERVICE_SCRIPT) ? FALLBACK_SERVICE_SCRIPT : "";
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
