// @lat: [[tui-broker#TUI broker]]

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type AutocompleteProvider } from "@mariozechner/pi-tui";
import {
  buildContextUsageBorderText,
  buildContextUsageLabel,
  buildEditorBorderBadgeText,
  buildModelEffortLabel,
  buildSingleLineFooter,
  getContextUsageHighlightAnsiCodes,
  sanitizeStatusText,
} from "./lib/layout.ts";
import {
  getTuiBrokerAutocompleteProviderWrappers,
  getTuiBrokerEditorBadges,
  getTuiBrokerEditorBorderStyle,
  getTuiBrokerFooterPath,
  getTuiBrokerRuntimeSnapshot,
  markTuiBrokerInstalled,
  setTuiBrokerEditorReinstallHandler,
  subscribeTuiBrokerFooterRefresh,
} from "./lib/runtime.ts";

type FooterTheme = {
  fg: (color: "dim", text: string) => string;
};

type BorderColorFn = (str: string) => string;

type AgentSettingsSnapshot = {
  defaultProvider?: string;
  defaultModel?: string;
  enabledModels: string[];
};

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function ansiStyle(text: string, codes: string): string {
  return `\x1b[${codes}m${text}\x1b[0m`;
}

function isBottomBorderLine(text: string): boolean {
  const plain = stripAnsi(text);
  return /^─+$/.test(plain) || /^─── ↓ \d+ more ─*$/.test(plain);
}

class ContextUsageEditor extends CustomEditor {
  private readonly getContextUsageLabelFn: () => { label: string; tokens: number | null } | null;
  private readonly getEditorBadgesFn: () => string[];
  private readonly getEditorBorderColorFn: () => BorderColorFn | null;
  private readonly getAutocompleteProviderWrappersFn: () => Array<
    (provider: AutocompleteProvider) => AutocompleteProvider
  >;
  private baseBorderColor: BorderColorFn;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    _getTheme: () => FooterTheme,
    getContextUsageLabel: () => { label: string; tokens: number | null } | null,
    getEditorBadges: () => string[],
    getEditorBorderColor: () => BorderColorFn | null,
    getAutocompleteProviderWrappers: () => Array<(provider: AutocompleteProvider) => AutocompleteProvider>,
  ) {
    super(tui, theme, keybindings);
    this.getContextUsageLabelFn = getContextUsageLabel;
    this.getEditorBadgesFn = getEditorBadges;
    this.getEditorBorderColorFn = getEditorBorderColor;
    this.getAutocompleteProviderWrappersFn = getAutocompleteProviderWrappers;
    this.baseBorderColor = this.borderColor;

    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => this.getEditorBorderColorFn() ?? this.baseBorderColor,
      set: (next: unknown) => {
        if (typeof next === "function") {
          this.baseBorderColor = next as BorderColorFn;
        }
      },
    });
  }

  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    let nextProvider = provider;
    for (const wrapProvider of this.getAutocompleteProviderWrappersFn()) {
      nextProvider = wrapProvider(nextProvider);
    }
    super.setAutocompleteProvider(nextProvider);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    const plainTop = stripAnsi(lines[0] ?? "");
    const moreMatch = plainTop.match(/↑\s+\d+\s+more/);
    const labelText = buildEditorBorderBadgeText(this.getEditorBadgesFn(), moreMatch?.[0]);
    if (labelText) {
      const label = truncateToWidth(` ${labelText} `, Math.max(1, width), "");
      const fill = "─".repeat(Math.max(0, width - visibleWidth(label)));
      lines[0] = this.borderColor(`${label}${fill}`);
    }

    const contextUsage = this.getContextUsageLabelFn();
    if (!contextUsage) return lines;

    const label = this.styleContextUsageLabel(contextUsage.label, contextUsage.tokens);
    const labelWidth = visibleWidth(label);
    const bottomBorderIndex = (() => {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isBottomBorderLine(lines[index] ?? "")) return index;
      }
      return lines.length - 1;
    })();
    const trailingBorderWidth = 1;

    if (labelWidth >= width) {
      lines[bottomBorderIndex] = truncateToWidth(label, width, "");
      return lines;
    }

    const prefixWidth = Math.max(0, width - labelWidth - trailingBorderWidth);
    const prefix = truncateToWidth(lines[bottomBorderIndex] ?? "", prefixWidth, "");
    const trailingBorder = width - labelWidth > 0 ? this.borderColor("─") : "";
    lines[bottomBorderIndex] = prefix + label + trailingBorder;
    return lines;
  }

  private styleContextUsageLabel(label: string, tokens: number | null): string {
    const text = buildContextUsageBorderText(label);

    const ansiCodes = getContextUsageHighlightAnsiCodes(tokens);
    return ansiCodes ? ansiStyle(text, ansiCodes) : text;
  }
}

let cachedAgentSettingsPath = "";
let cachedAgentSettingsMtimeMs = -1;
let cachedAgentSettingsSnapshot: AgentSettingsSnapshot | null = null;

function resolveAgentSettingsPath(): string {
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function readAgentSettingsSnapshot(): AgentSettingsSnapshot | null {
  const settingsPath = resolveAgentSettingsPath();

  try {
    const stat = statSync(settingsPath);
    if (
      cachedAgentSettingsSnapshot &&
      cachedAgentSettingsPath === settingsPath &&
      cachedAgentSettingsMtimeMs === stat.mtimeMs
    ) {
      return cachedAgentSettingsSnapshot;
    }

    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
      enabledModels?: unknown;
    };

    const snapshot: AgentSettingsSnapshot = {
      defaultProvider: typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined,
      enabledModels: Array.isArray(parsed.enabledModels)
        ? parsed.enabledModels.filter((value): value is string => typeof value === "string")
        : [],
    };

    cachedAgentSettingsPath = settingsPath;
    cachedAgentSettingsMtimeMs = stat.mtimeMs;
    cachedAgentSettingsSnapshot = snapshot;
    return snapshot;
  } catch {
    cachedAgentSettingsPath = settingsPath;
    cachedAgentSettingsMtimeMs = -1;
    cachedAgentSettingsSnapshot = null;
    return null;
  }
}

