import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type CtxProbeState = {
  isIdle: boolean;
  hasPendingMessages: boolean;
};

/**
 * Some tests (and some host contexts) provide only a minimal ctx object.
 * These helpers preserve the current self-checkpointing defaults:
 * - if `isIdle()` is missing, assume idle
 * - if `hasPendingMessages()` is missing, assume no pending
 */
export function probeCtxState(ctx: ExtensionContext): CtxProbeState {
  const c: any = ctx as any;

  const isIdle = typeof c?.isIdle === "function" ? Boolean(c.isIdle()) : true;
  const hasPendingMessages = typeof c?.hasPendingMessages === "function" ? Boolean(c.hasPendingMessages()) : false;

  return { isIdle, hasPendingMessages };
}
