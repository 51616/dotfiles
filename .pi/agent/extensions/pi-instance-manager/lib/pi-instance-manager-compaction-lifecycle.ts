import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asString } from "./pi-instance-manager-common.ts";

type ManagerRequestFn = (op: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export async function beginCompactionLifecycle({
  ctx,
  managerRequest,
  setCurrentSessionId,
  refreshTrackedSessionFile,
  setLocalCompactingSessionId,
  setLocalCompactingUntil,
  setFooter,
  setActiveCompactionId,
  leaseMs = 20 * 60 * 1000,
}: {
  ctx: ExtensionContext;
  managerRequest: ManagerRequestFn;
  setCurrentSessionId: (value: string) => void;
  refreshTrackedSessionFile: (ctx: ExtensionContext) => void;
  setLocalCompactingSessionId: (value: string) => void;
  setLocalCompactingUntil: (value: number) => void;
  setFooter: (ctx: ExtensionContext) => void;
  setActiveCompactionId: (value: string) => void;
  leaseMs?: number;
}) {
  const sid = asString(ctx.sessionManager.getSessionId()).trim();
  if (!sid) return;

  setCurrentSessionId(sid);
  refreshTrackedSessionFile(ctx);
  setLocalCompactingSessionId(sid);
  setLocalCompactingUntil(Date.now() + leaseMs);
  if (ctx.hasUI) setFooter(ctx);

  try {
    const data = await managerRequest(
      "compaction.begin",
      {
        sessionId: sid,
        pid: process.pid,
        owner: `pi:${process.pid}`,
        leaseMs,
      },
      1200,
    );
    const id = asString(data?.compactionId).trim();
    if (id) setActiveCompactionId(id);
  } catch {
    // keep local compacting marker as fallback
  }
}

export async function endCompactionLifecycle({
  ctx,
  managerRequest,
  activeCompactionId,
  setLocalCompactingSessionId,
  setLocalCompactingUntil,
  setActiveCompactionId,
  setFooter,
  pumpInputQueue,
}: {
  ctx: ExtensionContext;
  managerRequest: ManagerRequestFn;
  activeCompactionId: string;
  setLocalCompactingSessionId: (value: string) => void;
  setLocalCompactingUntil: (value: number) => void;
  setActiveCompactionId: (value: string) => void;
  setFooter: (ctx: ExtensionContext) => void;
  pumpInputQueue: (ctx: ExtensionContext) => Promise<void>;
}) {
  setLocalCompactingUntil(0);
  setLocalCompactingSessionId("");

  try {
    if (activeCompactionId) {
      await managerRequest("compaction.end", { compactionId: activeCompactionId }, 1200);
    }
  } catch {
    // ignore
  } finally {
    setActiveCompactionId("");
    if (ctx.hasUI) setFooter(ctx);
    await pumpInputQueue(ctx);
  }
}