function parseProviderModelRef(value: string): { provider: string; modelId: string } | null {
  const slashIndex = value.indexOf("/");
  if (slashIndex <= 0 || slashIndex === value.length - 1) return null;

  return {
    provider: value.slice(0, slashIndex).trim(),
    modelId: value.slice(slashIndex + 1).trim(),
  };
}

function findContextWindowFromRegistry(ctx: ExtensionContext, provider: string, modelId: string): number | null {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return null;
  return model.contextWindow;
}

function getFallbackContextWindow(ctx: ExtensionContext): number | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: string; provider?: unknown; modelId?: unknown } | undefined;
    if (entry?.type !== "model_change") continue;

    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
    const contextWindow = provider && modelId ? findContextWindowFromRegistry(ctx, provider, modelId) : null;
    if (contextWindow) return contextWindow;
  }

  const settings = readAgentSettingsSnapshot();
  if (settings?.defaultProvider && settings.defaultModel) {
    const contextWindow = findContextWindowFromRegistry(ctx, settings.defaultProvider, settings.defaultModel);
    if (contextWindow) return contextWindow;
  }

  for (const enabledModel of settings?.enabledModels ?? []) {
    const parsed = parseProviderModelRef(enabledModel);
    if (!parsed) continue;
    const contextWindow = findContextWindowFromRegistry(ctx, parsed.provider, parsed.modelId);
    if (contextWindow) return contextWindow;
  }

  const availableModels = ctx.modelRegistry.getAvailable();
  if (availableModels.length === 1) {
    const [model] = availableModels;
    if (model && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
      return model.contextWindow;
    }
  }

  return null;
}

function formatPwd(cwd: string, gitBranch: string | null, sessionName: string | null | undefined): string {
  let pwd = cwd;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && pwd.startsWith(home)) {
    pwd = `~${pwd.slice(home.length)}`;
  }

  if (gitBranch) {
    pwd = `${pwd} (${gitBranch})`;
  }

  if (sessionName) {
    pwd = `${pwd} • ${sessionName}`;
  }

  return pwd;
}

export default function tuiBroker(pi: ExtensionAPI) {
  // Runtime contribution maps live on globalThis, but commands/event handlers belong to
  // the current extension runner and must be registered again for each session runtime.
  markTuiBrokerInstalled();

  pi.registerCommand("tui-broker:debug", {
    description: "Show tui-broker surface contributors",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const snapshot = getTuiBrokerRuntimeSnapshot({ sessionName: ctx.sessionManager.getSessionName() });
      const parts = [
        `footer=${snapshot.footerPathSourceKey ?? "local"}`,
        `badges=${snapshot.editorBadgeKeys.join(",") || "none"}`,
        `border=${snapshot.editorBorderStyleKey ?? "default"}`,
        `autocomplete=${snapshot.autocompleteWrappers.join(",") || "none"}`,
      ];
      ctx.ui.notify(parts.join(" | "), "info");
    },
  });

  const install = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent(
      (tui, editorTheme, keybindings) =>
        new ContextUsageEditor(
          tui,
          editorTheme,
          keybindings,
          () => ctx.ui.theme,
          () => {
            const usage = ctx.getContextUsage();
            const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? getFallbackContextWindow(ctx) ?? 0;
            const percent = usage?.percent ?? null;
            const tokens = usage?.tokens ?? null;
            const label = buildContextUsageLabel({ percent, contextWindow });
            return label ? { label, tokens } : null;
          },
          () => getTuiBrokerEditorBadges().map((entry) => entry.text),
          () => getTuiBrokerEditorBorderStyle()?.colorize ?? null,
          () => getTuiBrokerAutocompleteProviderWrappers(),
        ),
    );

    setTuiBrokerEditorReinstallHandler(() => {
      install(ctx);
    });

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
      const unsubscribeFooterRefresh = subscribeTuiBrokerFooterRefresh(() => tui.requestRender());

      return {
        dispose() {
          unsubscribeBranch();
          unsubscribeFooterRefresh();
        },
        invalidate() {},
        render(width: number): string[] {
          const lines: string[] = [];

          const sessionName = ctx.sessionManager.getSessionName();
          const contributedPath = getTuiBrokerFooterPath({ sessionName });
          const pwd = contributedPath?.text ?? formatPwd(ctx.sessionManager.getCwd(), footerData.getGitBranch(), sessionName);
          const modelLineText = buildModelEffortLabel(ctx.model?.id, ctx.model?.reasoning, pi.getThinkingLevel());
          const footerLine = buildSingleLineFooter(pwd, modelLineText, width);
          lines.push(theme.fg("dim", footerLine));

          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([, text]) => sanitizeStatusText(text))
              .filter(Boolean)
              .join(" ");
            if (statusLine) {
              lines.push(theme.fg("dim", truncateToWidth(statusLine, width, "...")));
            }
          }

          return lines;
        },
      };
    });
  };

  pi.on("session_start", (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_fork", (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_shutdown", () => {
    setTuiBrokerEditorReinstallHandler(undefined);
  });
}
