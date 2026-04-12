import { performance } from "node:perf_hooks";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { type TUI } from "@mariozechner/pi-tui";
import { compareCommentsByLocation, mapCommentToRow } from "./comments.ts";
import { diffTitleForFile } from "./agent-report-ui.ts";
import { renderAppShell, renderStatusShell, statusLetter } from "./app-shell-render.ts";
import { renderDiffRows, renderFileList } from "./diff-render.ts";
import { renderCommentPanel as renderCommentInfoPanel } from "./comment-panel.ts";
import { commentsForSubmission } from "./review-session.ts";
import { getLanguageFromPath, highlightFileRows } from "./syntax-highlight.ts";
import { padLine } from "./ui-helpers.ts";
import type {
  DiffRowRenderCache,
  DiffViewportCache,
  FocusMode,
  ParsedFilePatch,
  ReviewComment,
  ReviewMode,
  ScopeState,
} from "./types.ts";

const MIN_WIDTH = 60;
const COMMENT_MARKER_WIDTH = 4;

type SyntaxHighlightCache = {
  scope: ReviewMode;
  fingerprint: string;
  fileKey: string;
  language: string | undefined;
  highlighted: Map<number, string>;
} | null;

type RowMarkerCache = {
  scope: ReviewMode;
  fileKey: string;
  epoch: number;
  markers: Map<number, string>;
} | null;

export interface AppRenderingContext {
  theme: Theme;
  tui: TUI;
  repoRoot: string;
  repoLabel: string;
  getScope: () => ReviewMode;
  getFocusMode: () => FocusMode;
  getCurrentState: () => ScopeState;
  getCurrentFiles: () => ParsedFilePatch[];
  getCurrentFile: () => ParsedFilePatch | null;
  getCurrentRow: () => ScopeState["bundle"]["files"][number]["rows"][number] | null;
  getComments: () => ReviewComment[];
  getOverallComments: () => Record<ReviewMode, string>;
  getLastReloadTimestamp: () => string;
  getSelectedFileIndex: () => number;
  getDiffCursorRow: () => number;
  getFileScroll: () => number;
  getDiffScroll: () => number;
  setDiffScroll: (value: number) => void;
  ensureFileVisible: (bodyHeight: number) => void;
  ensureDiffVisible: (bodyHeight: number) => void;
  fileCommentCount: (fileKey: string) => number;
  fileHasStale: (fileKey: string) => boolean;
  unresolvedComments: () => ReviewComment[];
  getCommentsEpoch: () => number;
  getHunkSelectionEpoch: () => number;
  getRowMarkerCache: () => RowMarkerCache;
  setRowMarkerCache: (value: RowMarkerCache) => void;
  getSyntaxHighlightCache: () => SyntaxHighlightCache;
  setSyntaxHighlightCache: (value: SyntaxHighlightCache) => void;
  getDiffRowRenderCache: () => DiffRowRenderCache | null;
  setDiffRowRenderCache: (value: DiffRowRenderCache | null) => void;
  getDiffViewportCache: () => DiffViewportCache | null;
  setDiffViewportCache: (value: DiffViewportCache | null) => void;
  currentFileRejectedHunks: () => ReadonlySet<string>;
  getLoadingMessage: () => string;
  perfEnabled: () => boolean;
  perfSummary: (width: number) => string;
  recordPerf: (bucket: "render" | "diffRows" | "visibleRows", value: number) => void;
  selectionSummary: () => string | null;
  sourceSummary: (state: ScopeState) => string | null;
  warningSummary: (state: ScopeState) => string | null;
}

