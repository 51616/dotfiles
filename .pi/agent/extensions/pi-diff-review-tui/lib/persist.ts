import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangeSummary, DiffScope, FileStatus, ReviewComment, ReviewOutputLocation, SavedReviewResult, TurnSourceMetadata } from "./types.ts";
import { anchorLocationEqual, compareCommentsByLocation } from "./comments.ts";
import { scopeDisplay, scopeName } from "./scope.ts";
import { resolveAgentDir, resolveDiffReviewRootForWrite } from "./diff-review-paths.ts";

function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function summarizeChangesBlock(label: string, summary: ChangeSummary): string[] {
  const lines = [`## ${label}`];
  if (!summary.changed.length && !summary.added.length && !summary.removed.length) {
    lines.push("- no changes detected");
    return lines;
  }
  if (summary.changed.length) lines.push(`- changed: ${summary.changed.join(", ")}`);
  if (summary.added.length) lines.push(`- added: ${summary.added.join(", ")}`);
  if (summary.removed.length) lines.push(`- removed: ${summary.removed.join(", ")}`);
  return lines;
}

function tryEnsureWritableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

function normalizeSessionId(sessionId: string | undefined): string {
  const trimmed = String(sessionId ?? "").trim();
  return trimmed || "no-session";
}

export function resolveReviewOutputDir({
  repoRoot,
  sessionId,
  tmpRoot = os.tmpdir(),
  agentDir = resolveAgentDir(),
}: {
  repoRoot: string;
  sessionId?: string;
  tmpRoot?: string;
  agentDir?: string;
}): { dir: string; outputLocation: ReviewOutputLocation } {
  const { rootDir, outputLocation } = resolveDiffReviewRootForWrite({ repoRoot, tmpRoot, agentDir });
  const sessionKey = normalizeSessionId(sessionId);
  const dir = tryEnsureWritableDir(path.join(rootDir, "reviews", "sessions", sessionKey));
  if (!dir) {
    throw new Error(`Unable to create a writable diff-review reviews directory under ${rootDir}.`);
  }
  return { dir, outputLocation };
}

function fileStatusName(status: FileStatus): "modified" | "added" | "deleted" | "renamed" | "modified" {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  return "modified";
}

function sidePrefix(side: ReviewComment["anchor"]["side"]): "a" | "b" | "file" {
  if (side === "old") return "a";
  if (side === "new") return "b";
  return "file";
}

function formatLineRef(side: "a" | "b", start: number | null, end: number | null): string | null {
  if (start == null) return null;
  if (end != null && end !== start) return `${side}:L${start}-L${end}`;
  return `${side}:L${start}`;
}

function outputEditPath(comment: ReviewComment): string | null {
  const path = comment.editablePath ?? comment.newPath;
  return path ? `b/${path}` : null;
}

function outputApplyToAnchor(anchor: ReviewComment["anchor"]): string | null {
  return formatLineRef(
    "b",
    anchor.applyStartLine ?? anchor.applyLine,
    anchor.applyEndLine ?? anchor.applyStartLine ?? anchor.applyLine,
  );
}

function outputApplyTo(comment: ReviewComment): string | null {
  return outputApplyToAnchor(comment.anchor);
}

function outputOriginalApplyTo(comment: ReviewComment): string | null {
  const original = (comment as unknown as { originalAnchor?: ReviewComment["anchor"] }).originalAnchor ?? comment.anchor;
  return outputApplyToAnchor(original);
}

function outputAnchorFrom(anchor: ReviewComment["anchor"]): string {
  if (anchor.kind === "file" || anchor.side === "file") return "file";
  const prefix = sidePrefix(anchor.side);
  const start = anchor.startLine ?? anchor.line;
  const end = anchor.endLine ?? anchor.startLine ?? anchor.line;
  const base = formatLineRef(prefix, start, end) ?? `${prefix}:(unknown)`;
  return anchor.side === "old" ? `${base} (removed)` : base;
}

function outputAnchor(comment: ReviewComment): string {
  return outputAnchorFrom(comment.anchor);
}

function outputOriginalAnchor(comment: ReviewComment): string {
  const original = (comment as unknown as { originalAnchor?: ReviewComment["anchor"] }).originalAnchor ?? comment.anchor;
  return outputAnchorFrom(original);
}

function outputPaths(comment: ReviewComment): string {
  return `a=${comment.oldPath ?? "null"}, b=${comment.newPath ?? "null"}`;
}

function compactLegend(): string {
  return "Legend: a/ = pre-change context, b/ = current code; make edits in b/.";
}

function sourceSummaryLines({
  sourceKind,
  sourceLabel,
  turnMetadata,
}: {
  sourceKind?: "git" | "turn";
  sourceLabel?: string;
  turnMetadata?: TurnSourceMetadata | null;
}): string[] {
  if (sourceKind !== "turn") return [];
  const lines = [`- review_source: ${sourceLabel ?? turnMetadata?.review_source ?? "last turn (agent-touched)"}`];
  if (turnMetadata) {
    lines.push(`- source_session_id: ${turnMetadata.session_id}`);
    lines.push(`- source_turn_id: ${turnMetadata.turn_id}`);
    lines.push(`- touched_paths: ${turnMetadata.touched_paths.length ? turnMetadata.touched_paths.join(", ") : "(none)"}`);
    if (turnMetadata.workspace && turnMetadata.repos?.length) {
      lines.push(`- repos: ${turnMetadata.repos.map((repo) => repo.repo_key).join(", ")}`);
    }
    if (turnMetadata.note) lines.push(`- source_note: ${turnMetadata.note}`);
  }
  return lines;
}

