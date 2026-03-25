import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@mariozechner/pi-tui";

export type DiffScope = "t" | "u" | "s" | "a";
export type FileStatus = "M" | "A" | "D" | "R" | "B";
export type CommentStatus = "ok" | "moved" | "stale_unresolved";
export type CommentSide = "old" | "new" | "file";
export type CommentKind = "line" | "range" | "file";
export type CommentRangeOrigin = "auto_chunk" | "user_range";
export type FocusMode = "files" | "diff";
export type ParsedRowKind = "meta" | "hunk_header" | "context" | "removed" | "added" | "no_newline";

export interface ParsedDiffRow {
  kind: ParsedRowKind;
  text: string;
  rawText: string;
  oldLine?: number;
  newLine?: number;
  hunkId?: string;
  fileKey: string;
  rowIndex: number;
}

export interface ParsedHunk {
  id: string;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rowStart: number;
  rowEnd: number;
}

export interface ParsedFilePatch {
  fileKey: string;
  status: FileStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  editablePath: string | null;
  rawPatch: string;
  rows: ParsedDiffRow[];
  hunks: ParsedHunk[];
  isBinary: boolean;
}

export interface TurnSourceRepoSummary {
  repo_key: string;
  repo_root: string;
  touched_paths: string[];
  omitted_paths?: Record<string, { reason: string; size_bytes?: number }>;
}

export interface TurnSourceMetadata {
  saved_at: string;
  session_id: string;
  turn_id: string;
  source: "last_turn_agent_touched";
  review_source: "last turn (agent-touched)";
  repo_root: string;
  repo_key: string;
  touched_paths: string[];
  has_bash_calls: boolean;
  note?: string;
  omitted_paths?: Record<string, { reason: string; size_bytes?: number }>;
  workspace?: boolean;
  repos?: TurnSourceRepoSummary[];
}

export interface DiffBundle {
  scope: DiffScope;
  repoRoot: string;
  head: string | null;
  files: ParsedFilePatch[];
  patchText: string;
  fingerprint: string;
  fileHashes: Map<string, string>;
  loadedAt: string;
  sourceKind?: "git" | "turn";
  sourceLabel?: string;
  turnMetadata?: TurnSourceMetadata | null;
}

export interface CandidateRemap {
  kind: "candidate";
  fileKey: string;
  displayPath: string;
  side: CommentSide;
  line: number | null;
  startLine: number | null;
  endLine: number | null;
  hunkId: string | null;
  rowIndex: number;
  preview: string;
  matchScore: number;
}

export interface CommentAnchor {
  kind: CommentKind;
  origin: CommentRangeOrigin | null;
  side: CommentSide;
  line: number | null;
  startLine: number | null;
  endLine: number | null;
  applyLine: number | null;
  applyStartLine: number | null;
  applyEndLine: number | null;
  hunkId: string | null;
  hunkHeader: string | null;
  targetText: string;
  contextBefore: string[];
  contextAfter: string[];
  normalizedTargetHash: string;
  searchText: string;
}

export interface ReviewComment {
  id: string;
  ordinal: number;
  fileKey: string;
  fileStatus: FileStatus;
  oldPath: string | null;
  newPath: string | null;
  editablePath: string | null;
  displayPath: string;
  scope: DiffScope;
  /**
   * Immutable: the anchor as created by the reviewer.
   * This is never modified by auto-remap or stale-resolution flows.
   */
  originalAnchor: CommentAnchor;
  /**
   * Mutable: the current anchor used for navigation/rendering/output.
   * May be updated by auto-remap and stale-resolution.
   */
  anchor: CommentAnchor;
  body: string;
  compactSnippet: string;
  fullHunkText: string;
  status: CommentStatus;
  remapNotes: string[];
  candidateRemaps: CandidateRemap[];
}

export interface ScopeViewState {
  selectedPath: string | null;
  selectedFileIndex: number;
  diffCursorRow: number;
  diffCursorSide: Exclude<CommentSide, "file"> | null;
  diffCursorKind: ParsedRowKind | null;
  diffCursorLine: number | null;
  diffScroll: number;
  fileScroll: number;
}

export interface ScopeState {
  scope: DiffScope;
  bundle: DiffBundle;
  startHead: string | null;
  startFingerprint: string;
  startFileHashes: Map<string, string>;
  lastReloadFingerprint: string;
  previousFileHashes: Map<string, string>;
  loadedAt: string;
  lastReloadAt: string;
  view: ScopeViewState;
}

export interface ChangeSummary {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
}

export type ReviewOutputLocation = "tmp" | "home" | "repo";

export interface SavedReviewResult {
  outputPath: string;
  content: string;
  compactPrompt: string;
  outputLocation: ReviewOutputLocation;
}

export interface RenderCommentMarker {
  marker: string;
  stale: boolean;
}

export interface InlineEmphasisRange {
  start: number;
  end: number;
}

export interface DiffRowRenderCache {
  scope: DiffScope;
  fingerprint: string;
  fileKey: string;
  width: number;
  lineNumberWidth: number;
  commentsEpoch: number;
  highlightKey: string;
  /**
   * Cached wrapped content lines (content area only, padded to content width).
   * Used to cheaply compute row heights for scroll calculations.
   */
  contentRows: Map<number, string[]>;
  baseRows: Map<number, string[]>;
  selectedRows: Map<number, string[]>;
  inlineEmphasisRows: Map<number, InlineEmphasisRange[]>;
  inlineEmphasisReady: boolean;
  emptyLine: string;
}

export interface DiffViewportCache {
  scope: DiffScope;
  fingerprint: string;
  fileKey: string;
  width: number;
  lineNumberWidth: number;
  height: number;
  scroll: number;
  commentsEpoch: number;
  highlightKey: string;
  selectedRow: number;
  lines: string[];
}

export interface DiffRenderViewport {
  width: number;
  height: number;
  cursorRow: number;
  scrollOffset: number;
}

export interface DiffRenderRow {
  rowIndex: number;
  line: string;
}

export interface RangeSelection {
  fileKey: string;
  displayPath: string;
  side: Exclude<CommentSide, "file">;
  startRowIndex: number;
  endRowIndex: number;
  startLine: number | null;
  endLine: number | null;
}

export interface AppCallbacks {
  done: (result: { submitted: boolean; outputPath?: string }) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setEditorText: (text: string) => void;
}

export interface OverlayComponent extends Component {
  focused?: boolean;
  dispose?(): void;
}

export interface OverlayFactoryContext {
  tui: TUI;
  theme: Theme;
  onClose: () => void;
  handle?: OverlayHandle;
}
