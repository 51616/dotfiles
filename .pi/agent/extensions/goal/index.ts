// @lat: [[goal#Goal]]

import { randomUUID } from "node:crypto";
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
import { buildAuditPrompt, findPreviousUserMessageForGoalDetails } from "./lib/goal-session.ts";
import { isCheckpointCycleActive } from "../lib/autockpt/autockpt-runtime-state.ts";

type BorderColorFn = (str: string) => string;
type AuditRunner = (
  goal: GoalState,
  prompt: string,
  ctx: ExtensionContext,
  ssh?: AuditSshTarget,
  signal?: AbortSignal,
) => Promise<AuditRunnerOutcome>;

export const DEFAULT_AUDIT_START_DELAY_MS = 10_000;
export const GOAL_DISPATCH_START_WATCHDOG_MS = 30_000;
// Safety cap for the compactionActive latch. Long enough to outlast any real compaction call
// but short enough that a silent compaction failure does not permanently mute /goal.
export const COMPACTION_WATCHDOG_MS = 10 * 60_000;

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

export const GOAL_DISPATCH_MARKER_TYPE = "goal-dispatch-marker";
export const GOAL_DISPATCH_INSTRUCTION_TYPE = "goal-dispatch-instruction";
const GOAL_DISPATCH_MARKER_TEXT =
  "Internal /goal dispatch marker. This message carries no objective without a matching goal instruction.";

type GoalDispatchMarkerDetails = {
  goalId: string;
  dispatchToken: number;
  sessionEpoch: number;
  extensionInstanceId: string;
};

type GoalDispatchAttempt = GoalDispatchMarkerDetails & {
  prompt: string;
  expectedTurnsUsed: number;
  cancelled: boolean;
};

function parseGoalDispatchMarker(message: unknown): GoalDispatchMarkerDetails | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.role !== "custom" || record.customType !== GOAL_DISPATCH_MARKER_TYPE) return null;
  if (!record.details || typeof record.details !== "object" || Array.isArray(record.details)) return null;

  const details = record.details as Record<string, unknown>;
  if (typeof details.goalId !== "string" || !details.goalId) return null;
  if (typeof details.extensionInstanceId !== "string" || !details.extensionInstanceId) return null;
  if (
    typeof details.dispatchToken !== "number" ||
    !Number.isSafeInteger(details.dispatchToken) ||
    details.dispatchToken <= 0
  ) {
    return null;
  }
  if (
    typeof details.sessionEpoch !== "number" ||
    !Number.isSafeInteger(details.sessionEpoch) ||
    details.sessionEpoch < 0
  ) {
    return null;
  }
  return {
    goalId: details.goalId,
    dispatchToken: details.dispatchToken,
    sessionEpoch: details.sessionEpoch,
    extensionInstanceId: details.extensionInstanceId,
  };
}

function sameGoalDispatch(
  left: GoalDispatchMarkerDetails,
  right: GoalDispatchMarkerDetails,
): boolean {
  return (
    left.goalId === right.goalId &&
    left.dispatchToken === right.dispatchToken &&
    left.sessionEpoch === right.sessionEpoch &&
    left.extensionInstanceId === right.extensionInstanceId
  );
}

// The live @earendil-works/pi-coding-agent runtime exposes these lifecycle events, while the
// extension workspace's older upstream type package does not. Keep the untyped boundary narrow.
type LocalLifecycleExtensionApi = {
  on(
    event: "agent_settled",
    handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
  ): void;
  on(
    event: "before_turn_response",
    handler: (
      event: { triggerMessages?: readonly unknown[] },
      ctx: ExtensionContext,
    ) =>
      | { message: { customType: string; content: string; display: boolean; details: GoalDispatchMarkerDetails } }
      | undefined,
  ): void;
};

