// @lat: [[goal#Goal]]

import { BorderedLoader, CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  isTuiBrokerInstalled,
  registerTuiBrokerEditorBadgeProvider,
  requestTuiBrokerEditorReinstall,
} from "../tui-broker/lib/runtime.ts";
import { fallbackAuditResult, isHighConfidenceComplete } from "./lib/goal-audit.ts";
import { defaultAuditSessionPath, runGoalAudit, type AuditRunnerOutcome, type AuditSshTarget } from "./lib/goal-audit-runner.ts";
import { resolveGoalAuditTarget } from "./lib/goal-audit-target.ts";
import { buildAnchoredContinuationMessage, buildFallbackContinuationMessage, buildInitialGoalMessage } from "./lib/goal-continuation.ts";
import {
  brightRed,
  buildGoalBorderLabel,
  GOAL_STATE_ENTRY_TYPE,
  formatGoalCompletionStats,
  formatGoalStatusSummary,
  parseGoalCommand,
  usageText,
  validateGoalObjective,
  type GoalState,
} from "./lib/goal.ts";
import {
  createGoal,
  incrementGoalTurnsUsed,
  markGoalBudgetLimited,
  markGoalCompleteFromAudit,
  replaceGoal,
  setGoalBudget,
  shouldBudgetLimitGoal,
  shouldScheduleGoalContinuation,
} from "./lib/goal-state.ts";
import {
  getGoalSnapshotForSession,
  saveGoalSnapshot,
  snapshotFromSessionBranch,
} from "./lib/goal-runtime.ts";
import { buildAuditPrompt, findPreviousUserMessageForGoal } from "./lib/goal-session.ts";
import { isCheckpointCycleActive } from "../lib/autockpt/autockpt-runtime-state.ts";

