import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString, type ManagerLock } from "./pi-instance-manager-common.ts";
import { isDiscordPromptOwner } from "./pi-instance-manager-ui.ts";

export async function maybeResumeAfterDiscordTurn({
  ctx,
  sessionFilePath,
  previousLock,
  nextLock,
  hasLocalTurnLock,
  hasPendingQueue,
  compacting,
}: {
  ctx: ExtensionContext;
  sessionFilePath: string;
  previousLock: ManagerLock | null;
  nextLock: ManagerLock | null;
  hasLocalTurnLock: boolean;
  hasPendingQueue: boolean;
  compacting: boolean;
}) {
  const sessionPath = asString(sessionFilePath).trim();
  if (!sessionPath) return;

  const owner = asString(previousLock?.owner).trim();
  const previousToken = asString(previousLock?.token).trim();
  if (!owner || !previousToken || !isDiscordPromptOwner(owner)) return;
  // Only resume after the Discord-owned lock is fully released.
  if (nextLock) return;
  if (hasLocalTurnLock || hasPendingQueue || compacting) return;

  const ctxWithOps = ctx as ExtensionContext & {
    isIdle?: () => boolean;
    switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  };

  const isIdle = typeof ctxWithOps.isIdle === "function" ? Boolean(ctxWithOps.isIdle()) : true;
  if (!isIdle) return;

  if (typeof ctxWithOps.switchSession !== "function") return;

  try {
    await ctxWithOps.switchSession(sessionPath);
  } catch {
    // best effort only
  }
}
