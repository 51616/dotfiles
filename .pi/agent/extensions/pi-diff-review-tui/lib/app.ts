import type { ExtensionAPI, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, type Component, type Focusable, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import { commentsForScope, revalidateComment } from "./comments.ts";
import { resolveInputAction } from "./app-input.ts";
import { commentsSortedForNavigation } from "./comment-navigation.ts";
import { describeRangeSelection, unresolvedCommentsForScope } from "./comment-resolution.ts";
import { summarizeFileHashChanges } from "./git.ts";
import { getDiffBundle } from "./review-bundles.ts";
import {
  applyReversePatch as applyReversePatchViaBackend,
  getSshReverseApplyConsent,
  hydrateReportedOnlyTurnBundleFile,
  setSshReverseApplyConsent,
  type DiffReviewBackendKind,
  type DiffReviewRepoIdentity,
} from "./backend.ts";
import type { DiffReviewSshIdentity } from "../../lib/pi-diff-review-ssh.ts";
import { buildTurnSourceSummary, commentDisabledReason } from "./agent-report-ui.ts";
import { nextNavigableChangeBlockRowIndex, nextNavigableRowIndex } from "./navigation.ts";
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
import { reviewModeName } from "./review-mode.ts";
import type { AppCallbacks, ChangeSummary, DiffBundle, DiffRowRenderCache, DiffViewportCache, FocusMode, ParsedDiffRow, ParsedFilePatch, RangeSelection, ReviewComment, ReviewMode, ScopeState } from "./types.ts";
import { buildRejectedHunksPatch, countRejectedHunks, reverseApplyPatch } from "./rejected-hunks.ts";
import { createAppWorkflows } from "./app-workflows.ts";
import { createAppRendering } from "./app-rendering.ts";

type PerfBucket = {
  count: number;
  totalMs: number;
  maxMs: number;
};

export class DiffReviewApp implements Component, Focusable {
  focused = false;

  private readonly pi: ExtensionAPI;
  private readonly repoRoot: string;
  private readonly repoLabel: string;
  private readonly scopeKey: string;
  private readonly allowRepoRootWrites: boolean;
  private readonly backendKind: DiffReviewBackendKind;
  private readonly sshIdentity?: DiffReviewSshIdentity;
  private readonly sessionId: string;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly callbacks: AppCallbacks;

  private scope: ReviewMode = "a";
  private scopeStates = new Map<ReviewMode, ScopeState>();
  private loadingMessage = "Loading diff…";
  private focusMode: FocusMode = "files";
  private selectedFileIndex = 0;
  private diffCursorRow = 0;
  private fileScroll = 0;
  private diffScroll = 0;
  private comments: ReviewComment[] = [];
  private overallComments: Record<ReviewMode, string> = { t: "", a: "" };
  private lastReloadTimestamp = "";
  private activeOverlayHandle: OverlayHandle | null = null;
  private closing = false;
  private commentsEpoch = 0;
  private hunkSelectionEpoch = 0;
  private rejectedHunks = new Map<ReviewMode, Map<string, Set<string>>>();
  private pendingRangeSelection: RangeSelection | null = null;
  private scopeCommentStatsCache: { scope: ReviewMode; epoch: number; counts: Map<string, number>; stale: Set<string> } | null = null;
  private rowMarkerCache: { scope: ReviewMode; fileKey: string; epoch: number; markers: Map<number, string> } | null = null;
  private diffRowRenderCache: DiffRowRenderCache | null = null;
  private diffViewportCache: DiffViewportCache | null = null;
  private syntaxHighlightCache: {
    scope: ReviewMode;
    fingerprint: string;
    fileKey: string;
    language: string | undefined;
    highlighted: Map<number, string>;
  } | null = null;
  private perfEnabled = false;
  private readonly pendingReportedOnlyHydrations = new Set<string>();
  private readonly workflows: ReturnType<typeof createAppWorkflows>;
  private readonly rendering: ReturnType<typeof createAppRendering>;
  private perfStats: { render: PerfBucket; diffRows: PerfBucket; visibleRows: PerfBucket } = {
    render: { count: 0, totalMs: 0, maxMs: 0 },
    diffRows: { count: 0, totalMs: 0, maxMs: 0 },
    visibleRows: { count: 0, totalMs: 0, maxMs: 0 },
  };

  constructor({
    pi,
    repoRoot,
    repoLabel,
    scopeKey,
    allowRepoRootWrites,
    backendKind,
    sshIdentity,
    sessionId,
    tui,
    theme,
    keybindings,
    callbacks,
  }: {
    pi: ExtensionAPI;
    repoRoot: string;
    repoLabel: string;
    scopeKey: string;
    allowRepoRootWrites: boolean;
    backendKind: DiffReviewBackendKind;
    sshIdentity?: DiffReviewSshIdentity;
    sessionId: string;
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    callbacks: AppCallbacks;
  }) {
    this.pi = pi;
    this.repoRoot = repoRoot;
    this.repoLabel = repoLabel;
    this.scopeKey = scopeKey;
    this.allowRepoRootWrites = allowRepoRootWrites;
    this.backendKind = backendKind;
    this.sshIdentity = sshIdentity;
    this.sessionId = sessionId;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.callbacks = callbacks;
    this.workflows = createAppWorkflows({
      pi: this.pi,
      tui: this.tui,
      theme: this.theme,
      keybindings: this.keybindings,
      callbacks: this.callbacks,
      repoRoot: this.repoRoot,
      scopeKey: this.scopeKey,
      allowRepoRootWrites: this.allowRepoRootWrites,
      backendKind: this.backendKind,
      sessionId: this.sessionId,
      getRepoIdentity: () => this.repoIdentity(),
      getScope: () => this.scope,
      setScope: (scope) => { this.scope = scope; },
      getScopeState: (scope) => this.scopeStates.get(scope),
      getCurrentState: () => this.currentState(),
      getCurrentFiles: () => this.currentFiles(),
      getCurrentFile: () => this.currentFile(),
      getCurrentRow: () => this.currentRow(),
      getFocusMode: () => this.focusMode,
      setFocusMode: (mode) => { this.focusMode = mode; },
      getSelectedFileIndex: () => this.selectedFileIndex,
      setSelectedFileIndex: (index) => { this.selectedFileIndex = index; },
      getComments: () => this.comments,
      setComments: (comments) => this.setComments(comments),
      getOverallComment: (scope) => this.overallComments[scope] || "",
      setOverallComment: (scope, value) => { this.overallComments[scope] = value; },
      getPendingRangeSelection: () => this.pendingRangeSelection,
      setPendingRangeSelection: (selection) => { this.pendingRangeSelection = selection; },
      clearPendingRangeSelection: (render = true) => this.clearPendingRangeSelection(render),
      currentRangeSelection: () => this.currentRangeSelection(),
      visibleComments: (includeAllScopes = false) => this.visibleComments(includeAllScopes),
      scopedNavigationComments: (fileOnly = false) => this.scopedNavigationComments(fileOnly),
      unresolvedComments: () => this.unresolvedComments(),
      fileCommentCount: (fileKey) => this.fileCommentCount(fileKey),
      fileHasStale: (fileKey) => this.fileHasStale(fileKey),
      setCursorToRow: (rowIndex) => this.setCursorToRow(rowIndex),
      resetSyntaxHighlightCache: () => { this.syntaxHighlightCache = null; },
      requestRender: () => this.tui.requestRender(),
      getActiveOverlayHandle: () => this.activeOverlayHandle,
      setActiveOverlayHandle: (handle) => { this.activeOverlayHandle = handle; },
      applyRejectedHunksBeforeSubmit: (submitMode, submitState) => this.applyRejectedHunksBeforeSubmit(submitMode, submitState),
      reloadCurrentScope: () => this.reloadCurrentScope(),
      changeSummary: (state) => this.changeSummary(state),
      onSelectionChanged: () => this.maybeHydrateCurrentReportedOnlyFile(),
      finish: (result) => this.finish(result),
    });
    this.rendering = createAppRendering({
      theme: this.theme,
      tui: this.tui,
      repoRoot: this.repoRoot,
      repoLabel: this.repoLabel,
      getScope: () => this.scope,
      getFocusMode: () => this.focusMode,
      getCurrentState: () => this.currentState(),
      getCurrentFiles: () => this.currentFiles(),
      getCurrentFile: () => this.currentFile(),
      getCurrentRow: () => this.currentRow(),
      getComments: () => this.comments,
      getOverallComments: () => this.overallComments,
      getLastReloadTimestamp: () => this.lastReloadTimestamp,
      getSelectedFileIndex: () => this.selectedFileIndex,
      getDiffCursorRow: () => this.diffCursorRow,
      getFileScroll: () => this.fileScroll,
      getDiffScroll: () => this.diffScroll,
      setDiffScroll: (value) => { this.diffScroll = value; },
      ensureFileVisible: (bodyHeight) => this.ensureFileVisible(bodyHeight),
      ensureDiffVisible: (bodyHeight) => this.ensureDiffVisible(bodyHeight),
      fileCommentCount: (fileKey) => this.fileCommentCount(fileKey),
      fileHasStale: (fileKey) => this.fileHasStale(fileKey),
      unresolvedComments: () => this.unresolvedComments(),
      getCommentsEpoch: () => this.commentsEpoch,
      getHunkSelectionEpoch: () => this.hunkSelectionEpoch,
      getRowMarkerCache: () => this.rowMarkerCache,
      setRowMarkerCache: (value) => { this.rowMarkerCache = value; },
      getSyntaxHighlightCache: () => this.syntaxHighlightCache,
      setSyntaxHighlightCache: (value) => { this.syntaxHighlightCache = value; },
      getDiffRowRenderCache: () => this.diffRowRenderCache,
      setDiffRowRenderCache: (value) => { this.diffRowRenderCache = value; },
      getDiffViewportCache: () => this.diffViewportCache,
      setDiffViewportCache: (value) => { this.diffViewportCache = value; },
      currentFileRejectedHunks: () => this.currentFileRejectedHunks(),
      getLoadingMessage: () => this.loadingMessage,
      perfEnabled: () => this.perfEnabled,
      perfSummary: (width) => this.perfSummary(width),
      recordPerf: (bucket, value) => this.recordPerf(bucket, value),
      selectionSummary: () => this.selectionSummary(),
      sourceSummary: (state) => this.sourceSummary(state),
      warningSummary: (state) => this.warningSummary(state),
    });
  }

  private repoIdentity(): DiffReviewRepoIdentity {
    return {
      backend: this.backendKind,
      repoRoot: this.repoRoot,
      scopeKey: this.scopeKey,
      allowRepoRootWrites: this.allowRepoRootWrites,
      repoLabel: this.repoLabel,
      ssh: this.sshIdentity,
    };
  }

  async init(scope: ReviewMode = "a", initialBundle?: DiffBundle): Promise<void> {
    if (initialBundle) {
      const loadedAt = new Date().toISOString();
      this.scopeStates.set(scope, nextScopeState({ scope, bundle: initialBundle, previous: undefined, loadedAt }));
      this.scope = scope;
      this.lastReloadTimestamp = loadedAt;
      this.loadingMessage = "";
      this.revalidateComments(scope);
      this.restoreScopeView(scope, true);
      this.tui.requestRender();
      this.maybeHydrateCurrentReportedOnlyFile();
      return;
    }
    await this.loadScope(scope, true);
  }

  async initInitialSelection(loadInitialSelection: () => Promise<{ initialMode: ReviewMode; initialBundle: DiffBundle; notification?: string }>): Promise<void> {
    this.loadingMessage = "Loading diff…";
    this.tui.requestRender();

    let selection;
    try {
      selection = await loadInitialSelection();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadingMessage = "";
      this.callbacks.notify(`Failed to build initial diff bundle: ${message}`, "error");
      this.finish({ submitted: false });
      return;
    }

    const emptySelectionMessage = selection.notification || "No diff to review in last turn or workspace vs HEAD.";
    if (selection.notification) {
      this.callbacks.notify(selection.notification, "info");
    }
    if (!selection.initialBundle.files.length) {
      if (!selection.notification) {
        this.callbacks.notify(emptySelectionMessage, "info");
      }
      this.loadingMessage = "";
      this.finish({ submitted: false });
      return;
    }

    await this.init(selection.initialMode, selection.initialBundle);
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

  private rejectedHunksForScope(scope: ReviewMode, create = false): Map<string, Set<string>> {
    const existing = this.rejectedHunks.get(scope);
    if (existing || !create) return existing ?? new Map();
    const created = new Map<string, Set<string>>();
    this.rejectedHunks.set(scope, created);
    return created;
  }

  private rejectedHunkSnapshot(scope: ReviewMode): Map<string, ReadonlySet<string>> {
    const scopeState = this.rejectedHunks.get(scope);
    if (!scopeState?.size) return new Map();
    const snapshot = new Map<string, ReadonlySet<string>>();
    for (const [fileKey, hunkIds] of scopeState.entries()) {
      if (!hunkIds.size) continue;
      snapshot.set(fileKey, new Set(hunkIds));
    }
    return snapshot;
  }

  private clearRejectedHunks(scope: ReviewMode, render = false): void {
    if (!this.rejectedHunks.delete(scope)) return;
    this.markHunkSelectionChanged();
    if (render) this.tui.requestRender();
  }

  private pruneInspectOnlyRejectedHunks(scope: ReviewMode, files: ParsedFilePatch[]): boolean {
    const scopeState = this.rejectedHunks.get(scope);
    if (!scopeState?.size) return false;

    const inspectOnlyKeys = new Set(files.filter((file) => commentDisabledReason(file)).map((file) => file.fileKey));
    if (!inspectOnlyKeys.size) return false;

    let changed = false;
    for (const fileKey of inspectOnlyKeys) {
      if (!scopeState.delete(fileKey)) continue;
      changed = true;
    }
    if (!changed) return false;

    if (!scopeState.size) this.rejectedHunks.delete(scope);
    this.markHunkSelectionChanged();
    return true;
  }

  private reconcileRejectedHunks(scope: ReviewMode, bundleChanged: boolean): void {
    const scopeState = this.rejectedHunks.get(scope);
    if (!scopeState?.size) return;
    if (bundleChanged) {
      this.clearRejectedHunks(scope);
      return;
    }

    const files = this.scopeStates.get(scope)?.bundle.files ?? [];
    const prunedInspectOnly = this.pruneInspectOnlyRejectedHunks(scope, files);
    const liveScopeState = this.rejectedHunks.get(scope);
    if (!liveScopeState?.size) return;

    const validSelections = new Map(files
      .filter((file) => !commentDisabledReason(file))
      .map((file) => [file.fileKey, new Set(file.changeBlocks.map((block) => block.id))]));
    let changed = prunedInspectOnly;

    for (const [fileKey, hunkIds] of liveScopeState.entries()) {
      const validIds = validSelections.get(fileKey);
      if (!validIds) {
        liveScopeState.delete(fileKey);
        changed = true;
        continue;
      }
      for (const hunkId of [...hunkIds]) {
        if (validIds.has(hunkId)) continue;
        hunkIds.delete(hunkId);
        changed = true;
      }
      if (!hunkIds.size) {
        liveScopeState.delete(fileKey);
        changed = true;
      }
    }

    if (!liveScopeState.size) this.rejectedHunks.delete(scope);
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

  private rejectedBlocksToastMessage(scope: ReviewMode): string | null {
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

  private changeSummary(state: ScopeState): { sinceStart: ChangeSummary; sinceLastReload: ChangeSummary } {
    return {
      sinceStart: summarizeFileHashChanges(state.startFileHashes, state.bundle.fileHashes),
      sinceLastReload: summarizeFileHashChanges(state.previousFileHashes, state.bundle.fileHashes),
    };
  }

  private sourceSummary(state: ScopeState): string | null {
    if (state.bundle.sourceKind !== "turn") return null;
    return buildTurnSourceSummary(state.bundle.turnMetadata);
  }

  private warningSummary(state: ScopeState): string | null {
    const warnings: string[] = [];

    if (Array.isArray(state.bundle.warnings)) {
      for (const item of state.bundle.warnings) {
        if (typeof item === "string" && item.trim()) warnings.push(item.trim());
      }
    }

    const omitted = state.bundle.turnMetadata?.omitted_paths;
    if (omitted && typeof omitted === "object") {
      const count = Object.keys(omitted).length;
      if (count > 0) warnings.push(`Turn snapshot omitted content for ${count} path${count === 1 ? "" : "s"}.`);
    }

    return warnings.length ? warnings.join(" ") : null;
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

  private unresolvedComments(): ReviewComment[] {
    return unresolvedCommentsForScope(this.comments, this.scope);
  }

  private toggleCurrentHunkRejected(): void {
    const file = this.currentFile();
    const row = this.currentRow();
    const changeBlockId = row?.changeBlockId ?? null;
    if (!file || !row || !changeBlockId || (row.kind !== "added" && row.kind !== "removed")) return;

    const disabledReason = commentDisabledReason(file);
    if (disabledReason) {
      this.callbacks.notify(disabledReason, "info");
      return;
    }

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

  private moveDraftToScope(from: ReviewMode, to: ReviewMode): void {
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
    submitMode: ReviewMode,
    submitState: ScopeState,
  ): Promise<{ ok: true; saveMode: ReviewMode; saveState: ScopeState; postSubmitSections: string[] } | { ok: false }> {
    this.pruneInspectOnlyRejectedHunks(submitMode, submitState.bundle.files);
    const rejectedHunksByFile = this.rejectedHunkSnapshot(submitMode);
    const rejectedCount = countRejectedHunks(rejectedHunksByFile);
    if (!rejectedCount) return { ok: true, saveMode: submitMode, saveState: submitState, postSubmitSections: [] };

    const rejectedSummary = this.rejectedBlocksToastMessage(submitMode);
    const patchText = buildRejectedHunksPatch({ bundle: submitState.bundle, rejectedHunksByFile });
    if (!patchText.trim()) {
      this.clearRejectedHunks(submitMode);
      this.callbacks.notify("Rejected changed-line selections no longer match the current diff. Reload, reselect, then submit again.", "info");
      return { ok: false };
    }

    const identity = this.repoIdentity();

    if (this.backendKind === "ssh") {
      const consent = getSshReverseApplyConsent();
      if (consent !== true) {
        if (consent === null) {
          const ok = await this.callbacks.confirm(
            "Apply rejected hunks on remote?",
            [
              "This will run git apply -R on the REMOTE repository working tree to revert the changed blocks you rejected.",
              "",
              "This mutates the remote checkout.",
              "",
              "Allow this for the rest of this pi session?",
            ].join("\n"),
          );
          setSshReverseApplyConsent(ok);
          if (!ok) {
            this.callbacks.notify("Remote reverse-apply not allowed. No changes were reverted.", "info");
            return { ok: false };
          }
        } else {
          this.callbacks.notify("Remote reverse-apply is disabled for this session. No changes were reverted.", "info");
          return { ok: false };
        }
      }

      let applyResult: Awaited<ReturnType<typeof reverseApplyPatch>>;
      try {
        applyResult = await reverseApplyPatch({
          applyRemote: async (patch) => applyReversePatchViaBackend(this.pi, identity, patch),
          repoRoot: this.repoRoot,
          patchText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.workflows.openRejectedHunksErrorOverlay(
          [
            `Remote reverse-apply failed: ${message}`,
            "",
            "If the remote operation partially succeeded, do NOT retry blindly.",
            "Check `git status` / `git diff` on the remote and then reload diff-review.",
          ].join("\n"),
        );
        return { ok: false };
      }
      if (!applyResult.ok) {
        this.workflows.openRejectedHunksErrorOverlay(applyResult.error);
        return { ok: false };
      }

      this.clearRejectedHunks(submitMode);
      const reloadMode: ReviewMode = "a";
      await this.loadScope(reloadMode);
      if (reloadMode !== submitMode) this.moveDraftToScope(submitMode, reloadMode);

      const saveMode = reloadMode !== submitMode ? reloadMode : submitMode;
      const stale = unresolvedCommentsForScope(this.comments, saveMode).filter((comment) => comment.status === "stale_unresolved");
      if (stale.length) {
        this.callbacks.notify("Some comments moved off the accepted diff after reverting rejected changed blocks. Resolve or delete them before submitting.", "info");
        this.workflows.openStaleResolver(() => {
          void this.workflows.submit();
        });
        return { ok: false };
      }

      const postSubmitSections = [
        `Reverted ${rejectedCount} rejected changed block${rejectedCount === 1 ? "" : "s"} in the REMOTE working tree via git apply -R${applyResult.strategy === "3way" ? " -3" : ""}${reloadMode !== submitMode ? ` and switched final submit to ${reviewModeName(reloadMode)}` : ""}.`,
        rejectedSummary ?? "",
      ].filter((section) => section.trim().length > 0);

      return { ok: true, saveMode, saveState: this.currentState(), postSubmitSections };
    }

    const applyResult = await reverseApplyPatch({
      pi: this.pi,
      repoRoot: this.repoRoot,
      patchText,
    });
    if (!applyResult.ok) {
      this.workflows.openRejectedHunksErrorOverlay(applyResult.error);
      return { ok: false };
    }

    this.clearRejectedHunks(submitMode);
    const reloadMode: ReviewMode = "a";
    await this.loadScope(reloadMode);
    if (reloadMode !== submitMode) this.moveDraftToScope(submitMode, reloadMode);

    const saveMode = reloadMode !== submitMode ? reloadMode : submitMode;
    const stale = unresolvedCommentsForScope(this.comments, saveMode).filter((comment) => comment.status === "stale_unresolved");
    if (stale.length) {
      this.callbacks.notify("Some comments moved off the accepted diff after reverting rejected changed blocks. Resolve or delete them before submitting.", "info");
      this.workflows.openStaleResolver(() => {
        void this.workflows.submit();
      });
      return { ok: false };
    }

    const postSubmitSections = [
      `Reverted ${rejectedCount} rejected changed block${rejectedCount === 1 ? "" : "s"} in the working tree via git apply -R${applyResult.strategy === "3way" ? " -3" : ""}${reloadMode !== submitMode ? ` and switched final submit to ${reviewModeName(reloadMode)}` : ""}.`,
      rejectedSummary ?? "",
    ].filter((section) => section.trim().length > 0);

    return { ok: true, saveMode, saveState: this.currentState(), postSubmitSections };
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

  private restoreScopeView(scope: ReviewMode, initialize: boolean): void {
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

  private maybeHydrateCurrentReportedOnlyFile(): void {
    if (this.backendKind !== "ssh") return;
    const state = this.scopeStates.get(this.scope);
    if (!state || state.bundle.sourceKind !== "turn" || !state.bundle.turnMetadata) return;
    const file = state.bundle.files[Math.max(0, Math.min(state.bundle.files.length - 1, this.selectedFileIndex))] ?? null;
    if (!file || file.reviewProvenance !== "reported_only" || file.reportedOnlyDiffState !== "deferred_current_repo_diff") {
      return;
    }

    const hydrationKey = `${this.scope}:${state.bundle.fingerprint}:${file.fileKey}`;
    if (this.pendingReportedOnlyHydrations.has(hydrationKey)) return;
    this.pendingReportedOnlyHydrations.add(hydrationKey);
    void this.hydrateReportedOnlyBundleFile(this.scope, state.bundle.fingerprint, file.fileKey, file.displayPath, hydrationKey);
  }

  private async hydrateReportedOnlyBundleFile(scope: ReviewMode, bundleFingerprint: string, fileKey: string, displayPath: string, hydrationKey: string): Promise<void> {
    try {
      const state = this.scopeStates.get(scope);
      if (!state || state.bundle.fingerprint !== bundleFingerprint) return;

      const nextBundle = await hydrateReportedOnlyTurnBundleFile(this.pi, this.repoIdentity(), state.bundle, fileKey);
      const current = this.scopeStates.get(scope);
      if (!current || current.bundle.fingerprint !== bundleFingerprint || nextBundle.fingerprint === current.bundle.fingerprint) {
        return;
      }

      current.bundle = nextBundle;
      current.startFingerprint = nextBundle.fingerprint;
      current.startFileHashes = new Map(nextBundle.fileHashes);
      current.lastReloadFingerprint = nextBundle.fingerprint;
      current.previousFileHashes = new Map(nextBundle.fileHashes);
      this.syntaxHighlightCache = null;
      this.rowMarkerCache = null;
      this.diffRowRenderCache = null;
      this.diffViewportCache = null;
      this.revalidateComments(scope);
      this.tui.requestRender();
    } catch (error) {
      const current = this.scopeStates.get(scope);
      if (current?.bundle.fingerprint === bundleFingerprint) {
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.notify(`Could not load the advisory repo diff for ${displayPath}: ${message}`, "warning");
      }
    } finally {
      this.pendingReportedOnlyHydrations.delete(hydrationKey);
    }
  }

  private async loadScope(scope: ReviewMode, initialize = false): Promise<void> {
    if (!initialize) this.rememberCurrentViewState();
    this.loadingMessage = `Loading ${scope} diff…`;
    this.pendingRangeSelection = null;
    this.tui.requestRender();

    const previous = this.scopeStates.get(scope);
    const previousFingerprint = previous?.bundle.fingerprint ?? null;

    let bundle: DiffBundle;
    try {
      bundle = await getDiffBundle(this.pi, this.repoIdentity(), scope, { sessionId: this.sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadingMessage = "";
      this.callbacks.notify(`Failed to load ${reviewModeName(scope)} diff: ${message}`, "error");
      this.tui.requestRender();
      return;
    }
    if (scope === "t" && !bundle.files.length && !initialize) {
      this.loadingMessage = "";
      this.callbacks.notify(bundle.turnMetadata?.note || "No last-turn repo snapshot diff is available for this session.", "info");
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
    this.maybeHydrateCurrentReportedOnlyFile();
  }

  private revalidateComments(scope: ReviewMode): void {
    const state = this.scopeStates.get(scope);
    if (!state) return;
    this.setComments(this.comments.map((comment) => {
      if (comment.scope !== scope) return comment;
      return revalidateComment(comment, state.bundle.files);
    }));
  }

  private async reloadCurrentScope(): Promise<void> {
    await this.loadScope(this.scope);
    this.callbacks.notify(`Reloaded ${reviewModeName(this.scope)} diff.`, "info");
  }

  private async switchMode(scope: ReviewMode): Promise<void> {
    if (scope === this.scope) return;
    await this.loadScope(scope);
  }

  private finish(result: { submitted: boolean; outputPath?: string }): void {
    if (this.closing) return;
    this.closing = true;
    this.callbacks.done(result);
  }

  handleInput(data: string): void {
    if (this.loadingMessage) {
      if (data === "q" || data === "\u001b") {
        this.finish({ submitted: false });
      }
      return;
    }
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
        this.workflows.openHelpOverlay();
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
        this.workflows.createCommentFlow("line");
        return;
      case "quit":
        if (this.pendingRangeSelection) {
          this.clearPendingRangeSelection();
          this.callbacks.notify("Cleared the pending range selection.", "info");
          return;
        }
        this.finish({ submitted: false });
        return;
      case "switchMode":
        void this.switchMode(action.mode);
        return;
      case "reloadScope":
        void this.reloadCurrentScope();
        return;
      case "openComments":
        this.workflows.openCommentsOverlay();
        return;
      case "peekCommentsAtCursor":
        this.workflows.openPeekCommentsOverlay();
        return;
      case "createRangeComment":
        this.workflows.openAutoRangeComment();
        return;
      case "toggleRangeSelection":
        this.workflows.toggleRangeSelection();
        return;
      case "createFileComment":
        this.pendingRangeSelection = null;
        this.workflows.createCommentFlow("file");
        return;
      case "editOverallComment":
        this.workflows.editOverallComment();
        return;
      case "openEditor":
        void this.workflows.openEditor(action.lineTargeted);
        return;
      case "submit":
        void this.workflows.submit();
        return;
      case "toggleHunkRejected":
        this.toggleCurrentHunkRejected();
        return;
      case "jumpComment":
        this.workflows.jumpAdjacentComment(action.direction, action.fileOnly);
        return;
      case "jumpCommentFile":
        this.workflows.jumpCommentFile(action.staleOnly);
        return;
      case "moveFile": {
        const nextIndex = Math.max(0, Math.min(this.currentFiles().length - 1, this.selectedFileIndex + action.direction));
        if (nextIndex !== this.selectedFileIndex) this.syntaxHighlightCache = null;
        this.selectedFileIndex = nextIndex;
        this.setCursorToRow(0);
        this.ensureFileVisible(bodyHeight);
        this.maybeHydrateCurrentReportedOnlyFile();
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

  render(width: number): string[] {
    return this.rendering.render(width);
  }
}
