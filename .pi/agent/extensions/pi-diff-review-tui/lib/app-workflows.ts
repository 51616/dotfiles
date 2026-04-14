import type { ExtensionAPI, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";
import {
  commentsAtLocation,
  createComment,
  findCommentAtTarget,
  formatCommentLocation,
  mapCommentToRow,
} from "./comments.ts";
import { commentsSortedForNavigation, nextFileIndexMatching } from "./comment-navigation.ts";
import { editorSnippetForDraft, editorSnippetForExisting } from "./comment-snippets.ts";
import {
  applyCandidateRemap,
  autoChunkSelection,
  describeCommentTarget,
  describeRangeSelection,
  printableChar,
  removeCommentById,
  resolveCommentAtCursor,
  unresolvedCommentsForScope,
  updateCommentBody,
} from "./comment-resolution.ts";
import { openExternalEditor } from "./external-editor.ts";
import { editRemoteFileViaLocalStage, SshStagedEditorError } from "./ssh-staged-editor.ts";
import { commentDisabledReason } from "./agent-report-ui.ts";
import {
  renderCommentsOverlay,
  renderHelpOverlay,
  renderPeekCommentsOverlay,
  renderRejectedHunksErrorOverlay,
  renderStaleResolverOverlay,
} from "./overlay-views.ts";
import {
  commentsForSubmission,
  editorLineForRow,
  savedReviewMessage,
  saveScopedReview,
  shouldGenerateCompactPrompt,
} from "./review-session.ts";
import { reviewModeDisplay, reviewModeName } from "./review-mode.ts";
import { CommentEditorOverlay } from "./comment-editor-overlay.ts";
import { SimpleOverlay } from "./simple-overlay.ts";
import type {
  AppCallbacks,
  ChangeSummary,
  FocusMode,
  ParsedDiffRow,
  ParsedFilePatch,
  RangeSelection,
  ReviewComment,
  ReviewMode,
  ScopeState,
} from "./types.ts";
import type { DiffReviewRepoIdentity } from "./backend.ts";

export interface ApplyRejectedBeforeSubmitResult {
  ok: true;
  saveMode: ReviewMode;
  saveState: ScopeState;
  postSubmitSections: string[];
}

export interface AppWorkflowContext {
  pi: ExtensionAPI;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  callbacks: AppCallbacks;
  repoRoot: string;
  /** Stable identifier used only for local storage paths. */
  scopeKey?: string;
  /** Whether repo-local writes (repoRoot/.pi/diff-review) are allowed. */
  allowRepoRootWrites?: boolean;
  backendKind?: "local" | "ssh";
  sessionId: string;
  getRepoIdentity: () => DiffReviewRepoIdentity;
  getScope: () => ReviewMode;
  setScope: (scope: ReviewMode) => void;
  getScopeState: (scope: ReviewMode) => ScopeState | undefined;
  getCurrentState: () => ScopeState;
  getCurrentFiles: () => ParsedFilePatch[];
  getCurrentFile: () => ParsedFilePatch | null;
  getCurrentRow: () => ParsedDiffRow | null;
  getFocusMode: () => FocusMode;
  setFocusMode: (mode: FocusMode) => void;
  getSelectedFileIndex: () => number;
  setSelectedFileIndex: (index: number) => void;
  getComments: () => ReviewComment[];
  setComments: (comments: ReviewComment[]) => void;
  getOverallComment: (scope: ReviewMode) => string;
  setOverallComment: (scope: ReviewMode, value: string) => void;
  getPendingRangeSelection: () => RangeSelection | null;
  setPendingRangeSelection: (selection: RangeSelection | null) => void;
  clearPendingRangeSelection: (render?: boolean) => void;
  currentRangeSelection: () => RangeSelection | null;
  visibleComments: (includeAllScopes?: boolean) => ReviewComment[];
  scopedNavigationComments: (fileOnly?: boolean) => ReviewComment[];
  unresolvedComments: () => ReviewComment[];
  fileCommentCount: (fileKey: string) => number;
  fileHasStale: (fileKey: string) => boolean;
  setCursorToRow: (rowIndex: number) => void;
  resetSyntaxHighlightCache: () => void;
  requestRender: () => void;
  getActiveOverlayHandle: () => OverlayHandle | null;
  setActiveOverlayHandle: (handle: OverlayHandle | null) => void;
  applyRejectedHunksBeforeSubmit: (
    submitMode: ReviewMode,
    submitState: ScopeState,
  ) => Promise<ApplyRejectedBeforeSubmitResult | { ok: false }>;
  reloadCurrentScope: () => Promise<void>;
  changeSummary: (state: ScopeState) => { sinceStart: ChangeSummary; sinceLastReload: ChangeSummary };
  finish: (result: { submitted: boolean; outputPath?: string }) => void;
}

export function createAppWorkflows(ctx: AppWorkflowContext) {
  const hasActiveOverlay = (): boolean => ctx.getActiveOverlayHandle() != null;

  const closeOverlay = (requestRender = true): void => {
    ctx.getActiveOverlayHandle()?.hide();
    ctx.setActiveOverlayHandle(null);
    if (requestRender) ctx.requestRender();
  };

  const openCommentEditor = ({
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
  }): void => {
    if (hasActiveOverlay()) return;

    const editor = new CommentEditorOverlay({
      tui: ctx.tui,
      theme: ctx.theme,
      keybindings: ctx.keybindings,
      title,
      contextLabel,
      snippetLines,
      prefill,
      emptySubmitHint,
      onSubmit: (value) => {
        closeOverlay(false);
        onSubmit(value);
      },
      onCancel: () => closeOverlay(false),
    });

    ctx.setActiveOverlayHandle(ctx.tui.showOverlay(editor, { width: "60%", maxHeight: "75%", anchor: "center" }));
  };

  const workflows = {
    openRejectedHunksErrorOverlay(error: string): void {
      if (hasActiveOverlay()) return;
      const overlay = new SimpleOverlay({
        onClose: closeOverlay,
        handleInput: (data) => {
          if (matchesKey(data, "q") || matchesKey(data, Key.enter)) closeOverlay();
        },
        render: (width) => renderRejectedHunksErrorOverlay({ theme: ctx.theme, width, error }),
      });
      ctx.setActiveOverlayHandle(ctx.tui.showOverlay(overlay, { width: "80%", maxHeight: "80%", anchor: "center" }));
    },

    openHelpOverlay(): void {
      if (hasActiveOverlay()) return;
      const overlay = new SimpleOverlay({ onClose: () => closeOverlay(false), render: (width) => renderHelpOverlay(ctx.theme, width) });
      ctx.setActiveOverlayHandle(ctx.tui.showOverlay(overlay, { width: "80%", maxHeight: "70%", anchor: "center" }));
    },

    openEditCommentOverlay(comment: ReviewComment): void {
      openCommentEditor({
        title: `Edit comment #${comment.ordinal}`,
        contextLabel: formatCommentLocation(comment),
        snippetLines: editorSnippetForExisting(comment),
        prefill: comment.body,
        emptySubmitHint: "empty submit deletes this comment",
        onSubmit: (value) => {
          ctx.setComments(updateCommentBody(ctx.getComments(), comment.id, value));
          ctx.requestRender();
        },
      });
    },

    createCommentFlow(kind: "line" | "range" | "file", selection?: RangeSelection | null): void {
      const file = ctx.getCurrentFile();
      const row = ctx.getCurrentRow();
      if (!file || !row) return;

      const disabledReason = commentDisabledReason(file);
      if (disabledReason) {
        ctx.callbacks.notify(disabledReason, "info");
        return;
      }
      if (kind !== "file" && row.kind === "meta" && !row.hunkId) {
        return;
      }

      const existing = findCommentAtTarget({ comments: ctx.getComments(), file, row, kind, scope: ctx.getScope(), selection });
      const noun = kind === "line" ? "line" : kind === "range" ? "range" : "file";
      const title = existing ? `Update ${noun} comment` : `${noun[0].toUpperCase()}${noun.slice(1)} comment`;

      openCommentEditor({
        title,
        contextLabel: describeCommentTarget(file, row, kind, selection),
        snippetLines: editorSnippetForDraft({ file, row, kind, selection }),
        prefill: existing?.body,
        emptySubmitHint: existing ? "empty submit deletes the existing comment" : "empty submit skips creating a comment",
        onSubmit: (value) => {
          const trimmed = value.trim();
          if (existing) {
            ctx.setComments(updateCommentBody(ctx.getComments(), existing.id, trimmed));
            ctx.requestRender();
            return;
          }
          if (!trimmed) return;
          const comment = createComment({ comments: ctx.getComments(), file, row, kind, scope: ctx.getScope(), body: trimmed, selection });
          ctx.setComments([...ctx.getComments(), comment]);
          ctx.setPendingRangeSelection(null);
          ctx.requestRender();
        },
      });
    },

    editOverallComment(): void {
      const scope = ctx.getScope();
      openCommentEditor({
        title: "Overall comment",
        contextLabel: `review mode: ${reviewModeDisplay(scope)}`,
        prefill: ctx.getOverallComment(scope),
        emptySubmitHint: "empty submit clears the overall comment",
        onSubmit: (value) => {
          ctx.setOverallComment(scope, value.trim());
          ctx.requestRender();
        },
      });
    },

    jumpToComment(comment: ReviewComment): void {
      const state = ctx.getScopeState(comment.scope);
      if (!state) return;
      ctx.setScope(comment.scope);
      const fileIndex = state.bundle.files.findIndex((file) => file.fileKey === comment.fileKey);
      if (fileIndex < 0) return;
      ctx.setSelectedFileIndex(fileIndex);
      ctx.resetSyntaxHighlightCache();
      const file = state.bundle.files[fileIndex];
      const rowIndex = mapCommentToRow(file, comment);
      if (rowIndex != null) ctx.setCursorToRow(rowIndex);
      ctx.setFocusMode("diff");
      ctx.setPendingRangeSelection(null);
      ctx.requestRender();
    },

    openCommentsOverlay(initialComments?: ReviewComment[], title = "comments", locationLabel?: string): void {
      if (hasActiveOverlay()) return;
      let showAllScopes = !initialComments;
      let index = 0;
      let scroll = 0;
      let localComments = initialComments ? [...initialComments] : null;

      const getComments = () => localComments ?? ctx.visibleComments(showAllScopes);
      const overlay = new SimpleOverlay({
        onClose: closeOverlay,
        handleInput: (data) => {
          const comments = getComments();
          if (!initialComments && matchesKey(data, "t")) {
            showAllScopes = !showAllScopes;
            index = 0;
            scroll = 0;
            ctx.requestRender();
            return;
          }
          if (!comments.length) return;
          if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
            index = Math.min(comments.length - 1, index + 1);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
            index = Math.max(0, index - 1);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const selected = comments[index];
            closeOverlay(false);
            workflows.jumpToComment(selected);
            return;
          }
          if (matchesKey(data, "d")) {
            const selected = comments[index];
            if (!selected) return;
            ctx.setComments(removeCommentById(ctx.getComments(), selected.id));
            if (localComments) localComments = localComments.filter((comment) => comment.id !== selected.id);
            index = Math.max(0, Math.min(index, comments.length - 2));
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "e")) {
            const selected = comments[index];
            if (!selected) return;
            closeOverlay(false);
            workflows.openEditCommentOverlay(selected);
          }
        },
        render: (width) => {
          const comments = getComments();
          if (initialComments) {
            return renderPeekCommentsOverlay({
              theme: ctx.theme,
              width,
              locationLabel: locationLabel ?? title,
              comments,
              index,
            });
          }
          const rendered = renderCommentsOverlay({
            theme: ctx.theme,
            width,
            terminalRows: ctx.tui.terminal.rows,
            scope: ctx.getScope(),
            showAllScopes,
            comments,
            index,
            scroll,
          });
          scroll = rendered.scroll;
          return rendered.lines;
        },
      });

      ctx.setActiveOverlayHandle(ctx.tui.showOverlay(overlay, { width: initialComments ? "55%" : "50%", maxHeight: "80%", anchor: "center" }));
    },

    openPeekCommentsOverlay(): void {
      const file = ctx.getCurrentFile();
      const row = ctx.getCurrentRow();
      if (!file || !row) return;
      const comments = commentsAtLocation({ comments: ctx.getComments(), file, row, scope: ctx.getScope() });
      const line = row.kind === "removed" ? row.oldLine : row.newLine;
      const side = row.kind === "removed" ? "a" : "b";
      const locationLabel = `${file.displayPath}:${side}${line ?? "?"}`;
      workflows.openCommentsOverlay(comments, "comments at cursor", locationLabel);
    },

    openStaleResolver(onResolved: () => void): void {
      if (hasActiveOverlay()) return;
      let staleIndex = 0;

      const overlay = new SimpleOverlay({
        onClose: closeOverlay,
        handleInput: (data) => {
          const stale = ctx.unresolvedComments();
          if (!stale.length) {
            closeOverlay();
            onResolved();
            return;
          }
          const current = stale[Math.max(0, Math.min(stale.length - 1, staleIndex))];
          const key = printableChar(data);
          if (key && /^[1-9]$/.test(key)) {
            const nextComments = applyCandidateRemap({ comments: ctx.getComments(), comment: current, candidateIndex: Number.parseInt(key, 10) - 1 });
            if (nextComments) ctx.setComments(nextComments);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "a")) {
            const file = ctx.getCurrentFile();
            const row = ctx.getCurrentRow();
            const nextComments = file && row ? resolveCommentAtCursor({ comments: ctx.getComments(), comment: current, file, row, downgrade: "line" }) : null;
            if (nextComments) ctx.setComments(nextComments);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "h")) {
            const file = ctx.getCurrentFile();
            const row = ctx.getCurrentRow();
            const selection = ctx.currentRangeSelection() ?? (file && row ? autoChunkSelection(file, row.rowIndex) : null);
            const nextComments = file && row ? resolveCommentAtCursor({ comments: ctx.getComments(), comment: current, file, row, downgrade: "range", selection }) : null;
            if (nextComments) ctx.setComments(nextComments);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "f")) {
            const file = ctx.getCurrentFile();
            const row = ctx.getCurrentRow();
            const nextComments = file && row ? resolveCommentAtCursor({ comments: ctx.getComments(), comment: current, file, row, downgrade: "file" }) : null;
            if (nextComments) ctx.setComments(nextComments);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "d")) {
            ctx.setComments(removeCommentById(ctx.getComments(), current.id));
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
            staleIndex = Math.min(stale.length - 1, staleIndex + 1);
            ctx.requestRender();
            return;
          }
          if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
            staleIndex = Math.max(0, staleIndex - 1);
            ctx.requestRender();
          }
        },
        render: (width) => {
          const stale = ctx.unresolvedComments();
          const current = stale[Math.max(0, Math.min(stale.length - 1, staleIndex))] ?? null;
          return renderStaleResolverOverlay({ theme: ctx.theme, width, current, staleIndex, staleCount: stale.length });
        },
      });

      ctx.setActiveOverlayHandle(ctx.tui.showOverlay(overlay, { width: "95%", maxHeight: "95%", anchor: "center" }));
    },

    async openEditor(lineTargeted: boolean): Promise<void> {
      try {
        const file = ctx.getCurrentFile();
        if (!file) return;
        const repoRoot = file.resolvedRepoRoot ?? ctx.repoRoot;
        const relativePath = file.resolvedEditablePath ?? file.editablePath;
        if (!relativePath) {
          ctx.callbacks.notify("Deleted files cannot be opened for editing.", "info");
          return;
        }

        const line = editorLineForRow(ctx.getCurrentRow(), lineTargeted);

        if (ctx.backendKind === "ssh") {
          const identity = ctx.getRepoIdentity();
          if (!identity.ssh) {
            ctx.callbacks.notify("SSH edit mode is unavailable because the active SSH session identity is missing.", "error");
            return;
          }
          const result = await editRemoteFileViaLocalStage({
            tui: ctx.tui,
            ssh: identity.ssh,
            sessionId: ctx.sessionId,
            repoRelPath: relativePath,
            line,
            lineTargeted,
          });
          if (result.status != null && result.status !== 0) {
            ctx.callbacks.notify(`Editor exited with status ${result.status}.`, "info");
          }
          if (result.conflict) {
            ctx.callbacks.notify(
              `Remote file changed while you were editing. Kept your staged copy at ${result.stagePath}. Reload diff-review and reconcile manually.`,
              "warning",
            );
            await ctx.reloadCurrentScope();
            return;
          }
          if (result.uploaded) {
            ctx.callbacks.notify("Uploaded the staged edit back to the remote checkout.", "info");
          }
          await ctx.reloadCurrentScope();
          return;
        }

        const result = openExternalEditor({
          tui: ctx.tui,
          repoRoot,
          relativePath,
          line,
          lineTargeted,
        });

        if (result.status != null && result.status !== 0) {
          ctx.callbacks.notify(`Editor exited with status ${result.status}.`, "info");
        }

        await ctx.reloadCurrentScope();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stageSuffix = error instanceof SshStagedEditorError && error.stagePath
          ? ` Staged copy: ${error.stagePath}`
          : "";
        ctx.callbacks.notify(`Could not complete the editor workflow: ${message}${stageSuffix}`, "error");
      }
    },

    async submit(): Promise<void> {
      const submitMode = ctx.getScope();
      const stale = ctx.unresolvedComments();
      if (stale.length) {
        workflows.openStaleResolver(() => {
          void workflows.submit();
        });
        return;
      }

      const submitState = ctx.getCurrentState();
      const applyResult = await ctx.applyRejectedHunksBeforeSubmit(submitMode, submitState);
      if (!applyResult.ok) return;

      const state = applyResult.saveState;
      const saveMode = applyResult.saveMode;
      const saved = saveScopedReview({
        repoRoot: ctx.repoRoot,
        scopeKey: ctx.scopeKey,
        allowRepoRoot: ctx.allowRepoRootWrites,
        sessionId: ctx.sessionId,
        state,
        scope: saveMode,
        overallComment: ctx.getOverallComment(saveMode),
        comments: ctx.getComments(),
        changes: ctx.changeSummary(state),
      });

      ctx.setComments(saved.allComments);
      const generatedPrompt = shouldGenerateCompactPrompt({
        overallComment: ctx.getOverallComment(saveMode),
        scopedComments: saved.scopedComments,
      });
      if (generatedPrompt) ctx.callbacks.setEditorText(saved.saved.compactPrompt);
      const notice = savedReviewMessage(saved.saved, applyResult.postSubmitSections, { generatedPrompt });
      ctx.callbacks.notify(notice.message, notice.type);
      ctx.finish({ submitted: true, outputPath: saved.saved.outputPath });
    },

    toggleRangeSelection(): void {
      const file = ctx.getCurrentFile();
      const row = ctx.getCurrentRow();
      if (!file || !row) return;
      const disabledReason = commentDisabledReason(file);
      if (disabledReason) {
        ctx.callbacks.notify(disabledReason, "info");
        return;
      }
      if (row.kind === "meta" && !row.hunkId) {
        return;
      }

      const current = ctx.currentRangeSelection();
      if (!current) {
        const side = row.kind === "removed" ? "old" : "new";
        const selection: RangeSelection = {
          fileKey: file.fileKey,
          displayPath: file.displayPath,
          side,
          startRowIndex: row.rowIndex,
          endRowIndex: row.rowIndex,
          startLine: side === "old" ? row.oldLine ?? null : row.newLine ?? null,
          endLine: side === "old" ? row.oldLine ?? null : row.newLine ?? null,
        };
        ctx.setPendingRangeSelection(selection);
        ctx.callbacks.notify(`Range start set at ${describeRangeSelection(selection) ?? file.displayPath}. Press x again to finish and comment.`, "info");
        ctx.requestRender();
        return;
      }

      const completed: RangeSelection = {
        ...current,
        endRowIndex: row.rowIndex,
        endLine: current.side === "old" ? row.oldLine ?? current.endLine : row.newLine ?? current.endLine,
      };
      ctx.setPendingRangeSelection(completed);
      workflows.createCommentFlow("range", completed);
    },

    openAutoRangeComment(): void {
      ctx.setPendingRangeSelection(null);
      workflows.createCommentFlow("range");
    },

    jumpAdjacentComment(direction: 1 | -1, fileOnly: boolean): void {
      const comments = ctx.scopedNavigationComments(fileOnly);
      if (!comments.length) {
        ctx.callbacks.notify(fileOnly ? "No comments in this file." : "No comments in this scope.", "info");
        return;
      }

      const file = ctx.getCurrentFile();
      const row = ctx.getCurrentRow();
      const currentPath = file ? (file.editablePath ?? file.newPath ?? file.oldPath ?? file.displayPath) : "";
      const currentLine = row ? (row.newLine ?? row.oldLine ?? 0) : 0;
      const commentSortPath = (comment: ReviewComment) => comment.editablePath ?? comment.newPath ?? comment.oldPath ?? comment.displayPath;
      const commentSortLine = (comment: ReviewComment) => comment.anchor.applyStartLine ?? comment.anchor.applyLine ?? comment.anchor.startLine ?? comment.anchor.line ?? Number.MAX_SAFE_INTEGER;
      const ahead = comments.filter((comment) => {
        const path = commentSortPath(comment);
        const line = commentSortLine(comment);
        return direction === 1
          ? path > currentPath || (path === currentPath && line > currentLine)
          : path < currentPath || (path === currentPath && line < currentLine);
      });

      const target = direction === 1
        ? (ahead[0] ?? comments[0])
        : (ahead[ahead.length - 1] ?? comments[comments.length - 1]);
      workflows.jumpToComment(target);
    },

    jumpCommentFile(staleOnly: boolean): void {
      const files = ctx.getCurrentFiles();
      const targetIndex = nextFileIndexMatching({
        files,
        selectedFileIndex: ctx.getSelectedFileIndex(),
        predicate: (fileKey) => staleOnly ? ctx.fileHasStale(fileKey) : ctx.fileCommentCount(fileKey) > 0,
      });
      if (targetIndex == null) {
        ctx.callbacks.notify(staleOnly ? "No files with stale comments in this scope." : "No files with comments in this scope.", "info");
        return;
      }
      ctx.setSelectedFileIndex(targetIndex);
      ctx.resetSyntaxHighlightCache();
      const file = files[targetIndex];
      const firstComment = ctx.scopedNavigationComments(true).find((comment) => comment.fileKey === file.fileKey) ?? null;
      if (firstComment) {
        const rowIndex = mapCommentToRow(file, firstComment);
        if (rowIndex != null) ctx.setCursorToRow(rowIndex);
      } else {
        ctx.setCursorToRow(0);
      }
      ctx.setFocusMode("diff");
      ctx.requestRender();
    },
  };

  return workflows;
}