function outputComments(comments: ReviewComment[]): ReviewComment[] {
  return comments
    .slice()
    .sort(compareCommentsByLocation)
    .map((comment, index) => ({ ...comment, ordinal: index + 1 }));
}

export function buildSavedReviewMarkdown({
  repoRoot,
  headAtStart,
  scope,
  outputPath,
  savedAt,
  sourceKind,
  sourceLabel,
  turnMetadata,
  overallComment,
  comments,
  changesSinceStart,
  changesSinceLastReload,
}: {
  repoRoot: string;
  sessionId?: string;
  headAtStart: string | null;
  scope: DiffScope;
  outputPath: string;
  savedAt: string;
  sourceKind?: "git" | "turn";
  sourceLabel?: string;
  turnMetadata?: TurnSourceMetadata | null;
  overallComment: string;
  comments: ReviewComment[];
  changesSinceStart: ChangeSummary;
  changesSinceLastReload: ChangeSummary;
}): string {
  const orderedComments = outputComments(comments);
  const lines: string[] = [];
  lines.push("# π Diff Review");
  lines.push("");
  lines.push(`- repo_root: ${repoRoot}`);
  lines.push(`- head_at_start: ${headAtStart ?? "(none)"}`);
  lines.push(`- scope: ${scopeName(scope)}`);
  lines.push(`- scope_key: ${scope}`);
  lines.push(`- saved_at: ${savedAt}`);
  lines.push(`- output_path: ${outputPath}`);
  lines.push(`- legend: ${compactLegend()}`);
  lines.push(...sourceSummaryLines({ sourceKind, sourceLabel, turnMetadata }));
  lines.push("");
  lines.push(...summarizeChangesBlock("Changes since review start", changesSinceStart));
  lines.push("");
  lines.push(...summarizeChangesBlock("Changes since last reload", changesSinceLastReload));
  lines.push("");
  lines.push("## Overall comment");
  lines.push("");
  lines.push(overallComment.trim() || "(none)");
  lines.push("");
  lines.push("## Comments");
  lines.push("");

  if (!orderedComments.length) {
    lines.push("(no comments)");
  }

  let currentEditPath = "";
  for (const comment of orderedComments) {
    const editPath = outputEditPath(comment) ?? "(no editable path)";
    if (editPath !== currentEditPath) {
      currentEditPath = editPath;
      lines.push(`### ${editPath}`);
      lines.push("");
    }

    lines.push(`#### ${comment.ordinal}. ${outputAnchor(comment)}`);
    lines.push("");
    lines.push(`- kind: ${comment.anchor.kind}`);
    if (comment.anchor.kind === "range") lines.push(`- origin: ${comment.anchor.origin ?? "user_range"}`);
    lines.push(`- file_status: ${fileStatusName(comment.fileStatus)}`);
    lines.push(`- paths: ${outputPaths(comment)}`);
    lines.push(`- edit_path: ${outputEditPath(comment) ?? "null"}`);
    if (comment.anchor.kind !== "file") lines.push(`- apply_to: ${outputApplyTo(comment) ?? "null"}`);
    lines.push(`- anchor: ${outputAnchor(comment)}`);

    const original = (comment as unknown as { originalAnchor?: ReviewComment["anchor"] }).originalAnchor ?? comment.anchor;
    const showOriginal = comment.status !== "ok" && !anchorLocationEqual(original, comment.anchor);
    if (showOriginal) {
      lines.push(`- original_anchor: ${outputAnchorFrom(original)}`);
      if (original.kind !== "file") lines.push(`- original_apply_to: ${outputApplyToAnchor(original) ?? "null"}`);
    }

    lines.push(`- scope: ${scopeDisplay(comment.scope)}`);
    lines.push(`- status: ${comment.status}`);
    if (comment.anchor.hunkHeader) lines.push(`- hunk_header: ${comment.anchor.hunkHeader}`);
    if (comment.anchor.searchText) lines.push(`- search: ${comment.anchor.searchText}`);
    if (comment.anchor.side === "old") {
      lines.push("- anchor_note: apply changes in post-change code; removed snippet is context.");
    }
    if (comment.remapNotes.length) {
      lines.push(`- remap_notes: ${comment.remapNotes.join(" | ")}`);
    }
    lines.push("");
    lines.push(comment.body.trim() || "(empty)");
    lines.push("");
    lines.push("```diff");
    lines.push(comment.compactSnippet || comment.fullHunkText || "(no snippet)");
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function buildCompactPrompt({
  outputPath,
  scope,
  headAtStart,
  sourceKind,
  sourceLabel,
  turnMetadata,
  overallComment,
  comments,
  changesSinceStart,
  changesSinceLastReload,
}: {
  outputPath: string;
  scope: DiffScope;
  headAtStart: string | null;
  sourceKind?: "git" | "turn";
  sourceLabel?: string;
  turnMetadata?: TurnSourceMetadata | null;
  overallComment: string;
  comments: ReviewComment[];
  changesSinceStart: ChangeSummary;
  changesSinceLastReload: ChangeSummary;
}): string {
  const orderedComments = outputComments(comments);
  const lines: string[] = [];
  lines.push("Please address the following diff review feedback.");
  lines.push("");
  lines.push(`Saved full review: ${outputPath}`);
  lines.push(`Reviewed scope: ${scopeDisplay(scope)}`);
  lines.push(`HEAD at review start: ${headAtStart ?? "(none)"}`);
  lines.push(compactLegend());
  if (sourceKind === "turn") {
    lines.push(`Review source: ${sourceLabel ?? turnMetadata?.review_source ?? "last turn (agent-touched)"}`);
    if (turnMetadata) {
      lines.push(`Touched paths: ${turnMetadata.touched_paths.length ? turnMetadata.touched_paths.join(", ") : "(none)"}`);
      if (turnMetadata.workspace && turnMetadata.repos?.length) {
        lines.push(`Repos: ${turnMetadata.repos.map((repo) => repo.repo_key).join(", ")}`);
      }
      if (turnMetadata.note) lines.push(`Source note: ${turnMetadata.note}`);
    }
  }
  if (changesSinceStart.changed.length || changesSinceStart.added.length || changesSinceStart.removed.length) {
    lines.push(`Changes during review (since start): changed=${changesSinceStart.changed.join(", ") || "none"}; added=${changesSinceStart.added.join(", ") || "none"}; removed=${changesSinceStart.removed.join(", ") || "none"}`);
  } else {
    lines.push("Changes during review (since start): none");
  }
  if (changesSinceLastReload.changed.length || changesSinceLastReload.added.length || changesSinceLastReload.removed.length) {
    lines.push(`Changes since last reload: changed=${changesSinceLastReload.changed.join(", ") || "none"}; added=${changesSinceLastReload.added.join(", ") || "none"}; removed=${changesSinceLastReload.removed.join(", ") || "none"}`);
  } else {
    lines.push("Changes since last reload: none");
  }
  lines.push("");
  if (overallComment.trim()) {
    lines.push("Overall:");
    lines.push(overallComment.trim());
    lines.push("");
  }
  if (!orderedComments.length) {
    lines.push("No location-specific comments were recorded.");
    lines.push("");
  } else {
    for (const comment of orderedComments) {
      const applyTo = outputApplyTo(comment);
      const editPath = outputEditPath(comment) ?? "(no editable path)";
      const anchor = outputAnchor(comment);
      const body = comment.body.trim() || "(empty)";

      const original = (comment as unknown as { originalAnchor?: ReviewComment["anchor"] }).originalAnchor ?? comment.anchor;
      const originalSuffix = comment.status === "moved" && !anchorLocationEqual(original, comment.anchor)
        ? ` (original ${outputOriginalAnchor(comment)})`
        : "";

      lines.push(`${comment.ordinal}. ${editPath}${applyTo ? ` @ ${applyTo}` : ""}${anchor ? ` (anchor ${anchor})` : ""}${originalSuffix}`);
      lines.push(`   ${body}`);
      lines.push("");
    }
  }
  lines.push("Read the saved review file for full snippets, search handles, and exact context before editing.");
  return lines.join("\n").trim();
}

export function saveReviewToFile({
  repoRoot,
  sessionId,
  headAtStart,
  scope,
  sourceKind,
  sourceLabel,
  turnMetadata,
  overallComment,
  comments,
  changesSinceStart,
  changesSinceLastReload,
}: {
  repoRoot: string;
  sessionId?: string;
  headAtStart: string | null;
  scope: DiffScope;
  sourceKind?: "git" | "turn";
  sourceLabel?: string;
  turnMetadata?: TurnSourceMetadata | null;
  overallComment: string;
  comments: ReviewComment[];
  changesSinceStart: ChangeSummary;
  changesSinceLastReload: ChangeSummary;
}): SavedReviewResult {
  const { dir, outputLocation } = resolveReviewOutputDir({ repoRoot, sessionId });
  const filename = `${safeTimestamp()}_${scope}.md`;
  const outputPath = path.join(dir, filename);
  const savedAt = new Date().toISOString();
  const content = buildSavedReviewMarkdown({
    repoRoot,
    headAtStart,
    scope,
    outputPath,
    savedAt,
    sourceKind,
    sourceLabel,
    turnMetadata,
    overallComment,
    comments,
    changesSinceStart,
    changesSinceLastReload,
  });
  fs.writeFileSync(outputPath, content, "utf8");

  return {
    outputPath,
    content,
    compactPrompt: buildCompactPrompt({
      outputPath,
      scope,
      headAtStart,
      sourceKind,
      sourceLabel,
      turnMetadata,
      overallComment,
      comments,
      changesSinceStart,
      changesSinceLastReload,
    }),
    outputLocation,
  };
}
