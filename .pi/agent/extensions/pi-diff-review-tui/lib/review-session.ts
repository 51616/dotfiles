import { renumberComments } from "./comments.ts";
import { saveReviewToFile } from "./persist.ts";
import type { ChangeSummary, DiffScope, ParsedDiffRow, ReviewComment, SavedReviewResult, ScopeState } from "./types.ts";

export function editorLineForRow(row: ParsedDiffRow | null, lineTargeted: boolean): number | null | undefined {
  if (!lineTargeted || !row) return undefined;
  return row.newLine ?? row.oldLine ?? null;
}

export function commentsForSubmission(comments: ReviewComment[], scope: DiffScope): { allComments: ReviewComment[]; scopedComments: ReviewComment[] } {
  const allComments = renumberComments(comments);
  const scopedComments = allComments.filter((comment) => comment.scope === scope).sort((a, b) => a.ordinal - b.ordinal);
  return { allComments, scopedComments };
}

export function saveScopedReview({
  repoRoot,
  state,
  scope,
  overallComment,
  comments,
  changes,
}: {
  repoRoot: string;
  state: ScopeState;
  scope: DiffScope;
  overallComment: string;
  comments: ReviewComment[];
  changes: { sinceStart: ChangeSummary; sinceLastReload: ChangeSummary };
}): { allComments: ReviewComment[]; scopedComments: ReviewComment[]; saved: SavedReviewResult } {
  const prepared = commentsForSubmission(comments, scope);
  const saved = saveReviewToFile({
    repoRoot,
    headAtStart: state.startHead,
    scope,
    sourceKind: state.bundle.sourceKind,
    sourceLabel: state.bundle.sourceLabel,
    turnMetadata: state.bundle.turnMetadata,
    overallComment,
    comments: prepared.scopedComments,
    changesSinceStart: changes.sinceStart,
    changesSinceLastReload: changes.sinceLastReload,
  });
  return { ...prepared, saved };
}

export function savedReviewMessage(saved: SavedReviewResult): { message: string; type: "info" | "warning" } {
  if (saved.outputLocation === "home") {
    return {
      message: `Saved review to home fallback path ${saved.outputPath} (/tmp was not writable).`,
      type: "warning",
    };
  }
  if (saved.outputLocation === "repo") {
    return {
      message: `Saved review to repo fallback path ${saved.outputPath} (/tmp and ~/.pi/diff-review were not writable).`,
      type: "warning",
    };
  }
  return { message: `Saved review to ${saved.outputPath}`, type: "info" };
}
