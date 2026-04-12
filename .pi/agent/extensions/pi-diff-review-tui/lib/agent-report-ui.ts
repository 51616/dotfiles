import type { ParsedFilePatch, TurnSourceMetadata } from "./types.ts";

function uniqueCount(values: string[]): number {
  return new Set(values).size;
}

export function buildTurnSourceSummary(metadata: TurnSourceMetadata | null | undefined): string {
  if (!metadata) return "last turn (agent-touched)";
  const repos = metadata.workspace ? metadata.repos?.map((repo) => repo.repo_key).join(", ") : null;
  const parts = [
    `${metadata.observed_changed_paths.length} observed`,
    `${metadata.touched_paths.length} touched`,
    repos ? `repos ${repos}` : null,
  ];

  if (metadata.agent_change_report) {
    parts.push(`agent ${uniqueCount(metadata.agent_change_report.files.map((entry) => entry.path))}`);
    parts.push(`reported-only ${metadata.agent_change_report.missing_from_observed.length}`);
    parts.push(`missing-agent ${metadata.agent_change_report.missing_from_agent_report.length}`);
  } else {
    parts.push("no agent report");
  }

  if (metadata.note) parts.push(metadata.note);
  return `${metadata.review_source} · ${parts.filter(Boolean).join(" · ")}`;
}

export function diffTitleForFile(file: ParsedFilePatch | null): string {
  if (!file) return "Diff";
  if (file.reviewProvenance !== "reported_only") return file.displayPath;
  if (file.reportedOnlyDiffState === "derived_current_repo_diff") {
    return `${file.displayPath} (reported-only · derived repo diff)`;
  }
  return `${file.displayPath} (reported-only · no current repo diff)`;
}

export function commentDisabledReason(file: ParsedFilePatch | null): string | null {
  if (!file) return "No file selected.";
  if (file.reviewProvenance === "reported_only") {
    return "Reported-only advisory rows are inspect-only in v1; comment or reject canonical observed rows instead.";
  }
  return null;
}