function showAuditLoader(
  ctx: ExtensionContext,
  onCancel: () => void,
  label = "Auditing goal completion…",
): LoaderCloser | undefined {
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
      // Subtle but important: ctx.abort() aborts the active agent stream, not our `pi -p`
      // audit subprocess. The audit must be cancelled through its own AbortController so the
      // spawned process actually exits when the user presses the loader cancel key.
      loader.onAbort = () => {
        close();
        try {
          onCancel();
        } catch {
          // ignore cancel-handler failures so closing the UI still completes
        }
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

  // Use the explicit per-audit signal owned by the goal extension. ctx.signal is undefined at
  // agent_settled (no streaming), so it cannot cancel a hanging `pi -p` audit subprocess. The
  // extension owns its own AbortController and wires it into both runGoalAudit and the loader
  // cancel hotkey so the spawned subprocess actually dies on cancel/replace/shutdown.
  return (goal, prompt, ctx, ssh, signal) =>
    runGoalAudit({
      exec: (command, args, options) => pi.exec(command, args, options),
      prompt,
      cwd: ctx.cwd,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      signal,
      auditSessionPath: defaultAuditSessionPath(goal.goalId),
      ssh,
    });
}

function auditStartDelayMs(pi: ExtensionAPI): number {
  const override = (pi as unknown as { __goalExtensionAuditStartDelayMs?: unknown }).__goalExtensionAuditStartDelayMs;
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? Math.floor(override)
    : DEFAULT_AUDIT_START_DELAY_MS;
}

function compactionWatchdogMs(pi: ExtensionAPI): number {
  const override = (pi as unknown as { __goalExtensionCompactionWatchdogMs?: unknown }).__goalExtensionCompactionWatchdogMs;
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? Math.floor(override)
    : COMPACTION_WATCHDOG_MS;
}

function dispatchStartWatchdogMs(pi: ExtensionAPI): number {
  const override = (pi as unknown as { __goalExtensionDispatchStartWatchdogMs?: unknown })
    .__goalExtensionDispatchStartWatchdogMs;
  return typeof override === "number" && Number.isFinite(override) && override >= 0
    ? Math.floor(override)
    : GOAL_DISPATCH_START_WATCHDOG_MS;
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
  const extensionInstanceId = randomUUID();
  let currentGoal: GoalState | null = null;
  let dispatchScheduled = false;
  let activeDispatchToken: number | null = null;
  let pendingGoalDispatch: GoalDispatchAttempt | null = null;
  let activeGoalDispatch: GoalDispatchAttempt | null = null;
  let dispatchStartWatchdog: ReturnType<typeof setTimeout> | null = null;
  let nextDispatchToken = 0;
  let editorOverrideActive = false;
  let activeSessionId = "";
  let lastUserMessage: { sessionId: string; text: string } | null = null;
  let compactionActive = false;
  let activeAuditController: AbortController | null = null;
  let agentActivityGeneration = 0;
  let sessionLifecycleEpoch = 0;
  let sessionActive = false;
  const runAudit = makeAuditRunner(pi);
  const auditDelayMs = auditStartDelayMs(pi);
  const compactionWatchdogDelayMs = compactionWatchdogMs(pi);
  const dispatchStartWatchdogDelayMs = dispatchStartWatchdogMs(pi);

  const clearDispatchStartWatchdog = (): void => {
    if (!dispatchStartWatchdog) return;
    clearTimeout(dispatchStartWatchdog);
    dispatchStartWatchdog = null;
  };

  const armDispatchStartWatchdog = (ctx: ExtensionContext, attempt: GoalDispatchAttempt): void => {
    clearDispatchStartWatchdog();
    dispatchStartWatchdog = setTimeout(() => {
      dispatchStartWatchdog = null;
      if (!pendingGoalDispatch || !sameGoalDispatch(pendingGoalDispatch, attempt)) return;
      const state = pendingGoalDispatch.cancelled ? "cancelled" : "active";
      notify(
        ctx,
        `goal ${state} dispatch has not reached message_start; retaining its lock to prevent duplicate work (run /reload if it remains stuck)`,
        "warning",
      );
    }, dispatchStartWatchdogDelayMs);
    dispatchStartWatchdog.unref?.();
  };

  const abortActiveAudit = (reason: string): void => {
    if (!activeAuditController) return;
    const controller = activeAuditController;
    activeAuditController = null;
    try {
      controller.abort(new Error(reason));
    } catch {
      // Older Node abort() rejects non-DOMException reasons; fall back to a no-arg abort.
      try {
        controller.abort();
      } catch {
        // already aborted or detached; nothing else to do
      }
    }
  };

  registerTuiBrokerEditorBadgeProvider("goal", () => {
    if (!currentGoal) return null;
    return { text: buildGoalEditorIndicator(), priority: 200, borderColor: "#f38ba8" };
  });

  const refreshTuiBrokerEditor = () => {
    if (isTuiBrokerInstalled()) requestTuiBrokerEditorReinstall();
  };

  let compactionWatchdog: ReturnType<typeof setTimeout> | null = null;

  const clearCompactionActive = () => {
    compactionActive = false;
    if (compactionWatchdog) {
      clearTimeout(compactionWatchdog);
      compactionWatchdog = null;
    }
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
    const previousGoalStatus = currentGoal?.status ?? null;
    const nextGoalId = goal?.goalId ?? null;
    const nextGoalStatus = goal?.status ?? null;
    currentGoal = goal;
    const identityChanged = previousGoalId !== nextGoalId;
    const activeGoalStopped =
      previousGoalId !== null &&
      previousGoalId === nextGoalId &&
      previousGoalStatus === "active" &&
      nextGoalStatus !== "active";
    if (identityChanged || activeGoalStopped) {
      // Any in-flight audit is now bound to stale or stopped goal state. Cancel its `pi -p`
      // subprocess so we don't burn quota auditing work the user cleared, replaced, or limited.
      const reason = activeGoalStopped ? "goal stopped" : nextGoalId === null ? "goal cleared" : "goal replaced";
      abortActiveAudit(reason);

      // A marker already handed to Pi cannot be retracted through the extension API. Retain its
      // lock and mark it cancelled: message_start can then abort that exact custom-message turn.
      // This also prevents a replacement marker from racing an unresolved old attempt.
      if (pendingGoalDispatch) {
        pendingGoalDispatch = { ...pendingGoalDispatch, cancelled: true };
      } else if (activeGoalDispatch) {
        activeGoalDispatch = { ...activeGoalDispatch, cancelled: true };
        ctx.abort();
      } else {
        dispatchScheduled = false;
        activeDispatchToken = null;
      }
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
    clearDispatchStartWatchdog();
    pendingGoalDispatch = null;
    activeGoalDispatch = null;
    dispatchScheduled = false;
    activeDispatchToken = null;

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
    options: {
      explicitReplace?: boolean;
      allowUiConfirm?: boolean;
      attachToActiveTurn?: boolean;
      activeTurnStartedAtMs?: number;
    } = {},
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

    const createdGoal = currentGoal ? replaceGoal(currentGoal, objective) : createGoal(objective);
    const next =
      options.attachToActiveTurn && options.activeTurnStartedAtMs !== undefined
        ? { ...createdGoal, startedAtMs: Math.min(createdGoal.startedAtMs, options.activeTurnStartedAtMs) }
        : createdGoal;
    // Blank /goal adopts the user request already being processed, so that active run is its
    // first goal turn. Explicit objectives remain at zero turns until their starter is queued.
    const activatedGoal = options.attachToActiveTurn ? incrementGoalTurnsUsed(next) : next;
    setCurrentGoal(ctx, activatedGoal);
    notify(ctx, `goal active: ${activatedGoal.objective}`, "info");

    // Pi consumes extension commands before applying Alt+Enter's follow-up routing. A busy
    // explicit goal therefore remains at turnsUsed === 0 until agent_settled reaches the first
    // fully idle boundary. Keeping the starter in goal state lets clear/replace invalidate it;
    // a plain Pi queue message cannot be selectively retracted by an extension.
    scheduleGoalContinuation(ctx);
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

  const scheduleGoalContinuation = (ctx: ExtensionContext): void => {
    if (!sessionActive || getAutoCheckpointCycleActive(ctx) || compactionActive) return;

    if (shouldBudgetLimitGoal(currentGoal)) {
      setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal as GoalState));
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

    if (!ctx.model) {
      notify(ctx, "goal cannot dispatch without an active model", "warning");
      return;
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
      notify(ctx, `goal cannot dispatch: authentication is not configured for ${ctx.model.provider}`, "warning");
      return;
    }

    const scheduledGoalId = currentGoal?.goalId;
    const scheduledSessionEpoch = sessionLifecycleEpoch;
    const scheduledDispatchToken = nextDispatchToken + 1;
    nextDispatchToken = scheduledDispatchToken;
    activeDispatchToken = scheduledDispatchToken;
    dispatchScheduled = true;

    // turnsUsed === 0 is the durable contract for an unstarted explicit goal. Deriving the
    // starter path from state keeps transient idle/pending gates from losing a one-call option.
    const dispatchDelayMs = currentGoal?.turnsUsed === 0 ? 0 : auditDelayMs;

    setTimeout(() => {
      void (async () => {
        let rescheduleAfterActivity = false;
        try {
          if (!sessionActive || sessionLifecycleEpoch !== scheduledSessionEpoch) return;
          if (!currentGoal || currentGoal.goalId !== scheduledGoalId) return;
          // Scheduling and execution are separated by the audit delay. Auto-checkpoint or
          // another extension can resume the agent during that window. Starting the external
          // audit anyway races active work, and the post-audit idle guard then discards the
          // valid result. Recheck every transient scheduling gate before spending audit quota.
          if (
            getAutoCheckpointCycleActive(ctx) ||
            compactionActive ||
            !ctx.isIdle() ||
            getHasPendingMessages(ctx)
          ) {
            return;
          }

          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "goal stopped: turn budget exhausted", "warning");
            return;
          }

          const goalAtDispatchStart = currentGoal;
          let continuation: string;

          if (goalAtDispatchStart.turnsUsed === 0) {
            continuation = buildInitialGoalMessage(goalAtDispatchStart);
          } else {
            let outcome: AuditRunnerOutcome;
            const auditController = new AbortController();
            const auditActivityGeneration = agentActivityGeneration;
            activeAuditController = auditController;
            const closeAuditLoader = showAuditLoader(ctx, () => {
              auditController.abort(new Error("audit cancelled by user"));
            });
            try {
              setStatus(ctx, "⚑ auditing |");
              const auditInput = await buildPromptForGoal(goalAtDispatchStart, ctx);
              outcome = await runAudit(
                goalAtDispatchStart,
                auditInput.prompt,
                ctx,
                auditInput.ssh,
                auditController.signal,
              );
            } catch (error) {
              const failureReason = error instanceof Error ? error.message : String(error);
              outcome = {
                ok: false,
                audit: fallbackAuditResult(failureReason),
                failureReason,
                attempts: 0,
                auditSessionPath: defaultAuditSessionPath(goalAtDispatchStart.goalId),
                commands: [],
              };
            } finally {
              closeAuditLoader?.();
              if (activeAuditController === auditController) activeAuditController = null;
              if (activeDispatchToken === scheduledDispatchToken) {
                setStatus(ctx, currentGoal ? buildGoalBorderLabel(currentGoal) : undefined);
              }
            }

            if (!currentGoal || currentGoal.goalId !== goalAtDispatchStart.goalId) return;
            if (activeDispatchToken !== scheduledDispatchToken) return;
            if (agentActivityGeneration !== auditActivityGeneration) {
              // The audit inspected a snapshot from before another agent run. Never apply its
              // completion decision or continuation; retry from the new settled state instead.
              rescheduleAfterActivity = true;
              return;
            }
            if (auditController.signal.aborted) return;

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

          if (!currentGoal || currentGoal.goalId !== goalAtDispatchStart.goalId) return;
          if (shouldBudgetLimitGoal(currentGoal)) {
            setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
            notify(ctx, "goal stopped: turn budget exhausted", "warning");
            return;
          }

          if (
            activeDispatchToken !== scheduledDispatchToken ||
            currentGoal.status !== "active" ||
            getAutoCheckpointCycleActive(ctx) ||
            compactionActive ||
            !ctx.isIdle() ||
            getHasPendingMessages(ctx)
          ) {
            return;
          }

          const dispatchAttempt: GoalDispatchAttempt = {
            goalId: goalAtDispatchStart.goalId,
            prompt: continuation,
            dispatchToken: scheduledDispatchToken,
            sessionEpoch: scheduledSessionEpoch,
            extensionInstanceId,
            expectedTurnsUsed: goalAtDispatchStart.turnsUsed,
            cancelled: false,
          };
          try {
            // A custom trigger preserves an attempt token through message_start. The marker itself
            // contains no objective; before_turn_response injects work only after the exact live
            // attempt starts. Clear/replacement can therefore abort stale work without relying on
            // prompt equality or retrying an unresolved fire-and-forget send.
            pendingGoalDispatch = dispatchAttempt;
            armDispatchStartWatchdog(ctx, dispatchAttempt);
            pi.sendMessage<GoalDispatchMarkerDetails>(
              {
                customType: GOAL_DISPATCH_MARKER_TYPE,
                content: GOAL_DISPATCH_MARKER_TEXT,
                display: false,
                details: {
                  goalId: dispatchAttempt.goalId,
                  dispatchToken: dispatchAttempt.dispatchToken,
                  sessionEpoch: dispatchAttempt.sessionEpoch,
                  extensionInstanceId: dispatchAttempt.extensionInstanceId,
                },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch (error) {
            if (pendingGoalDispatch?.dispatchToken === scheduledDispatchToken) {
              pendingGoalDispatch = null;
              clearDispatchStartWatchdog();
            }
            const messageText = error instanceof Error ? error.message : String(error);
            notify(ctx, `goal failed to queue continuation: ${messageText}`, "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `goal continuation failed: ${message}`, "warning");
        } finally {
          const awaitingGoalTurn =
            pendingGoalDispatch?.dispatchToken === scheduledDispatchToken ||
            activeGoalDispatch?.dispatchToken === scheduledDispatchToken;
          if (activeDispatchToken === scheduledDispatchToken && !awaitingGoalTurn) {
            dispatchScheduled = false;
            activeDispatchToken = null;
          }
          if (rescheduleAfterActivity) scheduleGoalContinuation(ctx);
        }
      })();
    }, dispatchDelayMs);
  };

  const markCompactionActive = (ctx: ExtensionContext, signal?: AbortSignal): void => {
    compactionActive = true;
    signal?.addEventListener(
      "abort",
      () => {
        clearCompactionActive();
        scheduleGoalContinuation(ctx);
      },
      { once: true },
    );

    // Subtle but important: upstream emits `session_compact` only on successful compaction.
    // On non-abort failures (provider error, JSON parse, etc.) the upstream abort controller is
    // discarded without aborting, so neither the abort listener nor `session_compact` ever
    // fires. Without a self-heal, a single failed compaction would permanently mute /goal until
    // session_start or session_shutdown ran. The watchdog releases the gate after a generous
    // cap so the next agent_settled can resume goal continuation.
    if (compactionWatchdog) clearTimeout(compactionWatchdog);
    compactionWatchdog = setTimeout(() => {
      if (!compactionActive) return;
      clearCompactionActive();
      notify(ctx, "goal cleared stale compaction lock (no session_compact within watchdog window)", "warning");
      scheduleGoalContinuation(ctx);
    }, compactionWatchdogDelayMs);
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
          // The branch contains the user message actually being processed. A later Alt+Enter
          // submission is remembered by `input` immediately but is not the active task yet.
          const branchMessage = findPreviousUserMessageForGoalDetails(getBranchEntries(ctx));
          const objective = branchMessage?.text ?? getRememberedUserMessage(ctx);
          if (objective) {
            await createOrReplaceGoal(ctx, objective, {
              explicitReplace: false,
              allowUiConfirm: false,
              attachToActiveTurn: true,
              activeTurnStartedAtMs: branchMessage?.startedAtMs ?? undefined,
            });
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
        const budgetedGoal = setGoalBudget(currentGoal, parsed.turnBudget);
        if (shouldBudgetLimitGoal(budgetedGoal)) {
          setCurrentGoal(ctx, markGoalBudgetLimited(budgetedGoal));
          notify(
            ctx,
            `goal budget set to ${parsed.turnBudget}; goal stopped: turn budget exhausted`,
            "warning",
          );
          return;
        }
        setCurrentGoal(ctx, budgetedGoal);
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
    sessionLifecycleEpoch += 1;
    sessionActive = true;
    clearCompactionActive();
    restoreGoalForSession(ctx);
    // Reload is the explicit recovery for an unresolved fire-and-forget marker. Restoring the
    // persisted goal must therefore re-arm its starter/audit without waiting for unrelated work.
    scheduleGoalContinuation(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    // A goal may have been persisted while no model/auth was available. Model selection is the
    // recovery event in Pi; it does not emit agent_settled merely because configuration changed.
    scheduleGoalContinuation(ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    // Compaction is a hard audit blocker. Also cancel an in-flight audit so we don't fight
    // the compaction provider for quota and so the audit cannot dispatch a follow-up onto a
    // session that is mid-compaction.
    abortActiveAudit("session compaction starting");
    markCompactionActive(ctx, event.signal);
  });

  pi.on("session_compact", (_event, ctx) => {
    clearCompactionActive();
    scheduleGoalContinuation(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionActive = false;
    sessionLifecycleEpoch += 1;
    abortActiveAudit("session shutdown");
    clearDispatchStartWatchdog();
    pendingGoalDispatch = null;
    activeGoalDispatch = null;
    dispatchScheduled = false;
    activeDispatchToken = null;
    clearCompactionActive();
    persistGoal(ctx);
    setStatus(ctx, undefined);
  });

  pi.on("input", (event, ctx) => {
    if (isInteractiveUserText(event.text, (event as { source?: unknown }).source)) {
      rememberUserMessage(ctx, String(event.text));
    }
  });

  pi.on("agent_start", () => {
    clearCompactionActive();
    agentActivityGeneration += 1;
    abortActiveAudit("agent started while goal audit was running");
  });

  pi.on("message_start", (event, ctx) => {
    const marker = parseGoalDispatchMarker(event.message);
    if (!marker) return;

    const pending = pendingGoalDispatch;
    if (!pending || !sameGoalDispatch(marker, pending)) {
      // A marker from an invalidated session or superseded attempt has reached the exact point
      // where the agent owns an abort signal. Stop that turn before stale goal work is injected.
      ctx.abort();
      return;
    }

    clearDispatchStartWatchdog();
    pendingGoalDispatch = null;
    activeGoalDispatch = pending;
    if (
      !pending.cancelled &&
      currentGoal?.goalId === pending.goalId &&
      shouldBudgetLimitGoal(currentGoal)
    ) {
      setCurrentGoal(ctx, markGoalBudgetLimited(currentGoal));
      notify(ctx, "goal stopped: turn budget exhausted", "warning");
      return;
    }
    if (
      pending.cancelled ||
      !sessionActive ||
      sessionLifecycleEpoch !== pending.sessionEpoch ||
      activeDispatchToken !== pending.dispatchToken ||
      !currentGoal ||
      currentGoal.goalId !== pending.goalId ||
      currentGoal.status !== "active" ||
      currentGoal.turnsUsed !== pending.expectedTurnsUsed
    ) {
      activeGoalDispatch = { ...pending, cancelled: true };
      ctx.abort();
      return;
    }

    setCurrentGoal(ctx, incrementGoalTurnsUsed(currentGoal));
  });

  (pi as unknown as LocalLifecycleExtensionApi).on("before_turn_response", (event, ctx) => {
    const active = activeGoalDispatch;
    if (!active) return undefined;
    const marker = (event.triggerMessages ?? [])
      .map((message) => parseGoalDispatchMarker(message))
      .find((candidate): candidate is GoalDispatchMarkerDetails => candidate !== null && sameGoalDispatch(candidate, active));
    if (!marker) return undefined;

    if (
      active.cancelled ||
      !sessionActive ||
      sessionLifecycleEpoch !== active.sessionEpoch ||
      activeDispatchToken !== active.dispatchToken ||
      !currentGoal ||
      currentGoal.goalId !== active.goalId ||
      currentGoal.status !== "active" ||
      currentGoal.turnsUsed !== active.expectedTurnsUsed + 1
    ) {
      activeGoalDispatch = { ...active, cancelled: true };
      if (!active.cancelled) ctx.abort();
      return undefined;
    }

    return {
      message: {
        customType: GOAL_DISPATCH_INSTRUCTION_TYPE,
        content: active.prompt,
        display: true,
        details: marker,
      },
    };
  });

  // `agent_end` fires while pi still considers the run active and before retry, compaction,
  // and queued follow-up handling. `agent_settled` is the first lifecycle point where the
  // idle scheduling invariant is true and no automatic continuation remains.
  (pi as unknown as LocalLifecycleExtensionApi).on("agent_settled", (_event, ctx) => {
    if (activeGoalDispatch) {
      const settledDispatchToken = activeGoalDispatch.dispatchToken;
      activeGoalDispatch = null;
      if (activeDispatchToken === settledDispatchToken) {
        dispatchScheduled = false;
        activeDispatchToken = null;
      }
    }

    // An issued marker that has not reached message_start has no failure/cancellation callback.
    // Retrying here could overlap the unresolved attempt, so retain its lock and fail safely.
    if (pendingGoalDispatch) return;
    scheduleGoalContinuation(ctx);
  });
}
