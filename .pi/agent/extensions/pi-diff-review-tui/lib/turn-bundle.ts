import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveTurnLatestCandidates } from "./diff-review-paths.ts";
import { buildBundleFromPatchText, observedChangedPathsFromPatchText } from "./git.ts";
import type { AgentChangeReport, DiffBundle, TurnSourceMetadata, TurnSourceRepoSummary } from "./types.ts";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function sanitizeAgentChangeReport(value: unknown): AgentChangeReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const files = Array.isArray((value as { files?: unknown }).files)
    ? (value as { files: unknown[] }).files
        .filter((entry): entry is { path: string; summary?: string } => Boolean(entry) && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string")
        .map((entry) => ({
          path: entry.path.trim(),
          ...(typeof entry.summary === "string" && entry.summary.trim() ? { summary: entry.summary.trim() } : {}),
        }))
        .filter((entry) => entry.path.length > 0)
    : [];
  return {
    generated_at: typeof (value as { generated_at?: unknown }).generated_at === "string"
      ? (value as { generated_at: string }).generated_at
      : new Date(0).toISOString(),
    generator: typeof (value as { generator?: unknown }).generator === "string"
      ? (value as { generator: string }).generator
      : "unknown",
    files,
    missing_from_observed: stringArray((value as { missing_from_observed?: unknown }).missing_from_observed),
    missing_from_agent_report: stringArray((value as { missing_from_agent_report?: unknown }).missing_from_agent_report),
  };
}

function sanitizeRepoSummaries(value: unknown): TurnSourceRepoSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const repos = value
    .filter((entry): entry is TurnSourceRepoSummary => Boolean(entry) && typeof entry === "object"
      && typeof (entry as { repo_key?: unknown }).repo_key === "string"
      && typeof (entry as { repo_root?: unknown }).repo_root === "string")
    .map((entry) => ({
      repo_key: entry.repo_key,
      repo_root: entry.repo_root,
      touched_paths: stringArray(entry.touched_paths),
      observed_changed_paths: stringArray(entry.observed_changed_paths),
      ...(entry.omitted_paths && typeof entry.omitted_paths === "object" ? { omitted_paths: entry.omitted_paths } : {}),
    }));
  return repos.length ? repos : undefined;
}

function sanitizeTurnMetadata(value: unknown): TurnSourceMetadata | null {
  if (!value || typeof value !== "object") return null;
  const sessionId = typeof (value as { session_id?: unknown }).session_id === "string" ? (value as { session_id: string }).session_id : "";
  const turnId = typeof (value as { turn_id?: unknown }).turn_id === "string" ? (value as { turn_id: string }).turn_id : "";
  const reviewSource = typeof (value as { review_source?: unknown }).review_source === "string"
    ? (value as { review_source: string }).review_source
    : "last turn (repo snapshot)";
  const repoRoot = typeof (value as { repo_root?: unknown }).repo_root === "string" ? (value as { repo_root: string }).repo_root : "";
  const repoKey = typeof (value as { repo_key?: unknown }).repo_key === "string" ? (value as { repo_key: string }).repo_key : "";
  const rawSource = (value as { source?: unknown }).source;
  const source = rawSource === "last_turn_repo_snapshot" ? "last_turn_repo_snapshot" : "last_turn_agent_touched";
  if (!sessionId || !turnId || !repoRoot || !repoKey) return null;

  const workspace = Boolean((value as { workspace?: unknown }).workspace);
  return {
    saved_at: typeof (value as { saved_at?: unknown }).saved_at === "string"
      ? (value as { saved_at: string }).saved_at
      : new Date(0).toISOString(),
    session_id: sessionId,
    turn_id: turnId,
    source,
    review_source: reviewSource,
    repo_root: repoRoot,
    repo_key: repoKey,
    touched_paths: stringArray((value as { touched_paths?: unknown }).touched_paths),
    observed_changed_paths: stringArray((value as { observed_changed_paths?: unknown }).observed_changed_paths),
    has_bash_calls: Boolean((value as { has_bash_calls?: unknown }).has_bash_calls),
    ...(typeof (value as { note?: unknown }).note === "string" && (value as { note: string }).note.trim() ? { note: (value as { note: string }).note } : {}),
    ...((value as { omitted_paths?: unknown }).omitted_paths && typeof (value as { omitted_paths: unknown }).omitted_paths === "object" ? { omitted_paths: (value as { omitted_paths: TurnSourceMetadata["omitted_paths"] }).omitted_paths } : {}),
    ...(sanitizeAgentChangeReport((value as { agent_change_report?: unknown }).agent_change_report) ? { agent_change_report: sanitizeAgentChangeReport((value as { agent_change_report?: unknown }).agent_change_report) } : {}),
    ...(workspace ? { workspace: true, repos: sanitizeRepoSummaries((value as { repos?: unknown }).repos) ?? [] } : { workspace: false }),
  };
}

function latestTurnCandidates(
  repoRoot: string,
  sessionId: string,
  options?: { scopeKey?: string; allowRepoRoot?: boolean },
): Array<{ patchPath: string; jsonPath: string }> {
  return resolveTurnLatestCandidates({
    repoRoot,
    scopeKey: options?.scopeKey,
    allowRepoRoot: options?.allowRepoRoot,
    sessionId,
  });
}

export function readLatestTurnArtifact(
  repoRoot: string,
  sessionId: string,
  options?: { scopeKey?: string; allowRepoRoot?: boolean },
): { patchText: string; metadata: TurnSourceMetadata } | null {
  if (!sessionId.trim()) return null;
  for (const { patchPath, jsonPath } of latestTurnCandidates(repoRoot, sessionId, options)) {
    if (!fs.existsSync(jsonPath)) continue;

    try {
      const metadata = sanitizeTurnMetadata(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
      if (!metadata || metadata.session_id != sessionId) continue;
      const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
      const observedChangedPaths = metadata.observed_changed_paths.length ? metadata.observed_changed_paths : observedChangedPathsFromPatchText(patchText);
      return { patchText, metadata: { ...metadata, observed_changed_paths: observedChangedPaths } };
    } catch {
      // ignore and continue
    }
  }

  return null;
}

export async function getLatestTurnBundle(
  pi: ExtensionAPI,
  repoRoot: string,
  sessionId: string,
  options?: { scopeKey?: string; allowRepoRoot?: boolean },
): Promise<DiffBundle | null> {
  const artifact = readLatestTurnArtifact(repoRoot, sessionId, options);
  if (!artifact) return null;
  return buildBundleFromPatchText({
    scope: "t",
    repoRoot,
    head: null,
    patchTextRaw: artifact.patchText,
    sourceKind: "turn",
    turnMetadata: artifact.metadata,
  });
}
