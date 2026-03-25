import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { formatCommentLocation, formatOriginalCommentLocation, summarizeCommentStatus } from "./comments.ts";
import { formatScopeBadge } from "./comment-resolution.ts";
import { scopeDisplay } from "./scope.ts";
import type { CandidateRemap, DiffScope, ReviewComment } from "./types.ts";
import { bottomBorder, boxLine, statusColor, topBorder } from "./ui-helpers.ts";

function wrapPlainText({
  text,
  width,
  maxLines,
}: {
  text: string;
  width: number;
  maxLines: number;
}): { lines: string[]; truncated: boolean } {
  if (maxLines <= 0) return { lines: [], truncated: false };

  const chunks = text.replace(/\t/g, "  ").split(/\r?\n/);
  const out: string[] = [];
  let truncated = false;

  outer: for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? "";
    const wrapped = wrapTextWithAnsi(chunk, Math.max(1, width));
    const wrappedLines = wrapped.length ? wrapped : [""];

    for (const line of wrappedLines) {
      if (out.length >= maxLines) {
        truncated = true;
        break outer;
      }
      out.push(line);
    }

    if (index < chunks.length - 1) {
      if (out.length >= maxLines) {
        truncated = true;
        break;
      }
      out.push("");
    }
  }

  if (truncated && out.length) {
    const last = out[out.length - 1] ?? "";
    out[out.length - 1] = truncateToWidth(`${last.trimEnd()} …`, Math.max(1, width), "…", true);
  }

  return { lines: out, truncated };
}

function renderCommentBodyPreview(theme: Theme, comment: ReviewComment, inner: number, previewLines: number): string[] {
  if (previewLines <= 0) return [];
  const lines: string[] = [];
  const body = comment.body.trim() || "(empty)";
  const wrapped = wrapPlainText({ text: body, width: inner, maxLines: previewLines });
  const bodyLines = wrapped.lines.length ? wrapped.lines : ["(empty)"];
  for (let i = 0; i < Math.min(previewLines, bodyLines.length); i += 1) {
    lines.push(boxLine(theme, "│", theme.fg("dim", bodyLines[i] ?? ""), inner, "│", "accent"));
  }
  return lines;
}

export function renderHelpOverlay(theme: Theme, width: number): string[] {
  const lines = [
    theme.fg("muted", "navigation"),
    "j/k or ↑/↓ move line, [/] move hunk",
    "tab switch files/diff focus",
    "→ files→diff focus, ← diff→files focus",
    "enter files→focus diff, diff→line comment",
    "n/b next/prev comment in scope",
    ",/. next/prev comment in file",
    "w next file with comments, z next file with stale comments",
    "",
    theme.fg("muted", "review"),
    "t/u/i/a switch source or scope (last turn / unstaged / staged / all)",
    "c line comment, h auto-range comment, x start/finish user range",
    "f file comment, o overall comment, v peek comments at cursor",
    "m comments list, t toggle all scopes (inside comments)",
    "e edit at cursor, g edit file, r reload current scope",
    "",
    theme.fg("muted", "session"),
    "s submit review, q close, esc clears range selection before quitting",
    "p toggle perf stats",
    "",
    theme.fg("dim", "Submit saves the full review to /tmp first, then ~/.pi/diff-review or .pi/diff-review if needed, and inserts a compact prompt into pi's editor."),
  ];
  const inner = Math.max(30, width - 2);
  const out: string[] = [topBorder(theme, "help", inner, "accent")];
  for (const line of lines) out.push(boxLine(theme, "│", line, inner, "│"));
  out.push(bottomBorder(theme, inner, "accent"));
  return out;
}

export function computeOverlayScroll(index: number, scroll: number, visibleRows: number): number {
  if (index < scroll) return index;
  if (index >= scroll + visibleRows) return index - visibleRows + 1;
  return scroll;
}

