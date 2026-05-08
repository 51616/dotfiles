// @lat: [[do-not-stop#Do not stop]]

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
  isTuiBrokerInstalled,
  registerTuiBrokerEditorBadgeProvider,
  requestTuiBrokerEditorReinstall,
} from "../tui-broker/lib/runtime.ts";
import { fallbackAuditResult, isHighConfidenceComplete } from "./lib/do-not-stop-audit.ts";
import { defaultAuditSessionPath, runDoNotStopAudit, type AuditRunnerOutcome, type AuditSshTarget } from "./lib/do-not-stop-audit-runner.ts";
import { resolveDoNotStopAuditTarget } from "./lib/do-not-stop-audit-target.ts";
import { buildAnchoredContinuationMessage, buildFallbackContinuationMessage, buildInitialGoalMessage } from "./lib/do-not-stop-continuation.ts";
import {
  brightRed,
  buildDoNotStopBorderLabel,
  DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE,
  formatGoalStatusSummary,
  parseDoNotStopCommand,
  usageText,
  validateDoNotStopObjective,
  type DoNotStopGoalState,
} from "./lib/do-not-stop.ts";
import {
  createGoal,
  incrementGoalTurnsUsed,
  markGoalBudgetLimited,
  markGoalCompleteFromAudit,
  replaceGoal,
  setGoalBudget,
  shouldBudgetLimitGoal,
  shouldScheduleGoalContinuation,
} from "./lib/do-not-stop-state.ts";
import {
  getDoNotStopGoalSnapshotForSession,
  saveDoNotStopGoalSnapshot,
  snapshotFromSessionBranch,
} from "./lib/do-not-stop-runtime.ts";
import { buildAuditPrompt, findPreviousUserMessageForGoal } from "./lib/do-not-stop-session.ts";

type BorderColorFn = (str: string) => string;
type AuditRunner = (goal: DoNotStopGoalState, prompt: string, ctx: ExtensionContext, ssh?: AuditSshTarget) => Promise<AuditRunnerOutcome>;

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

function buildDoNotStopEditorIndicator(): string {
  return `─ ${bold("GOAL CHASING!")}`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
  const ui = ctx.ui as unknown as { setStatus?: (key: string, text: string | undefined) => void };
  if (ctx.hasUI && typeof ui.setStatus === "function") ui.setStatus("do-not-stop", text);
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

function getHasPendingMessages(ctx: ExtensionContext): boolean {
  return typeof (ctx as unknown as { hasPendingMessages?: () => boolean }).hasPendingMessages === "function"
    ? Boolean((ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages())
    : false;
}

function isInteractiveUserText(text: string, source?: unknown): boolean {
  const normalized = String(text ?? "").trim();
  if (!normalized) return false;
  if (normalized.startsWith("/")) return false;
  if (String(source ?? "").trim().toLowerCase() === "extension") return false;
  return true;
}

function makeAuditRunner(pi: ExtensionAPI): AuditRunner {
  const injected = (pi as unknown as { __doNotStopAuditRunner?: unknown }).__doNotStopAuditRunner;
  if (typeof injected === "function") return injected as AuditRunner;

  return (goal, prompt, ctx, ssh) =>
    runDoNotStopAudit({
      exec: (command, args, options) => pi.exec(command, args, options),
      prompt,
      cwd: ctx.cwd,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      signal: ctx.signal,
      auditSessionPath: defaultAuditSessionPath(goal.goalId),
      ssh,
    });
}

class DoNotStopEditor extends CustomEditor {
  private baseBorderColor: BorderColorFn;
  private readonly hasGoal: () => boolean;
  private readonly getGoal: () => DoNotStopGoalState | null;

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    hasGoal: () => boolean,
    getGoal: () => DoNotStopGoalState | null,
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

    const labelBase = buildDoNotStopEditorIndicator();
    const withScrollInfo = moreMatch ? `${labelBase} • ${moreMatch[0]}` : labelBase;

    const rawLabel = `${withScrollInfo} `;
    const label = truncateToWidth(rawLabel, Math.max(1, width), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(label)));

    lines[0] = brightRed(`${label}${fill}`);
    return lines;
  }
}

