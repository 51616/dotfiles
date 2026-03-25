import type { Theme } from "@mariozechner/pi-coding-agent";
import { scopeDisplay, scopeLegend } from "./scope.ts";
import type { FocusMode } from "./types.ts";
import { bottomBorder, boxLine, formatHintColumns, padLine, topBorder } from "./ui-helpers.ts";

function paneBorderColor(focused: boolean): "accent" | "muted" {
  return focused ? "accent" : "muted";
}

export function statusLetter(theme: Theme, status: string): string {
  if (status === "A") return theme.fg("success", status);
  if (status === "D") return theme.fg("error", status);
  if (status === "R") return theme.fg("accent", status);
  return theme.fg("warning", status);
}

export function renderPane(theme: Theme, title: string, focused: boolean, width: number, bodyLines: string[]): string[] {
  const borderColor = paneBorderColor(focused);
  const lines = [topBorder(theme, title, width, borderColor)];
  for (const line of bodyLines) {
    lines.push(boxLine(theme, "│", line, width, "│", borderColor));
  }
  lines.push(bottomBorder(theme, width, borderColor));
  return lines;
}

export function footerHints(width: number): [string, string] {
  return [
    formatHintColumns(width, ["j/k/↑↓ move", "[/] hunk", "n/b scope cmts", " ,/. file cmts"], 4),
    formatHintColumns(width, ["w comments file", "z stale file", "v peek · x range", "t/u/i/a · r · s"], 4),
  ];
}

export function renderStatusShell({
  theme,
  width,
  title,
  message,
  messageColor,
}: {
  theme: Theme;
  width: number;
  title: string;
  message: string;
  messageColor?: "error";
}): string[] {
  const inner = Math.max(20, width - 2);
  const content = messageColor ? theme.fg(messageColor, message) : message;
  return [topBorder(theme, title, inner, "borderAccent"), boxLine(theme, "│", content, inner, "│", "borderAccent"), bottomBorder(theme, inner, "borderAccent")];
}

export function renderAppShell({
  theme,
  width,
  terminalRows,
  repoRoot,
  scope,
  headLabel,
  scopedCommentCount,
  staleCount,
  lastReload,
  focusMode,
  diffTitle,
  perfEnabled,
  perfSummary,
  sourceSummary,
  selectionSummary,
  filePanePreferredBodyHeight,
  renderFileList,
  renderCommentPanel,
  renderDiffRows,
}: {
  theme: Theme;
  width: number;
  terminalRows: number;
  repoRoot: string;
  scope: "t" | "u" | "s" | "a";
  headLabel: string;
  scopedCommentCount: number;
  staleCount: number;
  lastReload: string;
  focusMode: FocusMode;
  diffTitle: string;
  sourceSummary?: string | null;
  perfEnabled: boolean;
  perfSummary: string;
  selectionSummary?: string | null;
  filePanePreferredBodyHeight: number;
  renderFileList: (width: number, height: number) => string[];
  renderCommentPanel: (width: number, height: number) => string[];
  renderDiffRows: (width: number, height: number) => string[];
}): string[] {
  const innerWidth = Math.max(20, width - 2);
  const paneGap = 1;
  const filesPaneContentWidth = Math.max(20, Math.min(32, Math.floor(innerWidth * 0.28)));
  const diffPaneContentWidth = Math.max(20, innerWidth - filesPaneContentWidth - paneGap - 4);
  const bodyHeight = Math.max(10, Math.floor(terminalRows * 0.86) - 8);
  const minCommentsBodyHeight = Math.min(6, Math.max(3, bodyHeight - 3));
  const maxFilesBodyHeight = Math.max(1, bodyHeight - minCommentsBodyHeight - 2);
  const filesBodyHeight = Math.min(Math.max(1, filePanePreferredBodyHeight), maxFilesBodyHeight);
  const commentsBodyHeight = Math.max(1, bodyHeight - filesBodyHeight - 2);

  const lines: string[] = [];
  const [hint1, hint2] = footerHints(innerWidth);
  lines.push(topBorder(theme, "π Diff Review", innerWidth, "borderAccent"));
  lines.push(boxLine(theme, "│", `${theme.fg("muted", "repo")} ${repoRoot}`, innerWidth, "│", "borderAccent"));
  lines.push(boxLine(theme, "│", `${theme.fg("muted", "scope")} [${scopeLegend()}] ${scopeDisplay(scope)}   ${theme.fg("muted", "HEAD")} ${headLabel}   ${theme.fg("accent", "comments")} ${theme.fg("accent", String(scopedCommentCount))}   ${theme.fg(staleCount ? "warning" : "muted", `stale ${staleCount}`)}`, innerWidth, "│", "borderAccent"));
  lines.push(boxLine(theme, "│", sourceSummary ? `${theme.fg("muted", "source")} ${sourceSummary}` : "", innerWidth, "│", "borderAccent"));
  if (selectionSummary) {
    lines.push(boxLine(theme, "│", `${theme.fg("muted", "range")} ${theme.fg("accent", selectionSummary)}`, innerWidth, "│", "borderAccent"));
  } else {
    lines.push(boxLine(theme, "│", "", innerWidth, "│", "borderAccent"));
  }

  const filePane = renderPane(theme, "Files", focusMode === "files", filesPaneContentWidth, renderFileList(filesPaneContentWidth, filesBodyHeight));
  const commentPane = renderPane(theme, "Comments", false, filesPaneContentWidth, renderCommentPanel(filesPaneContentWidth, commentsBodyHeight));
  const leftColumn = [...filePane, ...commentPane];
  const diffPane = renderPane(theme, diffTitle, focusMode === "diff", diffPaneContentWidth, renderDiffRows(diffPaneContentWidth, bodyHeight));
  const paneRows = Math.max(leftColumn.length, diffPane.length);
  for (let i = 0; i < paneRows; i += 1) {
    const left = padLine(leftColumn[i] ?? " ".repeat(filesPaneContentWidth + 2), filesPaneContentWidth + 2);
    const right = padLine(diffPane[i] ?? " ".repeat(diffPaneContentWidth + 2), diffPaneContentWidth + 2);
    lines.push(boxLine(theme, "│", `${left}${" ".repeat(paneGap)}${right}`, innerWidth, "│", "borderAccent"));
  }

  lines.push(boxLine(theme, "│", "", innerWidth, "│", "borderAccent"));
  lines.push(boxLine(theme, "│", hint1, innerWidth, "│", "borderAccent"));
  lines.push(boxLine(theme, "│", hint2, innerWidth, "│", "borderAccent"));
  lines.push(boxLine(theme, "│", `${theme.fg("muted", "last reload")} ${lastReload}`, innerWidth, "│", "borderAccent"));
  if (perfEnabled) {
    lines.push(boxLine(theme, "│", perfSummary, innerWidth, "│", "borderAccent"));
  }
  lines.push(bottomBorder(theme, innerWidth, "borderAccent"));
  return lines;
}
