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

export function shouldGenerateCompactPrompt({
  overallComment,
  scopedComments,
}: {
  overallComment: string;
  scopedComments: ReviewComment[];
}): boolean {
  return overallComment.trim().length > 0 || scopedComments.length > 0;
}

export function saveScopedReview({
  repoRoot,
  sessionId,
  state,
  scope,
  overallComment,
  comments,
  changes,
}: {
  repoRoot: string;
  sessionId?: string;
  state: ScopeState;
  scope: DiffScope;
  overallComment: string;
  comments: ReviewComment[];
  changes: { sinceStart: ChangeSummary; sinceLastReload: ChangeSummary };
}): { allComments: ReviewComment[]; scopedComments: ReviewComment[]; saved: SavedReviewResult } {
  const prepared = commentsForSubmission(comments, scope);
  const saved = saveReviewToFile({
    repoRoot,
    sessionId,
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

export function savedReviewMessage(
  saved: SavedReviewResult,
  appendedSections: string[] = [],
  options?: { generatedPrompt?: boolean },
): { message: string; type: "info" } {
  const base = saved.outputLocation === "home"
    ? {
        message: `Saved review to home session fallback path ${saved.outputPath} (/tmp was not writable).`,
        type: "info" as const,
      }
    : saved.outputLocation === "repo"
      ? {
          message: `Saved review to repo fallback path ${saved.outputPath} (/tmp and ~/.pi/agent/sessions were not writable).`,
          type: "info" as const,
        }
      : { message: `Saved review to ${saved.outputPath}`, type: "info" as const };

  const sections = [
    ...(options?.generatedPrompt === false ? ["No user message was generated because this review has no comments."] : []),
    ...appendedSections,
  ].filter((section) => section.trim().length > 0);
  if (!sections.length) return base;
  return {
    message: `${base.message}\n\n${sections.join("\n\n")}`,
    type: base.type,
  };
}
