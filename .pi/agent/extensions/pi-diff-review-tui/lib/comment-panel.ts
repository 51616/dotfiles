import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { formatCommentLocation, formatOriginalCommentLocation, summarizeCommentStatus } from "./comments.ts";
import { scopeDisplay } from "./scope.ts";
import type { CommentStatus, DiffScope, FileStatus, ParsedFilePatch, ReviewComment } from "./types.ts";
import { padLine, statusColor } from "./ui-helpers.ts";

type CommentPanelView =
  | {
    kind: "session";
    scope: DiffScope;
    comments: ReviewComment[];
    overallComments: Record<DiffScope, string>;
  }
  | {
    kind: "file";
    scope: DiffScope;
    file: ParsedFilePatch | null;
    comments: ReviewComment[];
  }
  | {
    kind: "preview";
    scope: DiffScope;
    comments: ReviewComment[];
  };

type CountSummary = {
  total: number;
  byKind: Record<"line" | "range" | "file", number>;
  byStatus: Record<CommentStatus, number>;
  byScope: Record<DiffScope, number>;
};

function countComments(comments: ReviewComment[]): CountSummary {
  return comments.reduce<CountSummary>((summary, comment) => {
    summary.total += 1;
    summary.byKind[comment.anchor.kind] += 1;
    summary.byStatus[comment.status] += 1;
    summary.byScope[comment.scope] += 1;
    return summary;
  }, {
    total: 0,
    byKind: { line: 0, range: 0, file: 0 },
    byStatus: { ok: 0, moved: 0, stale_unresolved: 0 },
    byScope: { u: 0, s: 0, a: 0 },
  });
}

function fileStatusLabel(status: FileStatus): string {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "B") return "binary";
  return "modified";
}

function fillBody(lines: string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, Math.max(0, height)).map((line) => padLine(line, width));
  while (fitted.length < height) fitted.push(" ".repeat(width));
  return fitted;
}

function wrapBodyText(text: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const normalized = text.trim() || "(empty)";
  const chunks = normalized.replace(/\t/g, "  ").split(/\r?\n/);
  const out: string[] = [];

  outer: for (let index = 0; index < chunks.length; index += 1) {
    const wrapped = wrapTextWithAnsi(chunks[index] ?? "", Math.max(1, width));
    for (const line of wrapped.length ? wrapped : [""]) {
      if (out.length >= maxLines) break outer;
      out.push(line);
    }
    if (index < chunks.length - 1) {
      if (out.length >= maxLines) break;
      out.push("");
    }
  }

  if (out.length === maxLines && chunks.join("\n").trim() !== out.join("\n").trim()) {
    out[out.length - 1] = truncateToWidth(`${out[out.length - 1]?.trimEnd() ?? ""} …`, Math.max(1, width), "…", true);
  }

  return out;
}

function statusLine(theme: Theme, status: CommentStatus): string {
  return statusColor(theme, summarizeCommentStatus(status), status);
}

function renderSessionView(theme: Theme, width: number, height: number, view: Extract<CommentPanelView, { kind: "session" }>): string[] {
  const counts = countComments(view.comments);
  const overallNotes = Object.values(view.overallComments).filter((value) => value.trim()).length;
  const lines = [
    theme.fg("muted", "session comments"),
    `${theme.fg("muted", "active")} ${scopeDisplay(view.scope)}`,
    `${theme.fg("accent", "total")} ${counts.total}   ${theme.fg(counts.byStatus.stale_unresolved ? "warning" : "muted", `stale ${counts.byStatus.stale_unresolved}`)}`,
    `${theme.fg("muted", "kinds")} l${counts.byKind.line} r${counts.byKind.range} f${counts.byKind.file}`,
    `${theme.fg("muted", "status")} ok${counts.byStatus.ok} mv${counts.byStatus.moved} st${counts.byStatus.stale_unresolved}`,
    `${theme.fg("muted", "scopes")} u${counts.byScope.u} i${counts.byScope.s} a${counts.byScope.a}`,
    `${theme.fg("muted", "overall notes")} ${overallNotes}`,
  ];

  if (!counts.total && !overallNotes) {
    lines.push(theme.fg("muted", "No comments in this review yet."));
  }

  return fillBody(lines, width, height);
}

function renderFileView(theme: Theme, width: number, height: number, view: Extract<CommentPanelView, { kind: "file" }>): string[] {
  if (!view.file) {
    return fillBody([
      theme.fg("muted", "file comments"),
      theme.fg("muted", "No file selected."),
    ], width, height);
  }

  const counts = countComments(view.comments);
  const lines = [
    theme.fg("muted", "file comments"),
    theme.bold(view.file.displayPath),
    `${theme.fg("muted", "scope")} ${scopeDisplay(view.scope)}   ${theme.fg("muted", "git")} ${fileStatusLabel(view.file.status)}`,
    `${theme.fg("accent", "total")} ${counts.total}   ${theme.fg(counts.byStatus.stale_unresolved ? "warning" : "muted", `stale ${counts.byStatus.stale_unresolved}`)}`,
    `${theme.fg("muted", "kinds")} l${counts.byKind.line} r${counts.byKind.range} f${counts.byKind.file}`,
    `${theme.fg("muted", "status")} ok${counts.byStatus.ok} mv${counts.byStatus.moved} st${counts.byStatus.stale_unresolved}`,
  ];

  if (!counts.total) {
    lines.push(theme.fg("muted", `No comments for this file in ${scopeDisplay(view.scope)}.`));
  }

  return fillBody(lines, width, height);
}

function renderPreviewView(theme: Theme, width: number, height: number, view: Extract<CommentPanelView, { kind: "preview" }>): string[] {
  const [selected, ...rest] = view.comments;
  if (!selected) {
    return fillBody([
      theme.fg("muted", "comment preview"),
      theme.fg("muted", "No comment at this cursor."),
    ], width, height);
  }

  const lines = [
    theme.fg("muted", "comment at cursor"),
    `${theme.fg("accent", `#${selected.ordinal}`)} ${statusLine(theme, selected.status)} ${theme.fg("muted", `· ${scopeDisplay(selected.scope)}`)}`,
    truncateToWidth(formatCommentLocation(selected), Math.max(1, width), "…", true),
  ];

  const originalLocation = formatOriginalCommentLocation(selected);
  if (originalLocation) {
    lines.push(`${theme.fg("muted", "original")} ${truncateToWidth(originalLocation, Math.max(1, width - 9), "…", true)}`);
  }

  const footerLines = rest.length ? 1 : 0;
  const bodyLines = Math.max(0, height - lines.length - footerLines);
  lines.push(...wrapBodyText(theme.fg("dim", selected.body), width, bodyLines));

  if (rest.length) {
    lines.push(theme.fg("dim", `+${rest.length} more here · v list`));
  }

  return fillBody(lines, width, height);
}

export function renderCommentPanel({
  theme,
  width,
  height,
  view,
}: {
  theme: Theme;
  width: number;
  height: number;
  view: CommentPanelView;
}): string[] {
  if (view.kind === "session") return renderSessionView(theme, width, height, view);
  if (view.kind === "file") return renderFileView(theme, width, height, view);
  return renderPreviewView(theme, width, height, view);
}
