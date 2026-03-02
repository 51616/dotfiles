import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PendingResume } from "../../lib/autockpt/autockpt-pending-resume.ts";

export type CompactThenResumeDeps = {
  pid: number;

  getPendingCompactionRequested: () => boolean;
  setPendingCompactionRequested: (next: boolean) => void;

  ensureCompactionLock: (ctx: ExtensionContext, checkpointPath: string) => boolean;
  releaseCompactionLock: (ctx: ExtensionContext, reason: string) => void;

  setMarkerSuppressed: (on: boolean) => void;

  buildResumeText: (checkpointPath: string) => string;
  buildCustomInstructions: (checkpointPath: string, extraInstructions?: string) => string;

  writePending: (ctx: ExtensionContext, p: PendingResume) => void;
  sessionIdFor: (ctx: ExtensionContext) => string;

  trySendPendingResume: (ctx: ExtensionContext, reason: string) => boolean;

  pushDebug: (ctx: ExtensionContext, line: string) => void;
  setStatus: (ctx: ExtensionContext, text?: string) => void;

  cleanupAutotest: (ctx: ExtensionContext, reason: string) => void;
  getDebugEnabled: () => boolean;
  notify: (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => void;

  sendUserMessage: (text: string) => void;
  updateArmedStatus: (ctx: ExtensionContext) => void;
};

export function compactThenResume(
  deps: CompactThenResumeDeps,
  ctx: ExtensionContext,
  checkpointPath: string,
  compactionInstructions?: string,
) {
  if (deps.getPendingCompactionRequested()) return;
  if (!deps.ensureCompactionLock(ctx, checkpointPath)) return;

  deps.setPendingCompactionRequested(true);
  deps.setMarkerSuppressed(true);

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
  deps.setStatus(ctx, "| Checkpoint: compacting… 🟡");

  // NOTE: ctx.compact() aborts the agent operation.
  try {
    ctx.compact({
      customInstructions,
      onComplete: async () => {
        deps.pushDebug(ctx, "compaction complete");
        if (deps.getDebugEnabled() && ctx.hasUI) {
          deps.notify(ctx, "autockpt: compaction complete; sending resume ping…", "info");
        }

        deps.cleanupAutotest(ctx, "compaction complete");

        try {
          if (typeof (ctx as any).waitForIdle === "function") {
            await (ctx as any).waitForIdle();
          }
        } catch {
          // ignore
        }

        // After compaction, trigger the resume turn.
        // Do not fallback-send a raw user message here: if this callback fires while the agent is
        // still considered "streaming", sendUserMessage() can throw unless deliverAs is specified.
        // The pending-resume controller + timer will retry safely.
        deps.trySendPendingResume(ctx, "compaction_complete");

        deps.setPendingCompactionRequested(false);
        deps.setMarkerSuppressed(false);
        deps.releaseCompactionLock(ctx, "compaction_complete");
        deps.updateArmedStatus(ctx);
      },
      onError: async (err) => {
        deps.pushDebug(ctx, `compaction error: ${err.message}`);
        if (deps.getDebugEnabled() && ctx.hasUI) {
          deps.notify(ctx, `autockpt: compaction failed (${err.message})`, "error");
        }

        deps.cleanupAutotest(ctx, "compaction error");

        deps.setStatus(ctx, `| Checkpoint: compaction failed (${err.message}) 🔴`);

        try {
          if (typeof (ctx as any).waitForIdle === "function") {
            await (ctx as any).waitForIdle();
          }
        } catch {
          // ignore
        }

        // Even if compaction failed, still try to continue.
        deps.trySendPendingResume(ctx, "compaction_error");

        deps.setPendingCompactionRequested(false);
        deps.setMarkerSuppressed(false);
        deps.releaseCompactionLock(ctx, "compaction_error");
        deps.updateArmedStatus(ctx);
      },
    });
  } catch (err: any) {
    const msg = String(err?.message || err || "unknown error");
    deps.pushDebug(ctx, `compaction threw: ${msg}`);
    if (deps.getDebugEnabled() && ctx.hasUI) {
      deps.notify(ctx, `autockpt: compaction threw (${msg})`, "error");
    }

    deps.setStatus(ctx, `| Checkpoint: compaction failed (${msg}) 🔴`);

    // Compaction did not start; release the lock and keep going.
    deps.setPendingCompactionRequested(false);
    deps.setMarkerSuppressed(false);
    deps.releaseCompactionLock(ctx, "compaction_throw");
    deps.updateArmedStatus(ctx);

    deps.trySendPendingResume(ctx, "compaction_throw");
  }
}
