import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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

  const setStatus = (ctx: ExtensionContext, text?: string) =>
    ctx.ui.setStatus(options.statusKey, text && text.trim() ? text : undefined);

  const pushDebug = (ctx: ExtensionContext, line: string) => {
    if (!debugEnabled) return;

    const ts = new Date().toISOString().replace("T", " ").replace(/\..+$/, "Z");
    debugLog.push(`[${ts}] ${line}`);
    if (debugLog.length > 50) debugLog.splice(0, debugLog.length - 50);

    if (options.debugWidgetAuto && ctx.hasUI) {
      ctx.ui.setWidget(options.debugWidgetKey, debugLog.slice(-20), { placement: "aboveEditor" });
    }
  };

  const renderDebugWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      options.debugWidgetKey,
      debugLog.length ? debugLog.slice(-20) : ["(autockpt debug log empty)"],
      { placement: "aboveEditor" },
    );
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
  };
}
