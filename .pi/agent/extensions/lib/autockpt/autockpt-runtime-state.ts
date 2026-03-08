import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const checkpointCycleActiveKeys = new Set<string>();

function sessionKeyFor(ctx: ExtensionContext | undefined): string {
  try {
    const sid = (ctx as any)?.sessionManager?.getSessionId?.();
    const trimmed = String(sid || "").trim();
    if (trimmed) return `session:${trimmed}`;
  } catch {
    // ignore
  }

  return `process:${process.pid}`;
}

export function isCheckpointCycleActive(ctx: ExtensionContext | undefined): boolean {
  return checkpointCycleActiveKeys.has(sessionKeyFor(ctx));
}

export function setCheckpointCycleActive(ctx: ExtensionContext | undefined, active: boolean): void {
  const key = sessionKeyFor(ctx);
  if (active) {
    checkpointCycleActiveKeys.add(key);
    return;
  }

  checkpointCycleActiveKeys.delete(key);
}

export function clearCheckpointCycleState(ctx: ExtensionContext | undefined): void {
  checkpointCycleActiveKeys.delete(sessionKeyFor(ctx));
}

export function resetCheckpointCycleState(): void {
  checkpointCycleActiveKeys.clear();
}