export function renderCommentsOverlay({
  theme,
  width,
  terminalRows,
  scope,
  showAllScopes,
  comments,
  index,
  scroll,
}: {
  theme: Theme;
  width: number;
  terminalRows: number;
  scope: DiffScope;
  showAllScopes: boolean;
  comments: ReviewComment[];
  index: number;
  scroll: number;
}): { lines: string[]; scroll: number } {
  const inner = Math.max(40, width - 2);
  const height = Math.max(10, Math.floor(terminalRows * 0.7) - 3);

  const selectedComment = comments.length
    ? comments[Math.max(0, Math.min(comments.length - 1, index))] ?? null
    : null;

  const previewMaxLines = 6;
  const previewLines = selectedComment ? Math.min(previewMaxLines, Math.max(0, height - 12)) : 0;
  const previewSectionLines = previewLines > 0 ? previewLines + 2 : 0;

  const listRows = Math.max(1, height - 3 - previewSectionLines);
  const nextScroll = computeOverlayScroll(index, scroll, listRows);

  const lines: string[] = [topBorder(theme, "comments", inner, "accent")];
  const staleCount = comments.filter((c) => c.status === "stale_unresolved").length;
  lines.push(boxLine(theme, "│", `${theme.fg("muted", "scope filter")} ${showAllScopes ? "all scopes" : scopeDisplay(scope)}   ${theme.fg("muted", "total")} ${comments.length}   ${theme.fg(staleCount ? "warning" : "muted", `stale ${staleCount}`)}`, inner, "│", "accent"));
  lines.push(boxLine(theme, "│", "", inner, "│", "accent"));

  if (!comments.length) {
    lines.push(boxLine(theme, "│", theme.fg("muted", "(no comments)"), inner, "│", "accent"));
    lines.push(boxLine(theme, "│", theme.fg("dim", "t toggle all/current   esc close"), inner, "│", "accent"));
    lines.push(bottomBorder(theme, inner, "accent"));
    return { lines, scroll: nextScroll };
  }

  const visible = comments.slice(nextScroll, nextScroll + listRows);
  let previousPath = "";
  for (const comment of visible) {
    if (comment.displayPath !== previousPath) {
      previousPath = comment.displayPath;
      lines.push(boxLine(theme, "│", theme.bold(previousPath), inner, "│", "accent"));
    }
    const selected = selectedComment?.id === comment.id;
    const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
    const bodyPreview = truncateToWidth(comment.body.replace(/\s+/g, " "), Math.max(16, inner - 56), "…", true);
    const line = `${prefix}${String(comment.ordinal).padStart(2, " ")} ${formatScopeBadge(theme, comment.scope)} ${truncateToWidth(formatCommentLocation(comment), 30, "…", true)} ${theme.fg("muted", "·")} ${statusColor(theme, summarizeCommentStatus(comment.status), comment.status)} ${theme.fg("muted", "·")} ${theme.fg("dim", bodyPreview)}`;
    lines.push(boxLine(theme, "│", line, inner, "│", "accent"));
  }

  if (selectedComment && previewLines > 0) {
    lines.push(boxLine(theme, "│", "", inner, "│", "accent"));
    const selectedHeader = `${theme.fg("muted", "selected")} #${selectedComment.ordinal} ${formatScopeBadge(theme, selectedComment.scope)} ${truncateToWidth(formatCommentLocation(selectedComment), Math.max(10, inner - 28), "…", true)} ${theme.fg("muted", "·")} ${statusColor(theme, summarizeCommentStatus(selectedComment.status), selectedComment.status)}`;
    lines.push(boxLine(theme, "│", selectedHeader, inner, "│", "accent"));

    const originalLocation = formatOriginalCommentLocation(selectedComment);
    if (originalLocation) {
      lines.push(boxLine(
        theme,
        "│",
        `${theme.fg("muted", "original")} ${truncateToWidth(originalLocation, Math.max(10, inner - 10), "…", true)}`,
        inner,
        "│",
        "accent",
      ));
    }

    lines.push(...renderCommentBodyPreview(theme, selectedComment, inner, previewLines));
  }

  lines.push(boxLine(theme, "│", theme.fg("dim", "enter jump   e edit   d delete   t toggle all/current   esc close"), inner, "│", "accent"));
  lines.push(bottomBorder(theme, inner, "accent"));
  return { lines, scroll: nextScroll };
}

