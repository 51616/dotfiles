import { performance } from "node:perf_hooks";
import type { ExtensionAPI, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type Focusable, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import {
  commentsAtLocation,
  commentsForScope,
  compareCommentsByLocation,
  createComment,
  findCommentAtTarget,
  formatCommentLocation,
  mapCommentToRow,
  revalidateComment,
} from "./comments.ts";
import { resolveInputAction } from "./app-input.ts";
import { renderAppShell, renderStatusShell, statusLetter } from "./app-shell-render.ts";
import { commentsSortedForNavigation, nextFileIndexMatching } from "./comment-navigation.ts";
import { editorSnippetForDraft, editorSnippetForExisting } from "./comment-snippets.ts";
import {
  applyCandidateRemap,
  autoChunkSelection,
  describeCommentTarget,
  describeRangeSelection,
  formatScopeBadge,
  printableChar,
  removeCommentById,
  resolveCommentAtCursor,
  unresolvedCommentsForScope,
  updateCommentBody,
} from "./comment-resolution.ts";
import { openExternalEditor } from "./external-editor.ts";
import { getDiffBundle, summarizeFileHashChanges } from "./git.ts";
import { nextNavigableChangeBlockRowIndex, nextNavigableRowIndex } from "./navigation.ts";
import {
  renderCommentsOverlay,
  renderHelpOverlay,
  renderPeekCommentsOverlay,
  renderRejectedHunksErrorOverlay,
  renderStaleResolverOverlay,
} from "./overlay-views.ts";
import {
  captureScopeViewState,
  defaultScopeViewState,
  ensureVisibleIndex,
  nearestNavigableRowIndex,
  nextScopeState,
  restoredCursorRow,
  restoredDiffScroll,
  restoredFileIndex,
} from "./review-state.ts";
import { commentsForSubmission, editorLineForRow, savedReviewMessage, saveScopedReview, shouldGenerateCompactPrompt } from "./review-session.ts";
import { scopeDisplay, scopeName } from "./scope.ts";
import { CommentEditorOverlay } from "./comment-editor-overlay.ts";
import { renderDiffRows, renderFileList } from "./diff-render.ts";
import { renderCommentPanel as renderCommentInfoPanel } from "./comment-panel.ts";
import { SimpleOverlay } from "./simple-overlay.ts";
import type { AppCallbacks, ChangeSummary, DiffRowRenderCache, DiffScope, DiffViewportCache, FocusMode, ParsedDiffRow, RangeSelection, ReviewComment, ScopeState } from "./types.ts";
import { padLine } from "./ui-helpers.ts";
import { getLanguageFromPath, highlightFileRows } from "./syntax-highlight.ts";
import { buildRejectedHunksPatch, countRejectedHunks, reverseApplyPatch } from "./rejected-hunks.ts";

const MIN_WIDTH = 60;
const COMMENT_MARKER_WIDTH = 4;

type PerfBucket = {
  count: number;
  totalMs: number;
  maxMs: number;
};

export class DiffReviewApp implements Component, Focusable {
  focused = false;

  private readonly pi: ExtensionAPI;
  private readonly repoRoot: string;
  private readonly sessionId: string;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly callbacks: AppCallbacks;

  private scope: DiffScope = "u";
  private scopeStates = new Map<DiffScope, ScopeState>();
  private loadingMessage = "Loading diff…";
  private focusMode: FocusMode = "files";
  private selectedFileIndex = 0;
  private diffCursorRow = 0;
  private fileScroll = 0;
  private diffScroll = 0;
  private comments: ReviewComment[] = [];
  private overallComments: Record<DiffScope, string> = { t: "", u: "", s: "", a: "" };
  private lastReloadTimestamp = "";
  private activeOverlayHandle: OverlayHandle | null = null;
  private closing = false;
  private commentsEpoch = 0;
  private hunkSelectionEpoch = 0;
  private rejectedHunks = new Map<DiffScope, Map<string, Set<string>>>();
  private pendingRangeSelection: RangeSelection | null = null;
  private scopeCommentStatsCache: { scope: DiffScope; epoch: number; counts: Map<string, number>; stale: Set<string> } | null = null;
  private rowMarkerCache: { scope: DiffScope; fileKey: string; epoch: number; markers: Map<number, string> } | null = null;
  private diffRowRenderCache: DiffRowRenderCache | null = null;
  private diffViewportCache: DiffViewportCache | null = null;
  private syntaxHighlightCache: {
    scope: DiffScope;
    fingerprint: string;
    fileKey: string;
    language: string | undefined;
    highlighted: Map<number, string>;
  } | null = null;
  private perfEnabled = false;
  private perfStats: { render: PerfBucket; diffRows: PerfBucket; visibleRows: PerfBucket } = {
    render: { count: 0, totalMs: 0, maxMs: 0 },
    diffRows: { count: 0, totalMs: 0, maxMs: 0 },
    visibleRows: { count: 0, totalMs: 0, maxMs: 0 },
  };

  constructor({
    pi,
    repoRoot,
    sessionId,
    tui,
    theme,
    keybindings,
    callbacks,
  }: {
    pi: ExtensionAPI;
    repoRoot: string;
    sessionId: string;
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    callbacks: AppCallbacks;
  }) {
    this.pi = pi;
    this.repoRoot = repoRoot;
    this.sessionId = sessionId;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.callbacks = callbacks;
  }

  async init(scope: DiffScope = "u"): Promise<void> {
    await this.loadScope(scope, true);
  }

  invalidate(): void {}

  private markCommentsChanged(): void {
    this.commentsEpoch += 1;
    this.scopeCommentStatsCache = null;
    this.rowMarkerCache = null;
    this.diffRowRenderCache = null;
    this.diffViewportCache = null;
  }

  private markHunkSelectionChanged(): void {
    this.hunkSelectionEpoch += 1;
    this.diffRowRenderCache = null;
    this.diffViewportCache = null;
  }

  private resetPerfStats(): void {
    this.perfStats = {
      render: { count: 0, totalMs: 0, maxMs: 0 },
      diffRows: { count: 0, totalMs: 0, maxMs: 0 },
      visibleRows: { count: 0, totalMs: 0, maxMs: 0 },
    };
  }

  private recordPerf(bucket: "render" | "diffRows" | "visibleRows", value: number): void {
    if (!this.perfEnabled) return;
    const target = this.perfStats[bucket];
    target.count += 1;
    target.totalMs += value;
    target.maxMs = Math.max(target.maxMs, value);
  }

  private perfSummary(width: number): string {
    const avg = (bucket: PerfBucket) => bucket.count ? bucket.totalMs / bucket.count : 0;
    const summary = `perf[r ${avg(this.perfStats.render).toFixed(1)}/${this.perfStats.render.maxMs.toFixed(1)}ms  d ${avg(this.perfStats.diffRows).toFixed(1)}/${this.perfStats.diffRows.maxMs.toFixed(1)}ms  rows ${avg(this.perfStats.visibleRows).toFixed(1)}]`;
    return truncateToWidth(summary, Math.max(12, width), "…", true);
  }

  private setComments(comments: ReviewComment[]): void {
    this.comments = comments;
    this.markCommentsChanged();
  }

  private rejectedHunksForScope(scope: DiffScope, create = false): Map<string, Set<string>> {
    const existing = this.rejectedHunks.get(scope);
    if (existing || !create) return existing ?? new Map();
    const created = new Map<string, Set<string>>();
    this.rejectedHunks.set(scope, created);
    return created;
  }

  private rejectedHunkSnapshot(scope: DiffScope): Map<string, ReadonlySet<string>> {
    const scopeState = this.rejectedHunks.get(scope);
    if (!scopeState?.size) return new Map();
    const snapshot = new Map<string, ReadonlySet<string>>();
    for (const [fileKey, hunkIds] of scopeState.entries()) {
      if (!hunkIds.size) continue;
      snapshot.set(fileKey, new Set(hunkIds));
    }
    return snapshot;
  }

  private clearRejectedHunks(scope: DiffScope, render = false): void {
    if (!this.rejectedHunks.delete(scope)) return;
    this.markHunkSelectionChanged();
    if (render) this.tui.requestRender();
  }

  private reconcileRejectedHunks(scope: DiffScope, bundleChanged: boolean): void {
    const scopeState = this.rejectedHunks.get(scope);
    if (!scopeState?.size) return;
    if (bundleChanged) {
      this.clearRejectedHunks(scope);
      return;
    }

    const files = this.scopeStates.get(scope)?.bundle.files ?? [];
    const validSelections = new Map(files.map((file) => [file.fileKey, new Set(file.changeBlocks.map((block) => block.id))]));
    let changed = false;

    for (const [fileKey, hunkIds] of scopeState.entries()) {
      const validIds = validSelections.get(fileKey);
      if (!validIds) {
        scopeState.delete(fileKey);
        changed = true;
        continue;
      }
      for (const hunkId of [...hunkIds]) {
        if (validIds.has(hunkId)) continue;
        hunkIds.delete(hunkId);
        changed = true;
      }
      if (!hunkIds.size) {
        scopeState.delete(fileKey);
        changed = true;
      }
    }

    if (!scopeState.size) this.rejectedHunks.delete(scope);
    if (changed) this.markHunkSelectionChanged();
  }

  private formatRejectedBlockLocation(fileKey: string, blockId: string): string | null {
    const state = this.scopeStates.get(this.scope);
    const file = state?.bundle.files.find((entry) => entry.fileKey === fileKey);
    const block = file?.changeBlocks.find((entry) => entry.id === blockId);
    if (!file || !block) return null;

    const rows = file.rows.slice(block.rowStart, block.rowEnd + 1);
    const oldLines = rows.flatMap((row) => row.oldLine != null ? [row.oldLine] : []);
    const newLines = rows.flatMap((row) => row.newLine != null ? [row.newLine] : []);
    const spans: string[] = [];
    if (oldLines.length) {
      const first = oldLines[0]!;
      const last = oldLines[oldLines.length - 1]!;
      spans.push(`-${first}${last !== first ? `-${last}` : ""}`);
    }
    if (newLines.length) {
      const first = newLines[0]!;
      const last = newLines[newLines.length - 1]!;
      spans.push(`+${first}${last !== first ? `-${last}` : ""}`);
    }

    return spans.length ? `${file.displayPath} ${spans.join(" / ")}` : file.displayPath;
  }

  private rejectedBlocksToastMessage(scope: DiffScope): string | null {
    const snapshot = this.rejectedHunkSnapshot(scope);
    const count = countRejectedHunks(snapshot);
    if (!count) return null;

    const entries: string[] = [];
    for (const [fileKey, blockIds] of snapshot.entries()) {
      for (const blockId of blockIds) {
        entries.push(this.formatRejectedBlockLocation(fileKey, blockId) ?? fileKey);
      }
    }

    entries.sort((left, right) => left.localeCompare(right));
    const visible = entries.slice(0, 6);
    const hidden = entries.length - visible.length;
    return [
      `Rejected chunks (${count}):`,
      ...visible.map((entry) => `• ${entry}`),
      ...(hidden > 0 ? [`• … ${hidden} more`] : []),
    ].join("\n");
  }

  private currentFileRejectedHunks(): ReadonlySet<string> {
    const file = this.currentFile();
    if (!file) return new Set();
    return this.rejectedHunks.get(this.scope)?.get(file.fileKey) ?? new Set();
  }

  private currentState(): ScopeState {
    const state = this.scopeStates.get(this.scope);
    if (!state) throw new Error(`Missing scope state for ${this.scope}`);
    return state;
  }

  private currentFiles(): ScopeState["bundle"]["files"] {
    return this.currentState().bundle.files;
  }

  private currentFile() {
    return this.currentFiles()[Math.max(0, Math.min(this.currentFiles().length - 1, this.selectedFileIndex))] ?? null;
  }

  private currentRow(): ParsedDiffRow | null {
    const file = this.currentFile();
    if (!file) return null;
    return file.rows[Math.max(0, Math.min(file.rows.length - 1, this.diffCursorRow))] ?? null;
  }

  private currentFileSyntaxRows(): { highlightKey: string; highlightedRows: Map<number, string> | null } {
    const file = this.currentFile();
    if (!file) return { highlightKey: "plain", highlightedRows: null };

    const language = getLanguageFromPath(file.editablePath ?? file.newPath ?? file.oldPath ?? file.displayPath);
    const fingerprint = this.currentState().bundle.fingerprint;
    if (this.syntaxHighlightCache
      && this.syntaxHighlightCache.scope === this.scope
      && this.syntaxHighlightCache.fingerprint === fingerprint
      && this.syntaxHighlightCache.fileKey === file.fileKey
      && this.syntaxHighlightCache.language === language) {
      return {
        highlightKey: language ?? "plain",
        highlightedRows: this.syntaxHighlightCache.highlighted.size ? this.syntaxHighlightCache.highlighted : null,
      };
    }

    const highlighted = highlightFileRows({ file, language, theme: this.theme });
    this.syntaxHighlightCache = { scope: this.scope, fingerprint, fileKey: file.fileKey, language, highlighted };
    return { highlightKey: language ?? "plain", highlightedRows: highlighted.size ? highlighted : null };
  }

  private visibleComments(includeAllScopes = false): ReviewComment[] {
    return commentsForScope(this.comments, this.scope, includeAllScopes).slice().sort(compareCommentsByLocation);
  }

  private scopedNavigationComments(fileOnly = false): ReviewComment[] {
    const sorted = commentsSortedForNavigation(this.comments, this.scope);
    if (!fileOnly) return sorted;
    const file = this.currentFile();
    if (!file) return [];
    return sorted.filter((comment) => comment.fileKey === file.fileKey);
  }

  private currentPanelPreviewComments(): ReviewComment[] {
    if (this.focusMode !== "diff") return [];
    const file = this.currentFile();
    const row = this.currentRow();
    if (!file || !row) return [];
    return this.comments
      .filter((comment) => comment.scope === this.scope && comment.fileKey === file.fileKey)
      .filter((comment) => mapCommentToRow(file, comment) === row.rowIndex)
      .sort(compareCommentsByLocation);
  }

  private changeSummary(state: ScopeState): { sinceStart: ChangeSummary; sinceLastReload: ChangeSummary } {
    return {
      sinceStart: summarizeFileHashChanges(state.startFileHashes, state.bundle.fileHashes),
      sinceLastReload: summarizeFileHashChanges(state.previousFileHashes, state.bundle.fileHashes),
    };
  }

  private sourceSummary(state: ScopeState): string | null {
    if (state.bundle.sourceKind !== "turn") return null;
    const metadata = state.bundle.turnMetadata;
    if (!metadata) return "last turn (agent-touched)";
    const repos = metadata.workspace ? metadata.repos?.map((repo) => repo.repo_key).join(", ") : null;
    const touched = metadata.touched_paths.length;
    const suffix = [
      touched ? `${touched} touched path${touched === 1 ? "" : "s"}` : null,
      repos ? `repos ${repos}` : null,
      metadata.note ?? null,
    ].filter(Boolean).join(" · ");
    return suffix ? `${metadata.review_source} · ${suffix}` : metadata.review_source;
  }

  private scopeCommentStats(): { counts: Map<string, number>; stale: Set<string> } {
    if (this.scopeCommentStatsCache && this.scopeCommentStatsCache.scope === this.scope && this.scopeCommentStatsCache.epoch === this.commentsEpoch) {
      return { counts: this.scopeCommentStatsCache.counts, stale: this.scopeCommentStatsCache.stale };
    }
    const counts = new Map<string, number>();
    const stale = new Set<string>();
    for (const comment of this.comments) {
      if (comment.scope !== this.scope) continue;
      counts.set(comment.fileKey, (counts.get(comment.fileKey) ?? 0) + 1);
      if (comment.status === "stale_unresolved") stale.add(comment.fileKey);
    }
    this.scopeCommentStatsCache = { scope: this.scope, epoch: this.commentsEpoch, counts, stale };
    return { counts, stale };
  }

  private fileCommentCount(fileKey: string): number {
    return this.scopeCommentStats().counts.get(fileKey) ?? 0;
  }

  private fileHasStale(fileKey: string): boolean {
    return this.scopeCommentStats().stale.has(fileKey);
  }

  private rowMarkersForCurrentFile(): Map<number, string> {
    const file = this.currentFile();
    if (!file) return new Map();
    if (this.rowMarkerCache && this.rowMarkerCache.scope === this.scope && this.rowMarkerCache.fileKey === file.fileKey && this.rowMarkerCache.epoch === this.commentsEpoch) {
      return this.rowMarkerCache.markers;
    }

    const grouped = new Map<number, ReviewComment[]>();
    for (const comment of this.comments) {
      if (comment.scope !== this.scope || comment.fileKey !== file.fileKey) continue;
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
      markers.set(rowIndex, stale ? this.theme.fg("error", text) : this.theme.fg("accent", text));
    }

    this.rowMarkerCache = { scope: this.scope, fileKey: file.fileKey, epoch: this.commentsEpoch, markers };
    return markers;
  }

  private currentViewState() {
    return captureScopeViewState({
      file: this.currentFile(),
      row: this.currentRow(),
      selectedFileIndex: this.selectedFileIndex,
      diffCursorRow: this.diffCursorRow,
      diffScroll: this.diffScroll,
      fileScroll: this.fileScroll,
    });
  }

  private rememberCurrentViewState(): void {
    const state = this.scopeStates.get(this.scope);
    if (!state) return;
    state.view = this.currentViewState();
  }

  private clearPendingRangeSelection(render = true): void {
    this.pendingRangeSelection = null;
    if (render) this.tui.requestRender();
  }

  private currentRangeSelection(): RangeSelection | null {
    if (!this.pendingRangeSelection) return null;
    const file = this.currentFile();
    if (!file || file.fileKey !== this.pendingRangeSelection.fileKey) return null;
    return this.pendingRangeSelection;
  }

  private selectionSummary(): string | null {
    return describeRangeSelection(this.pendingRangeSelection);
  }

  private toggleCurrentHunkRejected(): void {
    const file = this.currentFile();
    const row = this.currentRow();
    const changeBlockId = row?.changeBlockId ?? null;
    if (!file || !row || !changeBlockId || (row.kind !== "added" && row.kind !== "removed")) return;

    const scopeState = this.rejectedHunksForScope(this.scope, true);
    const fileState = scopeState.get(file.fileKey) ?? new Set<string>();
    const rejected = !fileState.has(changeBlockId);
    if (rejected) {
      fileState.add(changeBlockId);
      scopeState.set(file.fileKey, fileState);
    } else {
      fileState.delete(changeBlockId);
      if (fileState.size) scopeState.set(file.fileKey, fileState);
      else scopeState.delete(file.fileKey);
      if (!scopeState.size) this.rejectedHunks.delete(this.scope);
    }

    this.markHunkSelectionChanged();
    this.tui.requestRender();
  }

  private openRejectedHunksErrorOverlay(error: string): void {
    if (this.activeOverlayHandle) return;
    const close = () => {
      this.activeOverlayHandle?.hide();
      this.activeOverlayHandle = null;
      this.tui.requestRender();
    };
    const overlay = new SimpleOverlay({
      onClose: close,
      handleInput: (data) => {
        if (matchesKey(data, "q") || matchesKey(data, Key.enter)) close();
      },
      render: (width) => renderRejectedHunksErrorOverlay({ theme: this.theme, width, error }),
    });
    this.activeOverlayHandle = this.tui.showOverlay(overlay, { width: "80%", maxHeight: "80%", anchor: "center" });
  }

  private moveDraftToScope(from: DiffScope, to: DiffScope): void {
    if (from === to) return;
    const targetState = this.scopeStates.get(to);
    if (!targetState) return;
    this.overallComments[to] = this.overallComments[from] || "";
    this.setComments(this.comments.map((comment) => {
      if (comment.scope !== from) return comment;
      return revalidateComment({ ...comment, scope: to }, targetState.bundle.files);
    }));
  }

  private async applyRejectedHunksBeforeSubmit(
    submitScope: DiffScope,
    submitState: ScopeState,
  ): Promise<{ ok: true; saveScope: DiffScope; saveState: ScopeState; postSubmitSections: string[] } | { ok: false }> {
    const rejectedHunksByFile = this.rejectedHunkSnapshot(submitScope);
    const rejectedCount = countRejectedHunks(rejectedHunksByFile);
    if (!rejectedCount) return { ok: true, saveScope: submitScope, saveState: submitState, postSubmitSections: [] };

    const rejectedSummary = this.rejectedBlocksToastMessage(submitScope);
    const patchText = buildRejectedHunksPatch({ bundle: submitState.bundle, rejectedHunksByFile });
    if (!patchText.trim()) {
      this.clearRejectedHunks(submitScope);
      this.callbacks.notify("Rejected changed-line selections no longer match the current diff. Reload, reselect, then submit again.", "warning");
      return { ok: false };
    }

    const applyResult = await reverseApplyPatch({
      pi: this.pi,
      repoRoot: this.repoRoot,
      patchText,
    });
    if (!applyResult.ok) {
      this.openRejectedHunksErrorOverlay(applyResult.error);
      return { ok: false };
    }

    this.clearRejectedHunks(submitScope);
    const reloadScope: DiffScope = submitScope === "a" ? "a" : "u";
    await this.loadScope(reloadScope);
    if (reloadScope !== submitScope) this.moveDraftToScope(submitScope, reloadScope);

    const saveScope = reloadScope !== submitScope ? reloadScope : submitScope;
    const stale = unresolvedCommentsForScope(this.comments, saveScope).filter((comment) => comment.status === "stale_unresolved");
    if (stale.length) {
      this.callbacks.notify("Some comments moved off the accepted diff after reverting rejected changed blocks. Resolve or delete them before submitting.", "warning");
      this.openStaleResolver(() => {
        void this.submit();
      });
      return { ok: false };
    }

    const postSubmitSections = [
      `Reverted ${rejectedCount} rejected changed block${rejectedCount === 1 ? "" : "s"} in the working tree via git apply -R${applyResult.strategy === "3way" ? " -3" : ""}${reloadScope !== submitScope ? ` and switched final submit to ${scopeName(reloadScope)}` : ""}.`,
      rejectedSummary ?? "",
    ].filter((section) => section.trim().length > 0);

    return { ok: true, saveScope, saveState: this.currentState(), postSubmitSections };
  }

  private moveDiffCursor(direction: 1 | -1, steps = 1): void {
    const file = this.currentFile();
    if (!file) return;
    let nextIndex = this.diffCursorRow;
    for (let step = 0; step < steps; step += 1) {
      const candidate = nextNavigableRowIndex(file.rows, nextIndex, direction);
      if (candidate === nextIndex) break;
      nextIndex = candidate;
    }
    this.diffCursorRow = nextIndex;
  }

  private moveDiffChangeBlock(direction: 1 | -1): void {
    const file = this.currentFile();
    if (!file) return;
    this.diffCursorRow = nextNavigableChangeBlockRowIndex(file, this.diffCursorRow, direction);
  }

  private ensureFileVisible(bodyHeight: number): void {
    this.fileScroll = ensureVisibleIndex(this.selectedFileIndex, this.fileScroll, bodyHeight);
  }

  private ensureDiffVisible(bodyHeight: number): void {
    this.diffScroll = ensureVisibleIndex(this.diffCursorRow, this.diffScroll, bodyHeight);
  }

  private setCursorToRow(rowIndex: number): void {
    const file = this.currentFile();
    if (!file) return;
    this.diffCursorRow = nearestNavigableRowIndex(file.rows, rowIndex);
  }

  private restoreScopeView(scope: DiffScope, initialize: boolean): void {
    const state = this.scopeStates.get(scope);
    if (!state) return;
    const files = state.bundle.files;
    if (!files.length) {
      this.selectedFileIndex = 0;
      this.diffCursorRow = 0;
      this.fileScroll = 0;
      this.diffScroll = 0;
      return;
    }

    const view = initialize ? defaultScopeViewState() : state.view;
    this.selectedFileIndex = restoredFileIndex({
      displayPaths: files.map((file) => file.displayPath),
      selectedPath: view.selectedPath,
      selectedFileIndex: view.selectedFileIndex,
    });
    this.fileScroll = view.fileScroll;

    const file = files[this.selectedFileIndex] ?? files[0];
    const restoredRow = restoredCursorRow({ file, view });
    this.diffCursorRow = restoredRow;
    this.diffScroll = restoredDiffScroll({ view, restoredRow });
  }

  private async loadScope(scope: DiffScope, initialize = false): Promise<void> {
    if (!initialize) this.rememberCurrentViewState();
    this.loadingMessage = `Loading ${scope} diff…`;
    this.pendingRangeSelection = null;
    this.tui.requestRender();

    const previous = this.scopeStates.get(scope);
    const previousFingerprint = previous?.bundle.fingerprint ?? null;
    const bundle = await getDiffBundle(this.pi, this.repoRoot, scope, { sessionId: this.sessionId });
    if (scope === "t" && !bundle.files.length && !initialize && this.scope !== "t") {
      this.loadingMessage = "";
      this.callbacks.notify(bundle.turnMetadata?.note || "No last-turn agent-touched diff is available for this session.", "info");
      this.tui.requestRender();
      return;
    }
    const loadedAt = new Date().toISOString();
    this.scopeStates.set(scope, nextScopeState({ scope, bundle, previous, loadedAt }));
    this.reconcileRejectedHunks(scope, previousFingerprint != null && previousFingerprint !== bundle.fingerprint);

    this.scope = scope;
    this.lastReloadTimestamp = loadedAt;
    this.loadingMessage = "";
    this.syntaxHighlightCache = null;
    this.revalidateComments(scope);
    this.restoreScopeView(scope, initialize);
    this.tui.requestRender();
  }

  private revalidateComments(scope: DiffScope): void {
    const state = this.scopeStates.get(scope);
    if (!state) return;
    this.setComments(this.comments.map((comment) => {
      if (comment.scope !== scope) return comment;
      return revalidateComment(comment, state.bundle.files);
    }));
  }

  private async reloadCurrentScope(): Promise<void> {
    await this.loadScope(this.scope);
    this.callbacks.notify(`Reloaded ${scopeName(this.scope)} diff.`, "info");
  }

  private async switchScope(scope: DiffScope): Promise<void> {
    if (scope === this.scope) return;
    await this.loadScope(scope);
  }

  private openHelpOverlay(): void {
    if (this.activeOverlayHandle) return;
    const close = () => {
      this.activeOverlayHandle?.hide();
      this.activeOverlayHandle = null;
    };
    const overlay = new SimpleOverlay({ onClose: close, render: (width) => renderHelpOverlay(this.theme, width) });
    this.activeOverlayHandle = this.tui.showOverlay(overlay, { width: "80%", maxHeight: "70%", anchor: "center" });
  }

  private openCommentEditor({
    title,
    contextLabel,
    snippetLines,
    prefill,
    emptySubmitHint,
    onSubmit,
  }: {
    title: string;
    contextLabel?: string;
    snippetLines?: string[];
    prefill?: string;
    emptySubmitHint?: string;
    onSubmit: (value: string) => void;
  }): void {
    if (this.activeOverlayHandle) return;
    const close = () => {
      this.activeOverlayHandle?.hide();
      this.activeOverlayHandle = null;
    };

    const editor = new CommentEditorOverlay({
      tui: this.tui,
      theme: this.theme,
      keybindings: this.keybindings,
      title,
      contextLabel,
      snippetLines,
      prefill,
      emptySubmitHint,
      onSubmit: (value) => {
        close();
        onSubmit(value);
      },
      onCancel: close,
    });

    this.activeOverlayHandle = this.tui.showOverlay(editor, { width: "60%", maxHeight: "75%", anchor: "center" });
  }

  private openEditCommentOverlay(comment: ReviewComment): void {
    this.openCommentEditor({
      title: `Edit comment #${comment.ordinal}`,
      contextLabel: formatCommentLocation(comment),
      snippetLines: editorSnippetForExisting(comment),
      prefill: comment.body,
      emptySubmitHint: "empty submit deletes this comment",
      onSubmit: (value) => {
        this.setComments(updateCommentBody(this.comments, comment.id, value));
        this.tui.requestRender();
      },
    });
  }

  private createCommentFlow(kind: "line" | "range" | "file", selection?: RangeSelection | null): void {
    const file = this.currentFile();
    const row = this.currentRow();
    if (!file || !row) return;
    if (kind !== "file" && row.kind === "meta" && !row.hunkId) {
      this.callbacks.notify("Move the cursor onto a diff hunk for line or range comments.", "warning");
      return;
    }

    const existing = findCommentAtTarget({ comments: this.comments, file, row, kind, scope: this.scope, selection });
    const noun = kind === "line" ? "line" : kind === "range" ? "range" : "file";
    const title = existing ? `Update ${noun} comment` : `${noun[0].toUpperCase()}${noun.slice(1)} comment`;

    this.openCommentEditor({
      title,
      contextLabel: describeCommentTarget(file, row, kind, selection),
      snippetLines: editorSnippetForDraft({ file, row, kind, selection }),
      prefill: existing?.body,
      emptySubmitHint: existing ? "empty submit deletes the existing comment" : "empty submit skips creating a comment",
      onSubmit: (value) => {
        const trimmed = value.trim();
        if (existing) {
          this.setComments(updateCommentBody(this.comments, existing.id, trimmed));
          this.tui.requestRender();
          return;
        }
        if (!trimmed) return;
        const comment = createComment({ comments: this.comments, file, row, kind, scope: this.scope, body: trimmed, selection });
        this.setComments([...this.comments, comment]);
        this.pendingRangeSelection = null;
        this.tui.requestRender();
      },
    });
  }

  private editOverallComment(): void {
    this.openCommentEditor({
      title: "Overall comment",
      contextLabel: `review scope: ${scopeDisplay(this.scope)}`,
      prefill: this.overallComments[this.scope] || "",
      emptySubmitHint: "empty submit clears the overall comment",
      onSubmit: (value) => {
        this.overallComments[this.scope] = value.trim();
        this.tui.requestRender();
      },
    });
  }

  private jumpToComment(comment: ReviewComment): void {
    const state = this.scopeStates.get(comment.scope);
    if (!state) return;
    this.scope = comment.scope;
    const fileIndex = state.bundle.files.findIndex((file) => file.fileKey === comment.fileKey);
    if (fileIndex < 0) return;
    this.selectedFileIndex = fileIndex;
    this.syntaxHighlightCache = null;
    const file = state.bundle.files[fileIndex];
    const rowIndex = mapCommentToRow(file, comment);
    if (rowIndex != null) this.setCursorToRow(rowIndex);
    this.focusMode = "diff";
    this.pendingRangeSelection = null;
    this.tui.requestRender();
  }

  private openCommentsOverlay(initialComments?: ReviewComment[], title = "comments", locationLabel?: string): void {
    if (this.activeOverlayHandle) return;
    let showAllScopes = !initialComments;
    let index = 0;
    let scroll = 0;
    let localComments = initialComments ? [...initialComments] : null;

    const getComments = () => localComments ?? this.visibleComments(showAllScopes);
    const close = () => {
      this.activeOverlayHandle?.hide();
      this.activeOverlayHandle = null;
      this.tui.requestRender();
    };

    const overlay = new SimpleOverlay({
      onClose: close,
      handleInput: (data) => {
        const comments = getComments();
        if (!initialComments && matchesKey(data, "t")) {
          showAllScopes = !showAllScopes;
          index = 0;
          scroll = 0;
          this.tui.requestRender();
          return;
        }
        if (!comments.length) return;
        if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
          index = Math.min(comments.length - 1, index + 1);
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
          index = Math.max(0, index - 1);
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const selected = comments[index];
          close();
          this.jumpToComment(selected);
          return;
        }
        if (matchesKey(data, "d")) {
          const selected = comments[index];
          if (!selected) return;
          this.setComments(removeCommentById(this.comments, selected.id));
          if (localComments) localComments = localComments.filter((comment) => comment.id !== selected.id);
          index = Math.max(0, Math.min(index, comments.length - 2));
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "e")) {
          const selected = comments[index];
          if (!selected) return;
          close();
          this.openEditCommentOverlay(selected);
        }
      },
      render: (width) => {
        const comments = getComments();
        if (initialComments) {
          return renderPeekCommentsOverlay({
            theme: this.theme,
            width,
            locationLabel: locationLabel ?? title,
            comments,
            index,
          });
        }
        const rendered = renderCommentsOverlay({
          theme: this.theme,
          width,
          terminalRows: this.tui.terminal.rows,
          scope: this.scope,
          showAllScopes,
          comments,
          index,
          scroll,
        });
        scroll = rendered.scroll;
        return rendered.lines;
      },
    });

    this.activeOverlayHandle = this.tui.showOverlay(overlay, { width: initialComments ? "55%" : "50%", maxHeight: "80%", anchor: "center" });
  }

  private openPeekCommentsOverlay(): void {
    const file = this.currentFile();
    const row = this.currentRow();
    if (!file || !row) return;
    const comments = commentsAtLocation({ comments: this.comments, file, row, scope: this.scope });
    const line = row.kind === "removed" ? row.oldLine : row.newLine;
    const side = row.kind === "removed" ? "a" : "b";
    const locationLabel = `${file.displayPath}:${side}${line ?? "?"}`;
    this.openCommentsOverlay(comments, "comments at cursor", locationLabel);
  }

  private unresolvedComments(): ReviewComment[] {
    return unresolvedCommentsForScope(this.comments, this.scope);
  }

  private openStaleResolver(onResolved: () => void): void {
    if (this.activeOverlayHandle) return;
    let staleIndex = 0;
    const close = () => {
      this.activeOverlayHandle?.hide();
      this.activeOverlayHandle = null;
      this.tui.requestRender();
    };

    const overlay = new SimpleOverlay({
      onClose: close,
      handleInput: (data) => {
        const stale = this.unresolvedComments();
        if (!stale.length) {
          close();
          onResolved();
          return;
        }
        const current = stale[Math.max(0, Math.min(stale.length - 1, staleIndex))];
        const key = printableChar(data);
        if (key && /^[1-9]$/.test(key)) {
          const nextComments = applyCandidateRemap({ comments: this.comments, comment: current, candidateIndex: Number.parseInt(key, 10) - 1 });
          if (nextComments) this.setComments(nextComments);
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "a")) {
          const file = this.currentFile();
          const row = this.currentRow();
          const nextComments = file && row ? resolveCommentAtCursor({ comments: this.comments, comment: current, file, row, downgrade: "line" }) : null;
          if (!nextComments) {
            this.callbacks.notify("Cannot attach at cursor here.", "warning");
          } else {
            this.setComments(nextComments);
          }
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "h")) {
          const file = this.currentFile();
          const row = this.currentRow();
          const selection = this.currentRangeSelection() ?? (file && row ? autoChunkSelection(file, row.rowIndex) : null);
          const nextComments = file && row ? resolveCommentAtCursor({ comments: this.comments, comment: current, file, row, downgrade: "range", selection }) : null;
          if (!nextComments) {
            this.callbacks.notify("Cursor is not inside a diff range.", "warning");
          } else {
            this.setComments(nextComments);
          }
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "f")) {
          const file = this.currentFile();
          const row = this.currentRow();
          const nextComments = file && row ? resolveCommentAtCursor({ comments: this.comments, comment: current, file, row, downgrade: "file" }) : null;
          if (nextComments) this.setComments(nextComments);
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "d")) {
          this.setComments(removeCommentById(this.comments, current.id));
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
          staleIndex = Math.min(stale.length - 1, staleIndex + 1);
          this.tui.requestRender();
          return;
        }
        if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
          staleIndex = Math.max(0, staleIndex - 1);
          this.tui.requestRender();
        }
      },
      render: (width) => {
        const stale = this.unresolvedComments();
        const current = stale[Math.max(0, Math.min(stale.length - 1, staleIndex))] ?? null;
        return renderStaleResolverOverlay({ theme: this.theme, width, current, staleIndex, staleCount: stale.length });
      },
    });

    this.activeOverlayHandle = this.tui.showOverlay(overlay, { width: "95%", maxHeight: "95%", anchor: "center" });
  }

  private async openEditor(lineTargeted: boolean): Promise<void> {
    const file = this.currentFile();
    if (!file) return;
    if (!file.editablePath) {
      this.callbacks.notify("Deleted files cannot be opened for editing.", "warning");
      return;
    }

    const result = openExternalEditor({
      tui: this.tui,
      repoRoot: this.repoRoot,
      relativePath: file.editablePath,
      line: editorLineForRow(this.currentRow(), lineTargeted),
      lineTargeted,
    });

    if (result.status != null && result.status !== 0) {
      this.callbacks.notify(`Editor exited with status ${result.status}.`, "warning");
    }

    await this.reloadCurrentScope();
  }

  private async submit(): Promise<void> {
    const submitScope = this.scope;
    const stale = this.unresolvedComments();
    if (stale.length) {
      this.openStaleResolver(() => {
        void this.submit();
      });
      return;
    }

    const submitState = this.currentState();
    const applyResult = await this.applyRejectedHunksBeforeSubmit(submitScope, submitState);
    if (!applyResult.ok) return;

    const state = applyResult.saveState;
    const saveScope = applyResult.saveScope;
    const saved = saveScopedReview({
      repoRoot: this.repoRoot,
      sessionId: this.sessionId,
      state,
      scope: saveScope,
      overallComment: this.overallComments[saveScope] || "",
      comments: this.comments,
      changes: this.changeSummary(state),
    });

    this.setComments(saved.allComments);
    const generatedPrompt = shouldGenerateCompactPrompt({
      overallComment: this.overallComments[saveScope] || "",
      scopedComments: saved.scopedComments,
    });
    if (generatedPrompt) this.callbacks.setEditorText(saved.saved.compactPrompt);
    const notice = savedReviewMessage(saved.saved, applyResult.postSubmitSections, { generatedPrompt });
    this.callbacks.notify(notice.message, notice.type);
    this.finish({ submitted: true, outputPath: saved.saved.outputPath });
  }

  private finish(result: { submitted: boolean; outputPath?: string }): void {
    if (this.closing) return;
    this.closing = true;
    this.callbacks.done(result);
  }

  private toggleRangeSelection(): void {
    const file = this.currentFile();
    const row = this.currentRow();
    if (!file || !row) return;
    if (row.kind === "meta" && !row.hunkId) {
      this.callbacks.notify("Move the cursor onto a diff hunk before starting a range selection.", "warning");
      return;
    }

    const current = this.currentRangeSelection();
    if (!current) {
      const side = row.kind === "removed" ? "old" : "new";
      this.pendingRangeSelection = {
        fileKey: file.fileKey,
        displayPath: file.displayPath,
        side,
        startRowIndex: row.rowIndex,
        endRowIndex: row.rowIndex,
        startLine: side === "old" ? row.oldLine ?? null : row.newLine ?? null,
        endLine: side === "old" ? row.oldLine ?? null : row.newLine ?? null,
      };
      this.callbacks.notify(`Range start set at ${describeRangeSelection(this.pendingRangeSelection) ?? file.displayPath}. Press x again to finish and comment.`, "info");
      this.tui.requestRender();
      return;
    }

    const completed: RangeSelection = {
      ...current,
      endRowIndex: row.rowIndex,
      endLine: current.side === "old" ? row.oldLine ?? current.endLine : row.newLine ?? current.endLine,
    };
    this.pendingRangeSelection = completed;
    this.createCommentFlow("range", completed);
  }

  private openAutoRangeComment(): void {
    this.pendingRangeSelection = null;
    this.createCommentFlow("range");
  }

  private commentSortPath(comment: ReviewComment): string {
    return comment.editablePath ?? comment.newPath ?? comment.oldPath ?? comment.displayPath;
  }

  private commentSortLine(comment: ReviewComment): number {
    return comment.anchor.applyStartLine ?? comment.anchor.applyLine ?? comment.anchor.startLine ?? comment.anchor.line ?? Number.MAX_SAFE_INTEGER;
  }

  private jumpAdjacentComment(direction: 1 | -1, fileOnly: boolean): void {
    const comments = this.scopedNavigationComments(fileOnly);
    if (!comments.length) {
      this.callbacks.notify(fileOnly ? "No comments in this file." : "No comments in this scope.", "info");
      return;
    }

    const file = this.currentFile();
    const row = this.currentRow();
    const currentPath = file ? (file.editablePath ?? file.newPath ?? file.oldPath ?? file.displayPath) : "";
    const currentLine = row ? (row.newLine ?? row.oldLine ?? 0) : 0;
    const ahead = comments.filter((comment) => {
      const path = this.commentSortPath(comment);
      const line = this.commentSortLine(comment);
      return direction === 1
        ? path > currentPath || (path === currentPath && line > currentLine)
        : path < currentPath || (path === currentPath && line < currentLine);
    });

    const target = direction === 1
      ? (ahead[0] ?? comments[0])
      : (ahead[ahead.length - 1] ?? comments[comments.length - 1]);
    this.jumpToComment(target);
  }

  private jumpCommentFile(staleOnly: boolean): void {
    const files = this.currentFiles();
    const targetIndex = nextFileIndexMatching({
      files,
      selectedFileIndex: this.selectedFileIndex,
      predicate: (fileKey) => staleOnly ? this.fileHasStale(fileKey) : this.fileCommentCount(fileKey) > 0,
    });
    if (targetIndex == null) {
      this.callbacks.notify(staleOnly ? "No files with stale comments in this scope." : "No files with comments in this scope.", "info");
      return;
    }
    this.selectedFileIndex = targetIndex;
    this.syntaxHighlightCache = null;
    const file = files[targetIndex];
    const firstComment = this.scopedNavigationComments(true).find((comment) => comment.fileKey === file.fileKey) ?? null;
    if (firstComment) {
      const rowIndex = mapCommentToRow(file, firstComment);
      if (rowIndex != null) this.setCursorToRow(rowIndex);
    } else {
      this.setCursorToRow(0);
    }
    this.focusMode = "diff";
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.loadingMessage) return;
    const bodyHeight = Math.max(8, Math.floor(this.tui.terminal.rows * 0.8) - 10);
    const action = resolveInputAction({ data, focusMode: this.focusMode, hasFile: !!this.currentFile(), bodyHeight });

    switch (action.type) {
      case "none":
        return;
      case "switchPane":
        this.focusMode = this.focusMode === "files" ? "diff" : "files";
        this.tui.requestRender();
        return;
      case "openHelp":
        this.openHelpOverlay();
        return;
      case "togglePerf":
        this.perfEnabled = !this.perfEnabled;
        this.resetPerfStats();
        this.callbacks.notify(this.perfEnabled ? "Diff-review perf stats enabled." : "Diff-review perf stats disabled.", "info");
        this.tui.requestRender();
        return;
      case "focusDiff":
        this.focusMode = "diff";
        this.tui.requestRender();
        return;
      case "createLineComment":
        this.pendingRangeSelection = null;
        this.createCommentFlow("line");
        return;
      case "quit":
        if (this.pendingRangeSelection) {
          this.clearPendingRangeSelection();
          this.callbacks.notify("Cleared the pending range selection.", "info");
          return;
        }
        this.finish({ submitted: false });
        return;
      case "switchScope":
        void this.switchScope(action.scope);
        return;
      case "reloadScope":
        void this.reloadCurrentScope();
        return;
      case "openComments":
        this.openCommentsOverlay();
        return;
      case "peekCommentsAtCursor":
        this.openPeekCommentsOverlay();
        return;
      case "createRangeComment":
        this.openAutoRangeComment();
        return;
      case "toggleRangeSelection":
        this.toggleRangeSelection();
        return;
      case "createFileComment":
        this.pendingRangeSelection = null;
        this.createCommentFlow("file");
        return;
      case "editOverallComment":
        this.editOverallComment();
        return;
      case "openEditor":
        void this.openEditor(action.lineTargeted);
        return;
      case "submit":
        void this.submit();
        return;
      case "toggleHunkRejected":
        this.toggleCurrentHunkRejected();
        return;
      case "jumpComment":
        this.jumpAdjacentComment(action.direction, action.fileOnly);
        return;
      case "jumpCommentFile":
        this.jumpCommentFile(action.staleOnly);
        return;
      case "moveFile": {
        const nextIndex = Math.max(0, Math.min(this.currentFiles().length - 1, this.selectedFileIndex + action.direction));
        if (nextIndex !== this.selectedFileIndex) this.syntaxHighlightCache = null;
        this.selectedFileIndex = nextIndex;
        this.setCursorToRow(0);
        this.ensureFileVisible(bodyHeight);
        this.tui.requestRender();
        return;
      }
      case "moveDiff":
        this.moveDiffCursor(action.direction, action.steps ?? 1);
        this.ensureDiffVisible(bodyHeight);
        this.tui.requestRender();
        return;
      case "moveChangeBlock":
        this.moveDiffChangeBlock(action.direction);
        this.ensureDiffVisible(bodyHeight);
        this.tui.requestRender();
        return;
    }
  }

  private renderFileList(width: number, height: number): string[] {
    const files = this.currentFiles();
    this.ensureFileVisible(height);
    return renderFileList({
      theme: this.theme,
      files,
      width,
      height,
      fileScroll: this.fileScroll,
      selectedFileIndex: this.selectedFileIndex,
      statusLetter: (status) => statusLetter(this.theme, status),
      fileCommentCount: (fileKey) => this.fileCommentCount(fileKey),
      fileHasStale: (fileKey) => this.fileHasStale(fileKey),
    });
  }

  private renderCommentPanel(width: number, height: number): string[] {
    const previewComments = this.currentPanelPreviewComments();
    if (previewComments.length) {
      return renderCommentInfoPanel({
        theme: this.theme,
        width,
        height,
        view: {
          kind: "preview",
          scope: this.scope,
          comments: previewComments,
        },
      });
    }

    if (this.focusMode === "files") {
      return renderCommentInfoPanel({
        theme: this.theme,
        width,
        height,
        view: {
          kind: "session",
          scope: this.scope,
          comments: this.comments,
          overallComments: this.overallComments,
        },
      });
    }

    const file = this.currentFile();
    return renderCommentInfoPanel({
      theme: this.theme,
      width,
      height,
      view: {
        kind: "file",
        scope: this.scope,
        file,
        comments: file ? this.comments.filter((comment) => comment.scope === this.scope && comment.fileKey === file.fileKey) : [],
      },
    });
  }

  private renderDiffRows(width: number, height: number): string[] {
    const file = this.currentFile();
    if (!file) {
      return Array.from({ length: height }, () => padLine(this.theme.fg("muted", "(no diff)"), width));
    }

    const startedAt = this.perfEnabled ? performance.now() : 0;
    this.ensureDiffVisible(height);
    const { highlightKey, highlightedRows } = this.currentFileSyntaxRows();
    const rendered = renderDiffRows({
      theme: this.theme,
      scope: this.scope,
      fingerprint: this.currentState().bundle.fingerprint,
      file,
      width,
      height,
      commentsEpoch: this.commentsEpoch,
      hunkSelectionEpoch: this.hunkSelectionEpoch,
      highlightKey,
      diffCursorRow: this.diffCursorRow,
      diffScroll: this.diffScroll,
      rowMarkers: this.rowMarkersForCurrentFile(),
      rejectedHunkIds: this.currentFileRejectedHunks(),
      highlightedRows,
      rowCache: this.diffRowRenderCache,
      viewportCache: this.diffViewportCache,
    });
    this.diffRowRenderCache = rendered.rowCache;
    this.diffViewportCache = rendered.viewportCache;
    this.diffScroll = rendered.diffScroll;
    this.recordPerf("visibleRows", Math.max(0, Math.min(height, file.rows.length - this.diffScroll)));
    this.recordPerf("diffRows", performance.now() - startedAt);
    return rendered.lines;
  }

  render(width: number): string[] {
    const startedAt = this.perfEnabled ? performance.now() : 0;
    if (width < MIN_WIDTH) {
      const lines = renderStatusShell({
        theme: this.theme,
        width,
        title: "π Diff Review",
        message: `terminal too narrow for diff review UI (need >= ${MIN_WIDTH} columns)`,
        messageColor: "error",
      });
      this.recordPerf("render", performance.now() - startedAt);
      return lines;
    }

    if (this.loadingMessage) {
      const lines = renderStatusShell({ theme: this.theme, width, title: "π Diff Review", message: this.loadingMessage });
      this.recordPerf("render", performance.now() - startedAt);
      return lines;
    }

    const state = this.currentState();
    const lines = renderAppShell({
      theme: this.theme,
      width,
      terminalRows: this.tui.terminal.rows,
      repoRoot: this.repoRoot,
      scope: this.scope,
      headLabel: state.startHead ? state.startHead.slice(0, 7) : "(none)",
      scopedCommentCount: commentsForSubmission(this.comments, this.scope).scopedComments.length,
      staleCount: this.unresolvedComments().length,
      lastReload: this.lastReloadTimestamp || state.lastReloadAt,
      focusMode: this.focusMode,
      diffTitle: this.currentFile()?.displayPath ?? "Diff",
      perfEnabled: this.perfEnabled,
      perfSummary: this.perfSummary(Math.max(20, width - 2)),
      sourceSummary: this.sourceSummary(state),
      selectionSummary: this.selectionSummary(),
      filePanePreferredBodyHeight: Math.max(1, this.currentFiles().length || 1),
      renderFileList: (paneWidth, bodyHeight) => this.renderFileList(paneWidth, bodyHeight),
      renderCommentPanel: (paneWidth, bodyHeight) => this.renderCommentPanel(paneWidth, bodyHeight),
      renderDiffRows: (paneWidth, bodyHeight) => this.renderDiffRows(paneWidth, bodyHeight),
    });
    this.recordPerf("render", performance.now() - startedAt);
    return lines;
  }
}
