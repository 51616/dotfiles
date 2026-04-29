import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";

export async function guardBranchNavigation({
  ctx,
  op,
  activeTurnLockToken,
  activeTurnLockSessionId,
  managerDownSince,
  setManagerDownSince,
  setManagerUnavailableError,
  probeManagerState,
  triggerManagerAutoHeal,
}: {
  ctx: ExtensionContext;
  op: "tree" | "fork" | "clone";
  activeTurnLockToken: string;
  activeTurnLockSessionId: string;
  managerDownSince: number;
  setManagerDownSince: (value: number) => void;
  setManagerUnavailableError: (value: string) => void;
  probeManagerState: (timeoutMs?: number) => Promise<ManagerStateProbe>;
  triggerManagerAutoHeal: (ctx: ExtensionContext | null, probe: ManagerStateProbe) => void;
}): Promise<{ cancel: boolean }> {
  const sid = asString(ctx.sessionManager.getSessionId()).trim();
  if (!sid) return { cancel: true };

  if (activeTurnLockToken && activeTurnLockSessionId === sid) {
    return { cancel: false };
  }

  const probe = await probeManagerState(500);
  if (!probe.state) {
    setManagerUnavailableError(asString(probe.errorMessage).trim() || "state.get failed");
    if (!managerDownSince) setManagerDownSince(Date.now());
    triggerManagerAutoHeal(ctx, probe);
    if (ctx.hasUI) {
      ctx.ui.notify(`/${op} blocked: instance-manager unavailable (fail-closed).`, "warning");
    }
    return { cancel: true };
  }

  return { cancel: false };
}
