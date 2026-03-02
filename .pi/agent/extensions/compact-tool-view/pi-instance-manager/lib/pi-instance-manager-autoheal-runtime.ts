import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";
import { resolveVaultRoot, shouldAutoHealManager } from "./pi-instance-manager-autoheal.ts";

export function triggerManagerAutoHealRuntime({
  cwd,
  ctx,
  probe,
  autoHealInFlight,
  lastAutoHealAt,
  managerDownSince,
  setAutoHealInFlight,
  setLastAutoHealAt,
  setManagerUnavailableError,
  scheduleQueueRetry,
  onStatusUpdated,
}: {
  cwd: string;
  ctx: ExtensionContext | null;
  probe: ManagerStateProbe;
  autoHealInFlight: boolean;
  lastAutoHealAt: number;
  managerDownSince: number;
  setAutoHealInFlight: (value: boolean) => void;
  setLastAutoHealAt: (value: number) => void;
  setManagerUnavailableError: (value: string) => void;
  scheduleQueueRetry: (ms?: number) => void;
  onStatusUpdated: () => void;
}) {
  if (!shouldAutoHealManager(probe, { autoHealInFlight, lastAutoHealAt, managerDownSince })) return;

  const vaultRoot = resolveVaultRoot(cwd);
  if (!vaultRoot) return;

  const serviceScript = path.join(vaultRoot, "agents", "scripts", "pi-instance-manager", "scripts", "service.sh");
  if (!fs.existsSync(serviceScript)) return;

  setAutoHealInFlight(true);
  setLastAutoHealAt(Date.now());

  if (ctx?.hasUI) {
    const reason = probe.socketPresent && asString(probe.errorCode).toUpperCase() === "ECONNREFUSED"
      ? "stale socket"
      : "manager unreachable";
    ctx.ui.notify(`Instance-manager ${reason}; attempting auto-restart...`, "warning");
  }

  execFile("bash", [serviceScript, "restart"], { timeout: 20_000 }, (error) => {
    setAutoHealInFlight(false);
    if (error) {
      const message = error instanceof Error ? error.message : String(error);
      setManagerUnavailableError(`auto-heal restart failed: ${message}`);
    } else {
      setManagerUnavailableError("");
      scheduleQueueRetry(400);
    }
    onStatusUpdated();
  });
}
