import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerStateProbe } from "./pi-instance-manager-common.ts";
import { findSessionLock } from "./pi-instance-manager-state.ts";

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
  op: "tree" | "fork";
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
    if (ctx.hasUI) {
      ctx.ui.notify(`/${op} blocked: conversation lock active for this session.`, "warning");
    }
    return { cancel: true };
  }

  const probe = await probeManagerState(500);
  const state = probe.state;
  if (!state) {
    setManagerUnavailableError(asString(probe.errorMessage).trim() || "state.get failed");
    if (!managerDownSince) setManagerDownSince(Date.now());
    triggerManagerAutoHeal(ctx, probe);
    if (ctx.hasUI) {
      ctx.ui.notify(`/${op} blocked: instance-manager unavailable (fail-closed).`, "warning");
    }
    return { cancel: true };
  }

  const lock = findSessionLock(state, sid);

  if (!lock) return { cancel: false };

  if (ctx.hasUI) {
    const owner = asString(lock?.owner).trim();
    ctx.ui.notify(`/${op} blocked: conversation lock active${owner ? ` (owner: ${owner})` : ""}.`, "warning");
  }

  return { cancel: true };
}