type BorderColorFn = (str: string) => string;
type AuditRunner = (goal: GoalState, prompt: string, ctx: ExtensionContext, ssh?: AuditSshTarget) => Promise<AuditRunnerOutcome>;

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasUiNotify(ctx: ExtensionContext): boolean {
  return Boolean(ctx.hasUI && ctx.ui && typeof ctx.ui.notify === "function");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (hasUiNotify(ctx)) ctx.ui.notify(message, level);
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function buildGoalEditorIndicator(): string {
  return `─ ${bold("⟐ PURSUING GOAL")}`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  const ui = ctx.ui as unknown as { setStatus?: (key: string, text: string | undefined) => void };
  if (ctx.hasUI && typeof ui.setStatus === "function") ui.setStatus("goal", text);
}

function getSessionId(ctx: ExtensionContext): string {
  const raw =
    typeof (ctx as unknown as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager?.getSessionId ===
    "function"
      ? (ctx as unknown as { sessionManager: { getSessionId: () => unknown } }).sessionManager.getSessionId()
      : "";
  return String(raw ?? "").trim();
}

function getBranchEntries(ctx: ExtensionContext): unknown[] {
  const branch =
    typeof (ctx as unknown as { sessionManager?: { getBranch?: () => unknown } }).sessionManager?.getBranch === "function"
      ? (ctx as unknown as { sessionManager: { getBranch: () => unknown } }).sessionManager.getBranch()
      : [];
  return Array.isArray(branch) ? branch : [];
}

type UsageLike = {
  totalTokens?: unknown;
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
};

type MessageEntryLike = {
  type?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    timestamp?: unknown;
    usage?: UsageLike;
  };
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  const direct = finiteNumber(value);
  if (direct !== null) return direct;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type GoalTokenUsage = {
  totalTokens: number;
  cacheReadTokens: number;
};

function nonNegativeNumber(value: unknown): number | null {
  const numberValue = finiteNumber(value);
  return numberValue === null ? null : Math.max(0, numberValue);
}

function assistantUsageTokens(usage: UsageLike | undefined): GoalTokenUsage | null {
  if (!usage) return null;

  const input = nonNegativeNumber(usage.input);
  const output = nonNegativeNumber(usage.output);
  const cacheWrite = nonNegativeNumber(usage.cacheWrite);
  const cacheRead = nonNegativeNumber(usage.cacheRead);
  const hasComponents = input !== null || output !== null || cacheWrite !== null || cacheRead !== null;

  if (hasComponents) {
    return {
      // Subtle but important: usage.totalTokens can include large cached-context reads.
      // Reporting it as "tokens used" made short no-op goals look like 100k+ token jobs.
      totalTokens: (input ?? 0) + (output ?? 0) + (cacheWrite ?? 0),
      cacheReadTokens: cacheRead ?? 0,
    };
  }

  const direct = nonNegativeNumber(usage.totalTokens);
  return direct === null ? null : { totalTokens: direct, cacheReadTokens: 0 };
}

function totalGoalTokensUsed(ctx: ExtensionContext, goal: GoalState): GoalTokenUsage | null {
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let counted = 0;

  for (const rawEntry of getBranchEntries(ctx)) {
    const entry = rawEntry as MessageEntryLike;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;

    const entryTimestampMs = timestampMs(entry.message.timestamp) ?? timestampMs(entry.timestamp);
    if (entryTimestampMs !== null && entryTimestampMs < goal.startedAtMs) continue;

    const tokens = assistantUsageTokens(entry.message.usage);
    if (tokens === null) continue;

    totalTokens += tokens.totalTokens;
    cacheReadTokens += tokens.cacheReadTokens;
    counted += 1;
  }

  return counted > 0 ? { totalTokens, cacheReadTokens } : null;
}

function buildGoalCompletionNotification(ctx: ExtensionContext, goal: GoalState): string {
  const tokens = totalGoalTokensUsed(ctx, goal);
  const stats = formatGoalCompletionStats(goal, {
    totalTokens: tokens?.totalTokens ?? null,
    cacheReadTokens: tokens?.cacheReadTokens ?? null,
  });
  return `${bold("Goal complete:")} ${goal.completionSummary ?? "completed"} — ${stats}`;
}

type LoaderCloser = () => void;

function showAuditLoader(ctx: ExtensionContext, label = "Auditing goal completion…"): LoaderCloser | undefined {
  if (!ctx.hasUI) return undefined;

  let visible = true;
  let closeFromLoader: LoaderCloser | undefined;
  const close = () => {
    if (!visible) return;
    visible = false;
    closeFromLoader?.();
  };

  const ui = ctx.ui as unknown as {
    custom?: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: null) => void) => unknown,
    ) => unknown;
  };

  if (typeof ui.custom !== "function") return undefined;

  try {
    void ui.custom((tui, theme, _keybindings, done) => {
      closeFromLoader = () => done(null);
      const loader = new BorderedLoader(tui as never, theme as never, label);
      loader.onAbort = () => {
        close();
        ctx.abort();
      };
      return loader;
    });
    return close;
  } catch {
    visible = false;
    return undefined;
  }
}

function getHasPendingMessages(ctx: ExtensionContext): boolean {
  return typeof (ctx as unknown as { hasPendingMessages?: () => boolean }).hasPendingMessages === "function"
    ? Boolean((ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages())
    : false;
}

function getAutoCheckpointCycleActive(ctx: ExtensionContext): boolean {
  try {
    return isCheckpointCycleActive(ctx);
  } catch {
    return false;
  }
}

function isInteractiveUserText(text: string, source?: unknown): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (String(source ?? "").trim().toLowerCase() === "extension") return false;
  return true;
}

function makeAuditRunner(pi: ExtensionAPI): AuditRunner {
  const injected = (pi as unknown as { __goalExtensionAuditRunner?: unknown }).__goalExtensionAuditRunner;
  if (typeof injected === "function") return injected as AuditRunner;

  return (goal, prompt, ctx, ssh) =>
    runGoalAudit({
      exec: (command, args, options) => pi.exec(command, args, options),
      prompt,
      cwd: ctx.cwd,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      signal: ctx.signal,
      auditSessionPath: defaultAuditSessionPath(goal.goalId),
      ssh,
    });
}

