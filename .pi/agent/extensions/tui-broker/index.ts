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
  buildEditorTopBorderLine,
  buildModelEffortLabel,
  buildSingleLineFooter,
  getContextUsageHighlightAnsiCodes,
  sanitizeStatusText,
} from "./lib/layout.ts";
import {
  getTuiBrokerAutocompleteProviderWrappers,
  getTuiBrokerEditorBadges,
  getTuiBrokerEditorTopRightStatuses,
  getTuiBrokerFooterPath,
  getTuiBrokerRuntimeSnapshot,
  markTuiBrokerInstalled,
  setTuiBrokerEditorRefreshHandler,
  setTuiBrokerEditorReinstallHandler,
  subscribeTuiBrokerFooterRefresh,
} from "./lib/runtime.ts";

type BrokerTheme = {
  fg: (color: "dim" | "mdCode" | "text", text: string) => string;
};

const EDITOR_BORDER_HEX = "#fab387";
const EDITOR_BORDER_COLOR_LABEL = EDITOR_BORDER_HEX;
const EDITOR_BORDER_CHAR = "─";
const REMOTE_FOOTER_ICON = "";
const RGB_HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

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

function ansiTrueColor(text: string, hex: string): string {
  const normalized = hex.trim();
  if (!RGB_HEX_REGEX.test(normalized)) return text;
  const red = Number.parseInt(normalized.slice(1, 3), 16);
  const green = Number.parseInt(normalized.slice(3, 5), 16);
  const blue = Number.parseInt(normalized.slice(5, 7), 16);
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function isBottomBorderLine(text: string): boolean {
  const plain = stripAnsi(text);
  return /^[─━]+$/.test(plain) || /^[─━]+ ↓ \d+ more [─━]*$/.test(plain);
}

function colorizeEditorBorder(theme: BrokerTheme, text: string): string {
  const border = ansiTrueColor(text, EDITOR_BORDER_HEX);
  return border === text ? theme.fg("text", text) : border;
}

class ContextUsageEditor extends CustomEditor {
  private readonly getContextUsageLabelFn: () => { label: string; tokens: number | null } | null;
  private readonly getEditorBadgesFn: () => string[];
  private readonly getEditorTopRightStatusesFn: () => string[];
  private readonly getThemeFn: () => BrokerTheme;
  private readonly getAutocompleteProviderWrappersFn: () => Array<
    (provider: AutocompleteProvider) => AutocompleteProvider
  >;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    getTheme: () => BrokerTheme,
    getContextUsageLabel: () => { label: string; tokens: number | null } | null,
    getEditorBadges: () => string[],
    getEditorTopRightStatuses: () => string[],
    getAutocompleteProviderWrappers: () => Array<(provider: AutocompleteProvider) => AutocompleteProvider>,
  ) {
    super(tui, theme, keybindings);
    this.getThemeFn = getTheme;
    this.getContextUsageLabelFn = getContextUsageLabel;
    this.getEditorBadgesFn = getEditorBadges;
    this.getEditorTopRightStatusesFn = getEditorTopRightStatuses;
    this.getAutocompleteProviderWrappersFn = getAutocompleteProviderWrappers;

    Object.defineProperty(this, "borderColor", {
      configurable: true,
      enumerable: true,
      get: () => (text: string) => colorizeEditorBorder(this.getThemeFn(), text),
      set: (_next: unknown) => {
        // Core still assigns thinking-level colors to custom editors. The broker
        // intentionally ignores those assignments so the user editor border stays
        // on the broker-selected theme token.
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

    const bottomBorderIndex = (() => {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (isBottomBorderLine(lines[index] ?? "")) return index;
      }
      return lines.length - 1;
    })();

    const plainTop = stripAnsi(lines[0] ?? "");
    const moreMatch = plainTop.match(/↑\s+\d+\s+more/);
    const labelText = buildEditorBorderBadgeText(this.getEditorBadgesFn(), moreMatch?.[0]);
    const topRightText = this.getEditorTopRightStatusesFn().join(" • ");
    const topBorderLine = buildEditorTopBorderLine({
      leftText: labelText,
      rightText: topRightText,
      width,
      borderChar: EDITOR_BORDER_CHAR,
      colorizeBorder: (text) => this.borderColor(text),
    });
    if (topBorderLine !== undefined) {
      lines[0] = topBorderLine;
    }

    const contextUsage = this.getContextUsageLabelFn();
    if (!contextUsage) return lines;

    const label = this.styleContextUsageLabel(contextUsage.label, contextUsage.tokens);
    const labelWidth = visibleWidth(label);
    const trailingBorderWidth = 1;

    if (labelWidth >= width) {
      lines[bottomBorderIndex] = truncateToWidth(label, width, "");
      return lines;
    }

    const prefixWidth = Math.max(0, width - labelWidth - trailingBorderWidth);
    const prefix = truncateToWidth(lines[bottomBorderIndex] ?? "", prefixWidth, "");
    const trailingBorder = width - labelWidth > 0 ? this.borderColor(EDITOR_BORDER_CHAR) : "";
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

function formatPwd(cwd: string, sessionName: string | null | undefined): string {
  let pwd = cwd;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && pwd.startsWith(home)) {
    pwd = `~${pwd.slice(home.length)}`;
  }

  if (sessionName) {
    pwd = `${pwd} • ${sessionName}`;
  }

  return ` ${pwd}`;
}

function colorizeFooterLine(theme: BrokerTheme, line: string): string {
  if (!line.startsWith(REMOTE_FOOTER_ICON)) return theme.fg("dim", line);
  return `${theme.fg("mdCode", REMOTE_FOOTER_ICON)}${theme.fg("dim", line.slice(REMOTE_FOOTER_ICON.length))}`;
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
        `topRight=${snapshot.editorTopRightStatusKeys.join(",") || "none"}`,
        `border=${EDITOR_BORDER_COLOR_LABEL}`,
        `autocomplete=${snapshot.autocompleteWrappers.join(",") || "none"}`,
      ];
      ctx.ui.notify(parts.join(" | "), "info");
    },
  });

  const install = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent(
      (tui, editorTheme, keybindings) => {
        setTuiBrokerEditorRefreshHandler(() => tui.requestRender());
        return new ContextUsageEditor(
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
          () => getTuiBrokerEditorTopRightStatuses().map((entry) => entry.text),
          () => getTuiBrokerAutocompleteProviderWrappers(),
        );
      },
    );

    setTuiBrokerEditorReinstallHandler(() => {
      install(ctx);
    });

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeFooterRefresh = subscribeTuiBrokerFooterRefresh(() => tui.requestRender());

      return {
        dispose() {
          unsubscribeFooterRefresh();
        },
        invalidate() {},
        render(width: number): string[] {
          const lines: string[] = [];

          const sessionName = ctx.sessionManager.getSessionName();
          const contributedPath = getTuiBrokerFooterPath({ sessionName });
          const pwd = contributedPath?.text ?? formatPwd(ctx.sessionManager.getCwd(), sessionName);
          const modelLineText = buildModelEffortLabel(ctx.model?.id, ctx.model?.reasoning, pi.getThinkingLevel());
          const footerLine = buildSingleLineFooter(pwd, modelLineText, width);
          lines.push(colorizeFooterLine(theme, footerLine));

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
    setTuiBrokerEditorRefreshHandler(undefined);
  });
}