export default function doNotStop(pi: ExtensionAPI) {
  let currentGoal: DoNotStopGoalState | null = null;
  let dispatchScheduled = false;
  let activeDispatchToken: number | null = null;
  let nextDispatchToken = 0;
  let editorOverrideActive = false;
  let activeSessionId = "";
  let lastUserMessage: { sessionId: string; text: string } | null = null;
  const runAudit = makeAuditRunner(pi);

  registerTuiBrokerEditorBadgeProvider("do-not-stop", () => {
    if (!currentGoal) return null;
    return { text: buildDoNotStopEditorIndicator(), priority: 200, borderColor: "#f38ba8" };
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
        (tui, theme, keybindings) => new DoNotStopEditor(tui, theme, keybindings, () => currentGoal !== null, () => currentGoal),
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
    saveDoNotStopGoalSnapshot(sid || activeSessionId, currentGoal);

    if (ctx) {
      try {
        pi.appendEntry(DO_NOT_STOP_GOAL_STATE_ENTRY_TYPE, { goal: currentGoal, recordedAtMs: Date.now() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `do-not-stop could not persist goal entry: ${message}`, "warning");
      }
    }
  };

  const setCurrentGoal = (ctx: ExtensionContext, goal: DoNotStopGoalState | null) => {
    const previousGoalId = currentGoal?.goalId ?? null;
    const nextGoalId = goal?.goalId ?? null;
    currentGoal = goal;
    if (previousGoalId !== nextGoalId) {
      dispatchScheduled = false;
      activeDispatchToken = null;
    }
    setStatus(ctx, currentGoal ? buildDoNotStopBorderLabel(currentGoal) : undefined);
    applyEditorOverride(ctx);
    refreshTuiBrokerEditor();
    persistGoal(ctx);
  };

  const restoreGoalForSession = (ctx: ExtensionContext) => {
    activeSessionId = getSessionId(ctx);
    if (lastUserMessage?.sessionId !== activeSessionId) lastUserMessage = null;
    currentGoal = snapshotFromSessionBranch(getBranchEntries(ctx));
    if (!currentGoal && activeSessionId) {
      currentGoal = getDoNotStopGoalSnapshotForSession(activeSessionId);
    }
    dispatchScheduled = false;
    setStatus(ctx, currentGoal ? buildDoNotStopBorderLabel(currentGoal) : undefined);
    applyEditorOverride(ctx);
    refreshTuiBrokerEditor();
  };

  const createOrReplaceGoal = async (
    ctx: ExtensionContext,
    objective: string,
    options: { explicitReplace?: boolean; allowUiConfirm?: boolean } = {},
  ) => {
    const validation = validateDoNotStopObjective(objective);
    if (!validation.ok) {
      notify(ctx, usageText(validation.guidance), "warning");
      return;
    }

    if (currentGoal && !options.explicitReplace) {
      if (ctx.hasUI && options.allowUiConfirm !== false) {
        const confirmed = await ctx.ui.confirm(
          "Replace /do-not-stop goal?",
          `Current goal:\n${currentGoal.objective}\n\nNew goal:\n${objective}`,
        );
        if (!confirmed) {
          notify(ctx, "do-not-stop goal replacement cancelled", "info");
          return;
        }
      } else {
        notify(ctx, "do-not-stop already has a goal. Use /do-not-stop clear or /do-not-stop replace <objective>.", "warning");
        return;
      }
    }

    const next = currentGoal ? replaceGoal(currentGoal, objective) : createGoal(objective);
    setCurrentGoal(ctx, next);
    notify(ctx, `do-not-stop goal active: ${next.objective}`, "info");
    scheduleGoalContinuation(ctx, { skipAudit: true });
  };

  const buildPromptForGoal = async (goal: DoNotStopGoalState, ctx: ExtensionContext): Promise<{ prompt: string; ssh?: { remote: string; port: number; remoteCwd: string } }> => {
    const target = await resolveDoNotStopAuditTarget(ctx);
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
    if (shouldBudgetLimitGoal(currentGoal)) {
      currentGoal = markGoalBudgetLimited(currentGoal as DoNotStopGoalState);
      applyEditorOverride(ctx);
      refreshTuiBrokerEditor();
      persistGoal(ctx);
      notify(ctx, "do-not-stop goal stopped: turn budget exhausted", "warning");
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

          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "do-not-stop goal stopped: turn budget exhausted", "warning");
            return;
          }

          const goalAtAuditStart = currentGoal;
          let continuation: string;

          if (options.skipAudit) {
            continuation = buildInitialGoalMessage(goalAtAuditStart);
          } else {
            let outcome: AuditRunnerOutcome;
            try {
              setStatus(ctx, "auditing goal…");
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
              setStatus(ctx, currentGoal ? buildDoNotStopBorderLabel(currentGoal) : undefined);
            }

            if (!currentGoal || currentGoal.goalId !== goalAtAuditStart.goalId) return;
            if (activeDispatchToken !== scheduledDispatchToken) return;

            if (outcome.ok && isHighConfidenceComplete(outcome.audit)) {
              setCurrentGoal(ctx, markGoalCompleteFromAudit(currentGoal, outcome.audit));
              notify(ctx, `do-not-stop goal complete: ${outcome.audit.summary}`, "info");
              return;
            }

            continuation = outcome.ok
              ? buildAnchoredContinuationMessage(currentGoal, outcome.audit)
              : buildFallbackContinuationMessage(currentGoal, outcome.failureReason ?? "audit failed");
          }

          if (!currentGoal || currentGoal.goalId !== goalAtAuditStart.goalId) return;
          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "do-not-stop goal stopped: turn budget exhausted", "warning");
            return;
          }

          if (activeDispatchToken !== scheduledDispatchToken || currentGoal.status !== "active" || !ctx.isIdle() || getHasPendingMessages(ctx)) {
            return;
          }

          try {
            pi.sendUserMessage(continuation, { deliverAs: "followUp" });
            setCurrentGoal(ctx, incrementGoalTurnsUsed(currentGoal));
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            notify(ctx, `do-not-stop failed to queue continuation: ${messageText}`, "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `do-not-stop continuation failed: ${message}`, "warning");
        } finally {
          if (activeDispatchToken === scheduledDispatchToken) {
            dispatchScheduled = false;
            activeDispatchToken = null;
          }
        }
      })();
    }, 0);
  };

  pi.registerCommand("do-not-stop", {
    description: "Set an auto-continuation goal (/do-not-stop <objective>|status|clear|budget <n>|replace <objective>)",
    handler: async (args, ctx) => {
      const parsed = parseDoNotStopCommand(args ?? "");

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
          notify(ctx, "do-not-stop could not find a previous user message to use as the goal.", "warning");
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
          notify(ctx, "do-not-stop: no goal is set", "info");
          return;
        }
        setCurrentGoal(ctx, null);
        notify(ctx, "do-not-stop goal cleared", "info");
        return;
      }

      if (parsed.kind === "setBudget") {
        if (!currentGoal) {
          notify(ctx, "do-not-stop budget requires an active goal", "warning");
          return;
        }
        setCurrentGoal(ctx, setGoalBudget(currentGoal, parsed.turnBudget));
        notify(ctx, `do-not-stop budget set to ${parsed.turnBudget === null ? "unlimited" : parsed.turnBudget}`, "info");
        return;
      }

      if (parsed.kind === "unsupported") {
        notify(ctx, usageText(parsed.guidance), "warning");
        return;
      }

      notify(ctx, usageText(parsed.invalid ? `Unknown /do-not-stop arguments: ${parsed.invalid}` : undefined), parsed.invalid ? "warning" : "info");
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
