import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { parseBool } from "../lib/shared/pi-bool.ts";
import {
  brightRed,
  buildDoNotStopBorderLabel,
  DEFAULT_DO_NOT_STOP_REPEATS,
  DO_NOT_STOP_PROMPT,
  normalizeDoNotStopRepeats,
  parseDoNotStopCommand,
  shouldArmDoNotStopFollowUp,
  shouldDispatchDoNotStopFollowUp,
} from "./lib/do-not-stop.ts";
import {
  getDoNotStopSnapshotForSession,
  getLastActiveDoNotStopSnapshot,
  saveDoNotStopSnapshot,
} from "./lib/do-not-stop-runtime.ts";

type BorderColorFn = (str: string) => string;

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

class DoNotStopEditor extends CustomEditor {
  private baseBorderColor: BorderColorFn;
  private readonly isDnsActive: () => boolean;
  private readonly getDnsProgress: () => { step: number; total: number };

  constructor(
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    isDnsActive: () => boolean,
    getDnsProgress: () => { step: number; total: number },
  ) {
    super(tui as never, theme as never, keybindings as never);

    this.isDnsActive = isDnsActive;
    this.getDnsProgress = getDnsProgress;
    this.baseBorderColor = this.borderColor;

    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => {
        if (this.isDnsActive()) {
          return (text: string) => brightRed(text);
        }
        return this.baseBorderColor;
      },
      set: (next: unknown) => {
        if (typeof next === "function") {
          this.baseBorderColor = next as BorderColorFn;
        }
      },
    });
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.isDnsActive() || lines.length === 0) return lines;

    const plainTop = stripAnsi(lines[0] ?? "");
    const moreMatch = plainTop.match(/↑\s+\d+\s+more/);

    const labelBase = buildDoNotStopBorderLabel(this.getDnsProgress());
    const withScrollInfo = moreMatch ? `${labelBase} • ${moreMatch[0]}` : labelBase;

    const rawLabel = ` ${withScrollInfo} `;
    const label = truncateToWidth(rawLabel, Math.max(1, width), "");
    const fill = "─".repeat(Math.max(0, width - visibleWidth(label)));

    lines[0] = brightRed(`${label}${fill}`);
    return lines;
  }
}

