import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ContextUsage =
  | {
      tokens: number | null;
      contextWindow: number;
      percent?: number | null;
    }
  | undefined;

type CompactionLockInfo =
  | {
      pid: number;
      createdAt: number;
      checkpointPath?: string;
      note?: string;
    }
  | null;

export type AutockptCommandDeps = {
  enabled: boolean;
  debugWidgetKey: string;
  getUsage: (ctx: ExtensionContext) => ContextUsage;
  getThresholdPercent: () => number;
  getArmed: () => boolean;
  getPendingCompactionRequested: () => boolean;
  getAutotestInProgress: () => boolean;
  getCompactionLock?: (ctx: ExtensionContext) => CompactionLockInfo;
  isDebugEnabled: () => boolean;
  setDebugEnabled: (next: boolean) => void;
  getDebugLog: () => string[];
  clearDebugLog: () => void;
  renderDebugWidget: (ctx: ExtensionContext) => void;
  updateArmedStatus: (ctx: ExtensionContext) => void;
  pushDebug: (ctx: ExtensionContext, line: string) => void;
  startAutotestFromCommand: (ctx: ExtensionContext, threshold: number) => void;
};

export const AUTOCKPT_HELP_TEXT =
  "Usage: /autockpt [status|log|clear|debug on|debug off|threshold <pct>|threshold reset|test [<pct>]]";

export function parseAutockptPercent(raw: string, fallback?: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback ?? null;
  }

  const next = Number.parseFloat(trimmed);
  if (!Number.isFinite(next) || next < 0 || next > 100) {
    return null;
  }

  return next;
}

function buildLockLine(lock: CompactionLockInfo): string {
  if (!lock) return "compactionLock: none";
  const ageSec = Math.max(0, Math.floor((Date.now() - lock.createdAt) / 1000));
  const checkpoint = lock.checkpointPath ? ` checkpoint=${lock.checkpointPath}` : "";
  return `compactionLock: pid=${lock.pid} ageSec=${ageSec}${checkpoint}`;
}

function buildStatusLines(
  deps: AutockptCommandDeps,
  ctx: ExtensionContext,
): { statusLines: string[]; threshold: number } {
  const usage = deps.getUsage(ctx);
  const pct = usage?.percent;
  const tokens = usage?.tokens;
  const win = usage?.contextWindow;
  const threshold = deps.getThresholdPercent();
  const lock = deps.getCompactionLock ? deps.getCompactionLock(ctx) : null;

  return {
    threshold,
    statusLines: [
      `enabled=${deps.enabled} threshold=${threshold}%`,
      `armed=${deps.getArmed()} pendingCompactionRequested=${deps.getPendingCompactionRequested()} autotestInProgress=${deps.getAutotestInProgress()}`,
      buildLockLine(lock),
      `usage: tokens=${tokens ?? "?"} pct=${pct ?? "?"} window=${win ?? "?"}`,
      `debugEnabled=${deps.isDebugEnabled()} (set env PI_SELF_CHECKPOINT_DEBUG=1 for auto-widget)`,
    ],
  };
}

export function registerAutockptCommand(pi: ExtensionAPI, deps: AutockptCommandDeps) {
  pi.registerCommand("autockpt", {
    description: "Debug/status controls for auto-checkpointing",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const { statusLines, threshold } = buildStatusLines(deps, ctx);

      const showStatusWidget = () => {
        if (!ctx.hasUI) return;
        ctx.ui.setWidget(
          deps.debugWidgetKey,
          [
            "[autockpt status]",
            ...statusLines,
            "",
            "[recent events]",
            ...(deps.getDebugLog().length ? deps.getDebugLog().slice(-15) : ["(none)"]),
          ],
          { placement: "aboveEditor" },
        );
      };

      if (a === "" || a === "status") {
        showStatusWidget();
        ctx.ui.notify("autockpt status shown in widget", "info");
        return;
      }

      if (a === "log") {
        deps.renderDebugWidget(ctx);
        ctx.ui.notify("autockpt log shown in widget", "info");
        return;
      }

      if (a === "clear") {
        deps.clearDebugLog();
        if (ctx.hasUI) ctx.ui.setWidget(deps.debugWidgetKey, undefined);
        ctx.ui.notify("autockpt debug log cleared", "info");
        return;
      }

      if (a === "debug on") {
        deps.setDebugEnabled(true);
        deps.renderDebugWidget(ctx);
        ctx.ui.notify("autockpt debug widget enabled", "info");
        return;
      }

      if (a === "debug off") {
        deps.setDebugEnabled(false);
        if (ctx.hasUI) ctx.ui.setWidget(deps.debugWidgetKey, undefined);
        ctx.ui.notify("autockpt debug widget disabled", "info");
        return;
      }

      if (a.startsWith("threshold")) {
        const rest = a.slice("threshold".length).trim();
        if (rest === "" || rest === "reset") {
          delete process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME;
          const nextThreshold = deps.getThresholdPercent();
          deps.pushDebug(ctx, `threshold reset to ${nextThreshold}% (runtime override cleared)`);
          ctx.ui.notify(`autockpt threshold reset to ${nextThreshold}%`, "info");
          deps.updateArmedStatus(ctx);
          return;
        }

        const next = parseAutockptPercent(rest);
        if (next === null) {
          ctx.ui.notify("Invalid threshold. Use: /autockpt threshold <0..100>", "warning");
          return;
        }

        process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME = String(next);
        const nextThreshold = deps.getThresholdPercent();
        deps.pushDebug(ctx, `threshold set to ${nextThreshold}% (runtime override)`);
        ctx.ui.notify(`autockpt threshold set to ${nextThreshold}%`, "info");
        deps.updateArmedStatus(ctx);
        return;
      }

      if (a.startsWith("test")) {
        const rest = a.slice("test".length).trim();
        const next = parseAutockptPercent(rest, 1);
        if (next === null) {
          ctx.ui.notify("Invalid test threshold. Use: /autockpt test [0..100]", "warning");
          return;
        }

        deps.startAutotestFromCommand(ctx, next);
        return;
      }

      if (a === "help") {
        ctx.ui.notify(AUTOCKPT_HELP_TEXT, "info");
        return;
      }

      ctx.ui.notify(`Unknown args: '${a}'. Try: /autockpt help`, "warning");
    },
  });
}
