import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PendingResume } from "../../lib/autockpt/autockpt-pending-resume.ts";

export type CompactThenResumeDeps = {
  pid: number;

  getPendingCompactionRequested: () => boolean;
  setPendingCompactionRequested: (next: boolean) => void;

  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath: string) => boolean;
  releaseCompactionLock: (ctx: ExtensionContext, reason: string) => void;

  setCheckpointCycleActive: (ctx: ExtensionContext, active: boolean) => void;
  refreshCheckpointCycleState: (ctx: ExtensionContext) => void;

  buildResumeText: (checkpointPath: string) => string;
  buildCustomInstructions: (checkpointPath: string, extraInstructions?: string) => string;

  writePending: (ctx: ExtensionContext, p: PendingResume) => void;
  sessionIdFor: (ctx: ExtensionContext) => string;

  trySendPendingResume: (ctx: ExtensionContext, reason: string) => boolean;

  pushDebug: (ctx: ExtensionContext, line: string) => void;
  setStatus: (ctx: ExtensionContext, text?: string) => void;
  showCompactionLoader: (ctx: ExtensionContext, label?: string) => void;
  clearCompactionLoader: (ctx: ExtensionContext) => void;

  cleanupAutotest: (ctx: ExtensionContext, reason: string) => void;
  getDebugEnabled: () => boolean;
  notify: (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => void;
  updateArmedStatus: (ctx: ExtensionContext) => void;
};

function ctxHasUI(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI === true;
  } catch {
    return false;
  }
}

function safeCtxOp(op: () => void): void {
  try {
    op();
  } catch {
    // The context may have been invalidated by compaction/session replacement.
  }
}

async function safeWaitForIdle(ctx: ExtensionContext): Promise<void> {
  try {
    if (typeof (ctx as any).waitForIdle === "function") {
      await (ctx as any).waitForIdle();
    }
  } catch {
    // ignore
  }
}

export function compactThenResume(
  deps: CompactThenResumeDeps,
  ctx: ExtensionContext,
  checkpointPath: string,
  compactionInstructions?: string,
) {
  if (deps.getPendingCompactionRequested()) return;
  if (!deps.ensureCompactionLock(ctx, checkpointPath)) return;

  deps.setPendingCompactionRequested(true);
  deps.setCheckpointCycleActive(ctx, true);

  const resumeText = deps.buildResumeText(checkpointPath);

  // Persist the intent to resume BEFORE compaction, so if compaction abort/reload drops the queued message,
  // we can re-send it once idle.
  deps.writePending(ctx, {
    v: 1,
    checkpointPath,
    resumeText,
    createdAt: Date.now(),
    attempts: 0,
    ownerPid: deps.pid,
    sessionId: deps.sessionIdFor(ctx) || undefined,
  });

  const extra = compactionInstructions?.trim();
  const customInstructions = deps.buildCustomInstructions(checkpointPath, extra);

  deps.pushDebug(
    ctx,
    `compaction start path=${checkpointPath}${extra ? ` instrChars=${extra.length}` : ""}`,
  );
  deps.setStatus(ctx, undefined);
  deps.showCompactionLoader(ctx);

  // NOTE: ctx.compact() aborts the agent operation.
  try {
    ctx.compact({
      customInstructions,
      onComplete: async () => {
        // ctx.compact() can replace/invalidate the extension context before this callback runs.
        // Treat every ctx-dependent action here as best-effort so headless Discord workers don't crash
        // after a successful compaction.
        safeCtxOp(() => deps.clearCompactionLoader(ctx));
        safeCtxOp(() => deps.pushDebug(ctx, "compaction complete"));
        if (deps.getDebugEnabled() && ctxHasUI(ctx)) {
          safeCtxOp(() => deps.notify(ctx, "autockpt: compaction complete; sending resume ping…", "info"));
        }

        safeCtxOp(() => deps.cleanupAutotest(ctx, "compaction complete"));
        await safeWaitForIdle(ctx);

        // After compaction, trigger the resume turn.
        // Do not fallback-send a raw user message here: if this callback fires while the agent is
        // still considered "streaming", sendUserMessage() can throw unless deliverAs is specified.
        // The pending-resume controller + timer will retry safely.
        safeCtxOp(() => {
          deps.trySendPendingResume(ctx, "compaction_complete");
        });

        deps.setPendingCompactionRequested(false);
        safeCtxOp(() => deps.releaseCompactionLock(ctx, "compaction_complete"));
        safeCtxOp(() => deps.refreshCheckpointCycleState(ctx));
        safeCtxOp(() => deps.updateArmedStatus(ctx));
      },
      onError: async (err) => {
        safeCtxOp(() => deps.clearCompactionLoader(ctx));
        safeCtxOp(() => deps.pushDebug(ctx, `compaction error: ${err.message}`));
        if (deps.getDebugEnabled() && ctxHasUI(ctx)) {
          safeCtxOp(() => deps.notify(ctx, `autockpt: compaction failed (${err.message})`, "error"));
        }

        safeCtxOp(() => deps.cleanupAutotest(ctx, "compaction error"));
        safeCtxOp(() => deps.setStatus(ctx, `| Checkpoint: compaction failed (${err.message}) 🔴`));
        await safeWaitForIdle(ctx);

        // Even if compaction failed, still try to continue.
        safeCtxOp(() => {
          deps.trySendPendingResume(ctx, "compaction_error");
        });

        deps.setPendingCompactionRequested(false);
        safeCtxOp(() => deps.releaseCompactionLock(ctx, "compaction_error"));
        safeCtxOp(() => deps.refreshCheckpointCycleState(ctx));
        safeCtxOp(() => deps.updateArmedStatus(ctx));
      },
    });
  } catch (err: any) {
    safeCtxOp(() => deps.clearCompactionLoader(ctx));
    const msg = String(err?.message || err || "unknown error");
    safeCtxOp(() => deps.pushDebug(ctx, `compaction threw: ${msg}`));
    if (deps.getDebugEnabled() && ctxHasUI(ctx)) {
      safeCtxOp(() => deps.notify(ctx, `autockpt: compaction threw (${msg})`, "error"));
    }

    safeCtxOp(() => deps.setStatus(ctx, `| Checkpoint: compaction failed (${msg}) 🔴`));

    // Compaction did not start; release the lock and keep going.
    deps.setPendingCompactionRequested(false);
    safeCtxOp(() => deps.releaseCompactionLock(ctx, "compaction_throw"));
    safeCtxOp(() => deps.refreshCheckpointCycleState(ctx));
    safeCtxOp(() => deps.updateArmedStatus(ctx));

    safeCtxOp(() => {
      deps.trySendPendingResume(ctx, "compaction_throw");
    });
  }
}