export function createAppRendering(ctx: AppRenderingContext) {
  function currentPanelPreviewComments(): ReviewComment[] {
    if (ctx.getFocusMode() !== "diff") return [];
    const file = ctx.getCurrentFile();
    const row = ctx.getCurrentRow();
    const scope = ctx.getScope();
    if (!file || !row) return [];
    return ctx.getComments()
      .filter((comment) => comment.scope === scope && comment.fileKey === file.fileKey)
      .filter((comment) => mapCommentToRow(file, comment) === row.rowIndex)
      .sort(compareCommentsByLocation);
  }

  function currentFileSyntaxRows(): { highlightKey: string; highlightedRows: Map<number, string> | null } {
    const file = ctx.getCurrentFile();
    if (!file) return { highlightKey: "plain", highlightedRows: null };

    const language = getLanguageFromPath(file.resolvedEditablePath ?? file.editablePath ?? file.newPath ?? file.oldPath ?? file.displayPath);
    const fingerprint = ctx.getCurrentState().bundle.fingerprint;
    const cache = ctx.getSyntaxHighlightCache();
    const scope = ctx.getScope();
    if (cache
      && cache.scope === scope
      && cache.fingerprint === fingerprint
      && cache.fileKey === file.fileKey
      && cache.language === language) {
      return {
        highlightKey: language ?? "plain",
        highlightedRows: cache.highlighted.size ? cache.highlighted : null,
      };
    }

    const highlighted = highlightFileRows({ file, language, theme: ctx.theme });
    ctx.setSyntaxHighlightCache({ scope, fingerprint, fileKey: file.fileKey, language, highlighted });
    return { highlightKey: language ?? "plain", highlightedRows: highlighted.size ? highlighted : null };
  }

  function rowMarkersForCurrentFile(): Map<number, string> {
    const file = ctx.getCurrentFile();
    if (!file) return new Map();
    const scope = ctx.getScope();
    const commentsEpoch = ctx.getCommentsEpoch();
    const cache = ctx.getRowMarkerCache();
    if (cache && cache.scope === scope && cache.fileKey === file.fileKey && cache.epoch === commentsEpoch) {
      return cache.markers;
    }

    const grouped = new Map<number, ReviewComment[]>();
    for (const comment of ctx.getComments()) {
      if (comment.scope !== scope || comment.fileKey !== file.fileKey) continue;
      const rowIndex = mapCommentToRow(file, comment);
      if (rowIndex == null) continue;
      const entries = grouped.get(rowIndex) ?? [];
      entries.push(comment);
      grouped.set(rowIndex, entries);
    }

    const markers = new Map<number, string>();
    for (const [rowIndex, rowComments] of grouped.entries()) {
      const stale = rowComments.some((comment) => comment.status === "stale_unresolved");
      const markerBase = stale ? "◇" : "◆";
      const suffix = rowComments.length > 1 ? "*" : String(rowComments[0]?.ordinal ?? "");
      const text = `${markerBase}${suffix}`.slice(0, COMMENT_MARKER_WIDTH).padEnd(COMMENT_MARKER_WIDTH, " ");
      markers.set(rowIndex, stale ? ctx.theme.fg("error", text) : ctx.theme.fg("accent", text));
    }

    ctx.setRowMarkerCache({ scope, fileKey: file.fileKey, epoch: commentsEpoch, markers });
    return markers;
  }

  function renderFileListPane(width: number, height: number): string[] {
    const files = ctx.getCurrentFiles();
    ctx.ensureFileVisible(height);
    return renderFileList({
      theme: ctx.theme,
      files,
      width,
      height,
      fileScroll: ctx.getFileScroll(),
      selectedFileIndex: ctx.getSelectedFileIndex(),
      statusLetter: (file) => statusLetter(ctx.theme, file),
      fileCommentCount: (fileKey) => ctx.fileCommentCount(fileKey),
      fileHasStale: (fileKey) => ctx.fileHasStale(fileKey),
    });
  }

  function renderCommentPanelPane(width: number, height: number): string[] {
    const previewComments = currentPanelPreviewComments();
    const scope = ctx.getScope();
    if (previewComments.length) {
      return renderCommentInfoPanel({
        theme: ctx.theme,
        width,
        height,
        view: { kind: "preview", scope, comments: previewComments },
      });
    }

    if (ctx.getFocusMode() === "files") {
      return renderCommentInfoPanel({
        theme: ctx.theme,
        width,
        height,
        view: {
          kind: "session",
          scope,
          comments: ctx.getComments(),
          overallComments: ctx.getOverallComments(),
        },
      });
    }

    const file = ctx.getCurrentFile();
    return renderCommentInfoPanel({
      theme: ctx.theme,
      width,
      height,
      view: {
        kind: "file",
        scope,
        file,
        comments: file ? ctx.getComments().filter((comment) => comment.scope === scope && comment.fileKey === file.fileKey) : [],
      },
    });
  }

  function renderDiffRowsPane(width: number, height: number): string[] {
    const file = ctx.getCurrentFile();
    if (!file) {
      return Array.from({ length: height }, () => padLine(ctx.theme.fg("muted", "(no diff)"), width));
    }

    const startedAt = ctx.perfEnabled() ? performance.now() : 0;
    ctx.ensureDiffVisible(height);
    const { highlightKey, highlightedRows } = currentFileSyntaxRows();
    const rendered = renderDiffRows({
      theme: ctx.theme,
      scope: ctx.getScope(),
      fingerprint: ctx.getCurrentState().bundle.fingerprint,
      file,
      width,
      height,
      commentsEpoch: ctx.getCommentsEpoch(),
      hunkSelectionEpoch: ctx.getHunkSelectionEpoch(),
      highlightKey,
      diffCursorRow: ctx.getDiffCursorRow(),
      diffScroll: ctx.getDiffScroll(),
      rowMarkers: rowMarkersForCurrentFile(),
      rejectedHunkIds: ctx.currentFileRejectedHunks(),
      highlightedRows,
      rowCache: ctx.getDiffRowRenderCache(),
      viewportCache: ctx.getDiffViewportCache(),
    });
    ctx.setDiffRowRenderCache(rendered.rowCache);
    ctx.setDiffViewportCache(rendered.viewportCache);
    ctx.setDiffScroll(rendered.diffScroll);
    ctx.recordPerf("visibleRows", Math.max(0, Math.min(height, file.rows.length - rendered.diffScroll)));
    ctx.recordPerf("diffRows", performance.now() - startedAt);
    return rendered.lines;
  }

  function render(width: number): string[] {
    const startedAt = ctx.perfEnabled() ? performance.now() : 0;
    if (width < MIN_WIDTH) {
      const lines = renderStatusShell({
        theme: ctx.theme,
        width,
        title: "π Diff Review",
        message: `terminal too narrow for diff review UI (need >= ${MIN_WIDTH} columns)`,
        messageColor: "error",
      });
      ctx.recordPerf("render", performance.now() - startedAt);
      return lines;
    }

    const loadingMessage = ctx.getLoadingMessage();
    if (loadingMessage) {
      const lines = renderStatusShell({ theme: ctx.theme, width, title: "π Diff Review", message: loadingMessage });
      ctx.recordPerf("render", performance.now() - startedAt);
      return lines;
    }

    const state = ctx.getCurrentState();
    const scope = ctx.getScope();
    const lines = renderAppShell({
      theme: ctx.theme,
      width,
      terminalRows: ctx.tui.terminal.rows,
      repoLabel: ctx.repoLabel,
      scope,
      headLabel: state.startHead ? state.startHead.slice(0, 7) : "(none)",
      scopedCommentCount: commentsForSubmission(ctx.getComments(), scope).scopedComments.length,
      staleCount: ctx.unresolvedComments().length,
      lastReload: ctx.getLastReloadTimestamp() || state.lastReloadAt,
      focusMode: ctx.getFocusMode(),
      diffTitle: diffTitleForFile(ctx.getCurrentFile()),
      perfEnabled: ctx.perfEnabled(),
      perfSummary: ctx.perfSummary(Math.max(20, width - 2)),
      sourceSummary: ctx.sourceSummary(state),
      warningSummary: ctx.warningSummary(state),
      selectionSummary: ctx.selectionSummary(),
      filePanePreferredBodyHeight: Math.max(1, ctx.getCurrentFiles().length || 1),
      renderFileList: (paneWidth, bodyHeight) => renderFileListPane(paneWidth, bodyHeight),
      renderCommentPanel: (paneWidth, bodyHeight) => renderCommentPanelPane(paneWidth, bodyHeight),
      renderDiffRows: (paneWidth, bodyHeight) => renderDiffRowsPane(paneWidth, bodyHeight),
    });
    ctx.recordPerf("render", performance.now() - startedAt);
    return lines;
  }

  return {
    render,
  };
}