export function renderPeekCommentsOverlay({
  theme,
  width,
  locationLabel,
  comments,
  index,
}: {
  theme: Theme;
  width: number;
  locationLabel: string;
  comments: ReviewComment[];
  index: number;
}): string[] {
  const inner = Math.max(36, width - 2);
  const out: string[] = [topBorder(theme, "comments at cursor", inner, "accent")];
  out.push(boxLine(theme, "│", `${theme.fg("muted", "target")} ${locationLabel}`, inner, "│", "accent"));
  out.push(boxLine(theme, "│", "", inner, "│", "accent"));

  if (!comments.length) {
    out.push(boxLine(theme, "│", theme.fg("muted", "(no comments at this cursor location)"), inner, "│", "accent"));
    out.push(boxLine(theme, "│", theme.fg("dim", "esc close"), inner, "│", "accent"));
    out.push(bottomBorder(theme, inner, "accent"));
    return out;
  }

  const selected = comments[Math.max(0, Math.min(comments.length - 1, index))] ?? comments[0];
  for (let i = 0; i < comments.length; i += 1) {
    const comment = comments[i];
    const prefix = comment.id === selected?.id ? theme.fg("accent", "▸ ") : "  ";
    const body = truncateToWidth(comment.body.replace(/\s+/g, " "), Math.max(10, inner - 34), "…", true);
    out.push(boxLine(theme, "│", `${prefix}${String(comment.ordinal).padStart(2, " ")} ${truncateToWidth(formatCommentLocation(comment), 28, "…", true)} ${theme.fg("muted", "·")} ${body}`, inner, "│", "accent"));
  }

  out.push(boxLine(theme, "│", "", inner, "│", "accent"));
  out.push(boxLine(theme, "│", `${theme.fg("muted", "selected")} #${selected.ordinal} ${statusColor(theme, summarizeCommentStatus(selected.status), selected.status)}`, inner, "│", "accent"));

  const originalLocation = formatOriginalCommentLocation(selected);
  if (originalLocation) {
    out.push(boxLine(theme, "│", `${theme.fg("muted", "original")} ${truncateToWidth(originalLocation, Math.max(10, inner - 10), "…", true)}`, inner, "│", "accent"));
  }

  out.push(...renderCommentBodyPreview(theme, selected, inner, 4));
  out.push(boxLine(theme, "│", theme.fg("dim", "j/k move   enter jump   e edit   d delete   esc close"), inner, "│", "accent"));
  out.push(bottomBorder(theme, inner, "accent"));
  return out;
}

export function renderStaleResolverOverlay({
  theme,
  width,
  current,
  staleIndex,
  staleCount,
}: {
  theme: Theme;
  width: number;
  current: ReviewComment | null;
  staleIndex: number;
  staleCount: number;
}): string[] {
  const inner = Math.max(45, width - 2);
  if (!current) {
    return [topBorder(theme, "resolve stale comments", inner, "accent"), boxLine(theme, "│", "All stale comments resolved.", inner, "│"), bottomBorder(theme, inner, "accent")];
  }
  const out: string[] = [topBorder(theme, `resolve stale comment (${staleIndex + 1}/${staleCount})`, inner, "accent")];
  out.push(boxLine(theme, "│", `comment #${current.ordinal} ${formatScopeBadge(theme, current.scope)} ${formatCommentLocation(current)}`, inner, "│"));

  const originalLocation = formatOriginalCommentLocation(current);
  if (originalLocation) {
    out.push(boxLine(
      theme,
      "│",
      `${theme.fg("muted", "original")} ${truncateToWidth(originalLocation, Math.max(10, inner - 10), "…", true)}`,
      inner,
      "│",
    ));
  }

  out.push(boxLine(theme, "│", theme.fg("error", "status: stale_unresolved"), inner, "│"));
  out.push(boxLine(theme, "│", "stored context:", inner, "│"));
  for (const line of (current.compactSnippet || "(no snippet)").split("\n").slice(0, 8)) {
    out.push(boxLine(theme, "│", theme.fg("dim", line), inner, "│"));
  }
  out.push(boxLine(theme, "│", "candidates:", inner, "│"));
  const candidates: CandidateRemap[] = current.candidateRemaps.slice(0, 9);
  if (!candidates.length) {
    out.push(boxLine(theme, "│", theme.fg("muted", "(no candidate remaps found)"), inner, "│"));
  } else {
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      out.push(boxLine(theme, "│", `${i + 1}) ${candidate.displayPath}:${candidate.startLine ?? candidate.line ?? "?"} ${truncateToWidth(candidate.preview, Math.max(8, inner - 20), "…", true)}`, inner, "│"));
    }
  }
  out.push(boxLine(theme, "│", theme.fg("dim", "1-9 pick candidate   a attach@cursor   h downgrade→range   f downgrade→file"), inner, "│"));
  out.push(boxLine(theme, "│", theme.fg("dim", "d delete comment   esc cancel submit"), inner, "│"));
  out.push(bottomBorder(theme, inner, "accent"));
  return out;
}
