import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

export type SelfCheckpointingUiRuntime = {
  debugWidgetKey: string;
  isDebugEnabled: () => boolean;
  setDebugEnabled: (next: boolean) => void;
  getDebugLog: () => string[];
  clearDebugLog: () => void;
  setStatus: (ctx: ExtensionContext, text?: string) => void;
  pushDebug: (ctx: ExtensionContext, line: string) => void;
  renderDebugWidget: (ctx: ExtensionContext) => void;
  sendFollowUpUserMessage: (text: string) => void;
  showCompactionLoader: (ctx: ExtensionContext, label?: string) => void;
  clearCompactionLoader: (ctx: ExtensionContext) => void;
};

export function createSelfCheckpointingUiRuntime(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  options: {
    statusKey: string;
    debugWidgetKey: string;
    debugEnabled: boolean;
    debugWidgetAuto: boolean;
  },
): SelfCheckpointingUiRuntime {
  const debugLog: string[] = [];
  let debugEnabled = options.debugEnabled;
  let closeCompactionLoader: (() => void) | undefined;
  let compactionLoaderVisible = false;

  const hasLiveUI = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.hasUI === true;
    } catch {
      return false;
    }
  };

  const setStatus = (ctx: ExtensionContext, text?: string) => {
    try {
      ctx.ui.setStatus(options.statusKey, text && text.trim() ? text : undefined);
    } catch {
      // The ctx can become stale immediately after compaction/session replacement.
    }
  };

  const pushDebug = (ctx: ExtensionContext, line: string) => {
    if (!debugEnabled) return;

    const ts = new Date().toISOString().replace("T", " ").replace(/\..+$/, "Z");
    debugLog.push(`[${ts}] ${line}`);
    if (debugLog.length > 50) debugLog.splice(0, debugLog.length - 50);

    if (options.debugWidgetAuto && hasLiveUI(ctx)) {
      try {
        ctx.ui.setWidget(options.debugWidgetKey, debugLog.slice(-20), { placement: "aboveEditor" });
      } catch {
        // ignore stale UI context
      }
    }
  };

  const renderDebugWidget = (ctx: ExtensionContext) => {
    if (!hasLiveUI(ctx)) return;
    try {
      ctx.ui.setWidget(
        options.debugWidgetKey,
        debugLog.length ? debugLog.slice(-20) : ["(autockpt debug log empty)"],
        { placement: "aboveEditor" },
      );
    } catch {
      // ignore stale UI context
    }
  };

  const clearCompactionLoader = (ctx: ExtensionContext) => {
    if (!hasLiveUI(ctx) || !compactionLoaderVisible) return;
    try {
      closeCompactionLoader?.();
    } catch {
      compactionLoaderVisible = false;
      closeCompactionLoader = undefined;
    }
  };

  const showCompactionLoader = (
    ctx: ExtensionContext,
    label = "Auto-checkpoint: compacting context…",
  ) => {
    if (!hasLiveUI(ctx) || compactionLoaderVisible) return;

    compactionLoaderVisible = true;

    try {
      void ctx.ui.custom((tui, theme, _keybindings, done) => {
        const close = () => {
          if (!compactionLoaderVisible) return;
          compactionLoaderVisible = false;
          closeCompactionLoader = undefined;
          done(null);
        };

        const loader = new BorderedLoader(tui, theme, label);
        loader.onAbort = () => {
          close();
          ctx.abort();
        };
        closeCompactionLoader = close;
        return loader;
      });
    } catch {
      compactionLoaderVisible = false;
      closeCompactionLoader = undefined;
    }
  };

  const sendFollowUpUserMessage = (text: string) => {
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      try {
        pi.sendUserMessage(text);
      } catch {
        // ignore
      }
    }
  };

  return {
    debugWidgetKey: options.debugWidgetKey,
    isDebugEnabled: () => debugEnabled,
    setDebugEnabled: (next) => {
      debugEnabled = next;
    },
    getDebugLog: () => debugLog,
    clearDebugLog: () => {
      debugLog.splice(0, debugLog.length);
    },
    setStatus,
    pushDebug,
    renderDebugWidget,
    sendFollowUpUserMessage,
    showCompactionLoader,
    clearCompactionLoader,
  };
}