export default function doNotStop(pi: ExtensionAPI) {
  const defaultEnabled = parseBool(process.env.PI_DO_NOT_STOP_ENABLE, false);
  const defaultRepeatTarget = normalizeDoNotStopRepeats(process.env.PI_DO_NOT_STOP_REPEATS, DEFAULT_DO_NOT_STOP_REPEATS);

  let enabled = defaultEnabled;
  let repeatTarget = defaultRepeatTarget;

  let pendingRepeats = 0;
  let completedRepeats = 0;
  let dispatchScheduled = false;
  let editorOverrideActive = false;
  let activeSessionId = "";

  const applySnapshot = (snapshot: {
    enabled: boolean;
    repeatTarget: number;
    pendingRepeats: number;
    completedRepeats: number;
  }) => {
    enabled = parseBool(snapshot.enabled, defaultEnabled);
    repeatTarget = normalizeDoNotStopRepeats(snapshot.repeatTarget, defaultRepeatTarget);
    pendingRepeats = normalizeDoNotStopRepeats(snapshot.pendingRepeats, 0);
    completedRepeats = normalizeDoNotStopRepeats(snapshot.completedRepeats, 0);
  };

  const lastActiveSnapshot = getLastActiveDoNotStopSnapshot();
  if (lastActiveSnapshot) {
    applySnapshot(lastActiveSnapshot);
  }

  const applyEditorOverride = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    if (enabled && !editorOverrideActive) {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) =>
          new DoNotStopEditor(
            tui,
            theme,
            keybindings,
            () => enabled,
            () => ({ step: completedRepeats, total: repeatTarget }),
          ),
      );
      editorOverrideActive = true;
      return;
    }

    if (!enabled && editorOverrideActive) {
      ctx.ui.setEditorComponent(undefined);
      editorOverrideActive = false;
    }
  };

  const getSessionId = (ctx: ExtensionContext): string => {
    const raw =
      typeof (ctx as unknown as { sessionManager?: { getSessionId?: () => unknown } }).sessionManager?.getSessionId ===
      "function"
        ? (ctx as unknown as { sessionManager: { getSessionId: () => unknown } }).sessionManager.getSessionId()
        : "";
    return String(raw ?? "").trim();
  };

  const persistSnapshot = (ctx?: ExtensionContext) => {
    const sid = (ctx ? getSessionId(ctx) : activeSessionId).trim();
    if (sid) activeSessionId = sid;

    saveDoNotStopSnapshot(sid || activeSessionId, {
      enabled,
      repeatTarget,
      pendingRepeats,
      completedRepeats,
    });
  };

  const restoreSnapshotForSession = (ctx: ExtensionContext) => {
    activeSessionId = getSessionId(ctx);

    const sessionSnapshot = activeSessionId ? getDoNotStopSnapshotForSession(activeSessionId) : null;
    if (sessionSnapshot) {
      applySnapshot(sessionSnapshot);
      dispatchScheduled = false;
      applyEditorOverride(ctx);
      return;
    }

    pendingRepeats = 0;
    completedRepeats = 0;
    dispatchScheduled = false;
    applyEditorOverride(ctx);
    persistSnapshot(ctx);
  };

  const resetCycle = () => {
    pendingRepeats = 0;
    completedRepeats = 0;
    dispatchScheduled = false;
  };

  const setEnabled = (ctx: ExtensionContext, nextEnabled: boolean) => {
    enabled = nextEnabled;
    if (!enabled) {
      resetCycle();
    }
    applyEditorOverride(ctx);
    persistSnapshot(ctx);
  };

  const setRepeats = (ctx: ExtensionContext, repeats: number) => {
    repeatTarget = normalizeDoNotStopRepeats(repeats, repeatTarget);
    resetCycle();
    persistSnapshot(ctx);
  };

  const startCycleFromUserPrompt = (ctx: ExtensionContext) => {
    pendingRepeats = repeatTarget;
    completedRepeats = 0;
    persistSnapshot(ctx);
  };

  pi.registerCommand("do-not-stop", {
    description: "do-not-stop controls (toggle|on|off|status|repeats <n>)",
    handler: async (args, ctx) => {
      const parsed = parseDoNotStopCommand(args ?? "");

      if (parsed.kind === "toggle") {
        setEnabled(ctx, !enabled);
        if (ctx.hasUI) ctx.ui.notify(`do-not-stop ${enabled ? "enabled" : "disabled"} (repeats=${repeatTarget})`, "info");
        return;
      }

      if (parsed.kind === "set") {
        setEnabled(ctx, parsed.enabled);
        if (ctx.hasUI) ctx.ui.notify(`do-not-stop ${enabled ? "enabled" : "disabled"} (repeats=${repeatTarget})`, "info");
        return;
      }

      if (parsed.kind === "setRepeats") {
        setRepeats(ctx, parsed.repeats);
        if (ctx.hasUI) ctx.ui.notify(`do-not-stop repeats set to ${repeatTarget}`, "info");
        return;
      }

      if (parsed.kind === "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `do-not-stop is ${enabled ? "enabled" : "disabled"}. Progress: ${completedRepeats}/${repeatTarget} repeats. Remaining this cycle: ${pendingRepeats}.`,
            "info",
          );
        }
        return;
      }

      const suffix = parsed.invalid ? ` (unknown: ${parsed.invalid})` : "";
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Usage: /do-not-stop [toggle|on|off|status|repeats <n>]${suffix}`,
          parsed.invalid ? "warning" : "info",
        );
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreSnapshotForSession(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    restoreSnapshotForSession(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    persistSnapshot(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (shouldArmDoNotStopFollowUp({ enabled, text: event.text, source: (event as { source?: unknown }).source })) {
      startCycleFromUserPrompt(ctx);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    const hasPendingMessages =
      typeof (ctx as unknown as { hasPendingMessages?: () => boolean }).hasPendingMessages === "function"
        ? Boolean((ctx as unknown as { hasPendingMessages: () => boolean }).hasPendingMessages())
        : false;

    if (
      !shouldDispatchDoNotStopFollowUp({
        enabled,
        pendingRepeats,
        isIdle: ctx.isIdle(),
        hasPendingMessages,
      })
    ) {
      return;
    }

    if (dispatchScheduled) return;
    dispatchScheduled = true;

    setTimeout(() => {
      dispatchScheduled = false;
      if (!enabled || pendingRepeats <= 0) return;

      pendingRepeats -= 1;
      completedRepeats += 1;
      persistSnapshot(ctx);

      try {
        pi.sendUserMessage(DO_NOT_STOP_PROMPT, { deliverAs: "followUp" });
      } catch (error) {
        // restore counters on failure
        pendingRepeats += 1;
        completedRepeats = Math.max(0, completedRepeats - 1);
        persistSnapshot(ctx);

        if (ctx.hasUI) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`do-not-stop failed to queue follow-up: ${message}`, "warning");
        }
      }
    }, 0);
  });
}
