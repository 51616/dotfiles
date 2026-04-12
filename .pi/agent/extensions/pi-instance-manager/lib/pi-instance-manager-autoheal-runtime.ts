import { execFile } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";
import { resolveManagerServiceScriptPath, shouldAutoHealManager } from "./pi-instance-manager-autoheal.ts";

export function triggerManagerAutoHealRuntime({
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

  const attemptedAt = Date.now();
  const serviceScript = resolveManagerServiceScriptPath();
  if (!serviceScript) {
    const reason = asString(probe.errorMessage).trim() || "manager unreachable";
    setLastAutoHealAt(attemptedAt);
    setManagerUnavailableError(`${reason} (auto-heal unavailable: missing service.sh)`);
    onStatusUpdated();
    return;
  }

  setAutoHealInFlight(true);
  setLastAutoHealAt(attemptedAt);

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