class GoalEditor extends CustomEditor {
  private baseBorderColor: BorderColorFn;
  private readonly hasGoal: () => boolean;
  private readonly getGoal: () => GoalState | null;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    hasGoal: () => boolean,
    getGoal: () => GoalState | null,
  ) {
    super(tui as never, theme as never, keybindings as never);

    this.hasGoal = hasGoal;
    this.getGoal = getGoal;
    this.baseBorderColor = this.borderColor;

    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => {
        if (this.hasGoal()) return (text: string) => brightRed(text);
        return this.baseBorderColor;
      },
      set: (next: unknown) => {
        if (typeof next === "function") this.baseBorderColor = next as BorderColorFn;
      },
    });
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.hasGoal() || lines.length === 0) return lines;

    const plainTop = stripAnsi(lines[0] ?? "");
    const moreMatch = plainTop.match(/↑\s+\d+\s+more/);

    const labelBase = buildGoalEditorIndicator();
    const withScrollInfo = moreMatch ? `${labelBase} • ${moreMatch[0]}` : labelBase;

    const rawLabel = `${withScrollInfo} `;
    const label = truncateToWidth(rawLabel, Math.max(1, width), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(label)));

    lines[0] = brightRed(`${label}${fill}`);
    return lines;
  }
}

export default function goalExtension(pi: ExtensionAPI) {
  let currentGoal: GoalState | null = null;
  let dispatchScheduled = false;
  let activeDispatchToken: number | null = null;
  let nextDispatchToken = 0;
  let editorOverrideActive = false;
  let activeSessionId = "";
  let lastUserMessage: { sessionId: string; text: string } | null = null;
  const runAudit = makeAuditRunner(pi);

  registerTuiBrokerEditorBadgeProvider("goal", () => {
    if (!currentGoal) return null;
    return { text: buildGoalEditorIndicator(), priority: 200, borderColor: "#f38ba8" };
  });

  const refreshTuiBrokerEditor = () => {
    if (isTuiBrokerInstalled()) requestTuiBrokerEditorReinstall();
  };

  const applyEditorOverride = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    if (isTuiBrokerInstalled()) {
      editorOverrideActive = false;
      return;
    }

    if (currentGoal && !editorOverrideActive) {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new GoalEditor(tui, theme, keybindings, () => currentGoal !== null, () => currentGoal),
      );
      editorOverrideActive = true;
      return;
    }

    if (!currentGoal && editorOverrideActive) {
      ctx.ui.setEditorComponent(undefined);
      editorOverrideActive = false;
    }
  };

  const rememberUserMessage = (ctx: ExtensionContext, text: string) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    lastUserMessage = { sessionId, text: text.trim() };
  };

  const getRememberedUserMessage = (ctx: ExtensionContext): string | null => {
    const sessionId = getSessionId(ctx);
    return sessionId && lastUserMessage?.sessionId === sessionId ? lastUserMessage.text : null;
  };

  const persistGoal = (ctx?: ExtensionContext) => {
    const sid = (ctx ? getSessionId(ctx) : activeSessionId).trim();
    if (sid) activeSessionId = sid;
    saveGoalSnapshot(sid || activeSessionId, currentGoal);

    if (ctx) {
      try {
        pi.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: currentGoal, recordedAtMs: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `goal could not persist goal entry: ${message}`, "warning");
      }
    }
  };

  const setCurrentGoal = (ctx: ExtensionContext, goal: GoalState | null) => {
    const previousGoalId = currentGoal?.goalId ?? null;
    const nextGoalId = goal?.goalId ?? null;
    currentGoal = goal;
    if (previousGoalId !== nextGoalId) {
      dispatchScheduled = false;
      activeDispatchToken = null;
    }
    setStatus(ctx, currentGoal ? buildGoalBorderLabel(currentGoal) : undefined);
    applyEditorOverride(ctx);
    refreshTuiBrokerEditor();
    persistGoal(ctx);
  };

  const restoreGoalForSession = (ctx: ExtensionContext) => {
    activeSessionId = getSessionId(ctx);
    if (lastUserMessage?.sessionId !== activeSessionId) lastUserMessage = null;
    currentGoal = snapshotFromSessionBranch(getBranchEntries(ctx));
    if (!currentGoal && activeSessionId) {
      currentGoal = getGoalSnapshotForSession(activeSessionId);
    }
    dispatchScheduled = false;

    if (currentGoal && !validateGoalObjective(currentGoal.objective).ok) {
      const invalidObjective = currentGoal.objective;
      currentGoal = null;
      setStatus(ctx, undefined);
      applyEditorOverride(ctx);
      refreshTuiBrokerEditor();
      persistGoal(ctx);
      notify(ctx, `goal cleared invalid restored goal: ${invalidObjective}`, "warning");
      return;
    }

    setStatus(ctx, currentGoal ? buildGoalBorderLabel(currentGoal) : undefined);
    applyEditorOverride(ctx);
    refreshTuiBrokerEditor();
  };

  const createOrReplaceGoal = async (
    ctx: ExtensionContext,
    objective: string,
    options: { explicitReplace?: boolean; allowUiConfirm?: boolean } = {},
  ) => {
    const validation = validateGoalObjective(objective);
    if (!validation.ok) {
      notify(ctx, usageText(validation.guidance), "warning");
      return;
    }

    if (currentGoal && !options.explicitReplace) {
      if (ctx.hasUI && options.allowUiConfirm !== false) {
        const confirmed = await ctx.ui.confirm(
          "Replace /goal objective?",
          `Current goal:\n${currentGoal.objective}\n\nNew goal:\n${objective}`,
        );
        if (!confirmed) {
          notify(ctx, "goal replacement cancelled", "info");
          return;
        }
      } else {
        notify(ctx, "a goal is already active. Use /goal clear or /goal replace <objective>.", "warning");
        return;
      }
    }

    const next = currentGoal ? replaceGoal(currentGoal, objective) : createGoal(objective);
    setCurrentGoal(ctx, next);
    notify(ctx, `goal active: ${next.objective}`, "info");
    scheduleGoalContinuation(ctx, { skipAudit: true });
  };

  const buildPromptForGoal = async (goal: GoalState, ctx: ExtensionContext): Promise<{ prompt: string; ssh?: { remote: string; port: number; remoteCwd: string } }> => {
    const target = await resolveGoalAuditTarget(ctx);
    return {
      prompt: buildAuditPrompt({
        goal,
        cwd: target.promptCwd,
        sessionFile: target.promptSessionFile,
        checkpointDir: target.promptCheckpointDir,
        conductorDir: target.promptConductorDir,
        progressHints: ["Also inspect relevant README, TODO, progress, resume, and git status information when available."],
      }),
      ssh: target.ssh,
    };
  };

  const scheduleGoalContinuation = (ctx: ExtensionContext, options: { skipAudit?: boolean } = {}): void => {
    if (getAutoCheckpointCycleActive(ctx)) return;

    if (shouldBudgetLimitGoal(currentGoal)) {
      currentGoal = markGoalBudgetLimited(currentGoal as GoalState);
      applyEditorOverride(ctx);
      refreshTuiBrokerEditor();
      persistGoal(ctx);
      notify(ctx, "goal stopped: turn budget exhausted", "warning");
      return;
    }

    if (
      !shouldScheduleGoalContinuation({
        goal: currentGoal,
        isIdle: ctx.isIdle(),
        hasPendingMessages: getHasPendingMessages(ctx),
        dispatchScheduled,
      })
    ) {
      return;
    }

    const scheduledGoalId = currentGoal?.goalId;
    const scheduledDispatchToken = nextDispatchToken + 1;
    nextDispatchToken = scheduledDispatchToken;
    activeDispatchToken = scheduledDispatchToken;
    dispatchScheduled = true;

    setTimeout(() => {
      void (async () => {
        try {
          if (!currentGoal || currentGoal.goalId !== scheduledGoalId) return;
          if (getAutoCheckpointCycleActive(ctx)) return;

          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "goal stopped: turn budget exhausted", "warning");
            return;
          }

          const goalAtAuditStart = currentGoal;
          let continuation: string;

          if (options.skipAudit) {
            continuation = buildInitialGoalMessage(goalAtAuditStart);
          } else {
            let outcome: AuditRunnerOutcome;
            const closeAuditLoader = showAuditLoader(ctx);
            try {
              setStatus(ctx, "⚑ auditing |");
              const auditInput = await buildPromptForGoal(goalAtAuditStart, ctx);
              outcome = await runAudit(goalAtAuditStart, auditInput.prompt, ctx, auditInput.ssh);
            } catch (error) {
              const failureReason = error instanceof Error ? error.message : String(error);
              outcome = {
                ok: false,
                audit: fallbackAuditResult(failureReason),
                failureReason,
                attempts: 0,
                auditSessionPath: defaultAuditSessionPath(goalAtAuditStart.goalId),
                commands: [],
              };
            } finally {
              closeAuditLoader?.();
              setStatus(ctx, currentGoal ? buildGoalBorderLabel(currentGoal) : undefined);
            }

            if (!currentGoal || currentGoal.goalId !== goalAtAuditStart.goalId) return;
            if (activeDispatchToken !== scheduledDispatchToken) return;

            if (outcome.ok && isHighConfidenceComplete(outcome.audit)) {
              const completedGoal = markGoalCompleteFromAudit(currentGoal, outcome.audit);
              setCurrentGoal(ctx, completedGoal);
              notify(ctx, buildGoalCompletionNotification(ctx, completedGoal), "info");
              setCurrentGoal(ctx, null);
              return;
            }

            continuation = outcome.ok
              ? buildAnchoredContinuationMessage(currentGoal, outcome.audit)
              : buildFallbackContinuationMessage(currentGoal, outcome.failureReason ?? "audit failed");
          }

          if (!currentGoal || currentGoal.goalId !== goalAtAuditStart.goalId) return;
          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "goal stopped: turn budget exhausted", "warning");
            return;
          }

          if (
            activeDispatchToken !== scheduledDispatchToken ||
            currentGoal.status !== "active" ||
            getAutoCheckpointCycleActive(ctx) ||
            !ctx.isIdle() ||
            getHasPendingMessages(ctx)
          ) {
            return;
          }

          try {
            pi.sendUserMessage(continuation, { deliverAs: "followUp" });
            setCurrentGoal(ctx, incrementGoalTurnsUsed(currentGoal));
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            notify(ctx, `goal failed to queue continuation: ${messageText}`, "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `goal continuation failed: ${message}`, "warning");
        } finally {
          if (activeDispatchToken === scheduledDispatchToken) {
            dispatchScheduled = false;
            activeDispatchToken = null;
          }
        }
      })();
    }, 0);
  };

  pi.registerCommand("goal", {
    description: "Set an auto-continuation goal (/goal <objective>|status|clear|budget <n>|replace <objective>)",
    handler: async (args, ctx) => {
      const parsed = parseGoalCommand(args ?? "");

      if (parsed.kind === "blank") {
        if (currentGoal) {
          notify(ctx, formatGoalStatusSummary(currentGoal), "info");
          return;
        }
        if (!ctx.isIdle()) {
          const objective = getRememberedUserMessage(ctx) ?? findPreviousUserMessageForGoal(getBranchEntries(ctx));
          if (objective) {
            await createOrReplaceGoal(ctx, objective, { explicitReplace: false, allowUiConfirm: false });
            return;
          }
          notify(ctx, "goal could not find a previous user message to use as the goal.", "warning");
          return;
        }
        notify(ctx, usageText(), "info");
        return;
      }

      if (parsed.kind === "setObjective") {
        await createOrReplaceGoal(ctx, parsed.objective, { explicitReplace: parsed.replace });
        return;
      }

      if (parsed.kind === "status") {
        notify(ctx, formatGoalStatusSummary(currentGoal), "info");
        return;
      }

      if (parsed.kind === "clear") {
        if (!currentGoal) {
          notify(ctx, "goal: no goal is set", "info");
          return;
        }
        setCurrentGoal(ctx, null);
        notify(ctx, "goal cleared", "info");
        return;
      }

      if (parsed.kind === "setBudget") {
        if (!currentGoal) {
          notify(ctx, "goal budget requires an active goal", "warning");
          return;
        }
        setCurrentGoal(ctx, setGoalBudget(currentGoal, parsed.turnBudget));
        notify(ctx, `goal budget set to ${parsed.turnBudget === null ? "unlimited" : parsed.turnBudget}`, "info");
        return;
      }

      if (parsed.kind === "unsupported") {
        notify(ctx, usageText(parsed.guidance), "warning");
        return;
      }

      notify(ctx, usageText(parsed.invalid ? `Unknown /goal arguments: ${parsed.invalid}` : undefined), parsed.invalid ? "warning" : "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreGoalForSession(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    persistGoal(ctx);
    setStatus(ctx, undefined);
  });

  pi.on("input", (event, ctx) => {
    if (isInteractiveUserText(event.text, (event as { source?: unknown }).source)) {
      rememberUserMessage(ctx, String(event.text));
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (event.source === "user" && isInteractiveUserText(event.prompt, "user")) {
      rememberUserMessage(ctx, event.prompt);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    scheduleGoalContinuation(ctx);
  });
}
