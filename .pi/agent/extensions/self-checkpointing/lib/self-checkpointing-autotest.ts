import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type AutotestControllerDeps = {
  flagPath: string;
  maxAgeMs: number;
  maxTurns: number;

  setDebugEnabled: (next: boolean) => void;
  pushDebug: (ctx: ExtensionContext, line: string) => void;
  updateArmedStatus: (ctx: ExtensionContext) => void;
  getThresholdPercent: () => number;

  notify: (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => void;
  sendUserMessage: (text: string) => void;

  buildFlagKickoffMessage: () => string;
  buildCommandKickoffMessage: () => string;
};

export type AutotestController = {
  isInProgress: () => boolean;
  cleanup: (ctx: ExtensionContext, reason: string) => void;
  maybeStartFromFlag: (ctx: ExtensionContext) => void;
  startFromCommand: (ctx: ExtensionContext, requestedThreshold: number) => void;
  onTurnEnd: (ctx: ExtensionContext, pendingCompactionRequested: boolean) => void;
};

export function createAutotestController(deps: AutotestControllerDeps): AutotestController {
  let inProgress = false;
  let prevRuntimeOverride: string | undefined;
  let startedAtMs: number | undefined;
  let turnsSinceStart = 0;

  const isInProgress = () => inProgress;

  const cleanup = (ctx: ExtensionContext, reason: string) => {
    if (!inProgress) return;

    inProgress = false;
    startedAtMs = undefined;
    turnsSinceStart = 0;

    if (prevRuntimeOverride === undefined) {
      delete process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME;
    } else {
      process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME = prevRuntimeOverride;
    }

    const thresholdNow = deps.getThresholdPercent();
    deps.pushDebug(ctx, `autotest cleanup (${reason}); threshold now ${thresholdNow}%`);
    deps.updateArmedStatus(ctx);
  };

  const maybeStartFromFlag = (ctx: ExtensionContext) => {
    if (!existsSync(deps.flagPath)) return;

    let raw = "";
    try {
      raw = readFileSync(deps.flagPath, "utf-8");
    } catch {
      raw = "";
    }

    try {
      unlinkSync(deps.flagPath);
    } catch {
      // ignore
    }

    const n = Number.parseFloat(String(raw).trim() || "1");
    const testThreshold = Number.isFinite(n) && n >= 0 && n <= 100 ? n : 1;

    inProgress = true;
    startedAtMs = Date.now();
    turnsSinceStart = 0;

    // Autotest always cleans up the runtime override back to default to avoid leaving it stuck.
    prevRuntimeOverride = undefined;

    deps.setDebugEnabled(true);
    process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME = String(testThreshold);

    deps.pushDebug(ctx, `autotest flag detected; threshold=${testThreshold}% (runtime override set)`);
    deps.notify(ctx, "Auto-checkpoint autotest starting…", "info");

    deps.sendUserMessage(deps.buildFlagKickoffMessage());
  };

  const startFromCommand = (ctx: ExtensionContext, requestedThreshold: number) => {
    deps.setDebugEnabled(true);

    // Preserve prior runtime override so command-based tests don’t permanently mutate state.
    prevRuntimeOverride = process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME;
    process.env.PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME = String(requestedThreshold);

    inProgress = true;
    startedAtMs = Date.now();
    turnsSinceStart = 0;

    const threshold = deps.getThresholdPercent();
    deps.pushDebug(ctx, `autotest start threshold=${threshold}%`);
    deps.notify(ctx, "Starting auto-checkpoint end-to-end test", "info");

    deps.sendUserMessage(deps.buildCommandKickoffMessage());
  };

  const onTurnEnd = (ctx: ExtensionContext, pendingCompactionRequested: boolean) => {
    if (!inProgress) return;

    turnsSinceStart += 1;
    const startedAt = startedAtMs ?? Date.now();
    const ageMs = Date.now() - startedAt;

    if (!pendingCompactionRequested && (turnsSinceStart > deps.maxTurns || ageMs > deps.maxAgeMs)) {
      cleanup(ctx, `timeout (turns=${turnsSinceStart}, ageMs=${ageMs})`);
    }
  };

  return {
    isInProgress,
    cleanup,
    maybeStartFromFlag,
    startFromCommand,
    onTurnEnd,
  };
}
