import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildFileKey, parseSingleFilePatch, sha256, splitPatchIntoFileSections } from "./diff-parser.ts";
import type { DiffBundle, ParsedDiffRow, ParsedFilePatch, TurnSourceMetadata } from "./types.ts";

function normalizeArtifactPath(value: string): string | null {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes(":")) return null;
  const parts = normalized.split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function candidateArtifactPaths(metadata: TurnSourceMetadata): Set<string> {
  return new Set([...metadata.touched_paths, ...metadata.observed_changed_paths].map((entry) => normalizeArtifactPath(entry)).filter(Boolean));
}

function resolvedPathForArtifact(metadata: TurnSourceMetadata, artifactPath: string): {
  repoRoot: string;
  repoRelPath: string;
} | null {
  const normalized = normalizeArtifactPath(artifactPath);
  if (!normalized) return null;
  if (!metadata.workspace) {
    return { repoRoot: metadata.repo_root, repoRelPath: normalized };
  }

  const [repoKey, ...rest] = normalized.split("/");
  if (!repoKey || !rest.length) return null;
  const repo = metadata.repos?.find((entry) => entry.repo_key === repoKey);
  if (!repo) return null;
  return {
    repoRoot: repo.repo_root,
    repoRelPath: rest.join("/"),
  };
}

function observedPathForFile(file: ParsedFilePatch): string | null {
  return normalizeArtifactPath(file.newPath ?? file.oldPath ?? "");
}

function withResolvedLocation(file: ParsedFilePatch, metadata: TurnSourceMetadata): ParsedFilePatch {
  const resolved = resolvedPathForArtifact(metadata, file.editablePath ?? file.newPath ?? file.oldPath ?? file.displayPath);
  return {
    ...file,
    reviewProvenance: file.reviewProvenance ?? "observed",
    observedChangedPath: file.observedChangedPath ?? observedPathForFile(file),
    resolvedRepoRoot: resolved?.repoRoot ?? null,
    resolvedEditablePath: resolved?.repoRelPath ?? null,
  };
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[], allowFailure = false): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    if (allowFailure) return "";
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout.replace(/\r\n/g, "\n");
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

async function isUntracked(pi: ExtensionAPI, repoRoot: string, repoRelPath: string): Promise<boolean> {
  const output = await runGit(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "--", repoRelPath], true);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).includes(repoRelPath);
}

async function noIndexPatch(pi: ExtensionAPI, repoRoot: string, repoRelPath: string): Promise<string> {
  const result = await pi.exec("git", ["diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", repoRelPath], { cwd: repoRoot });
  return result.stdout.replace(/\r\n/g, "\n").trim();
}

async function currentRepoPatchForPath(pi: ExtensionAPI, repoRoot: string, repoRelPath: string): Promise<string> {
  const sections: string[] = [];
  if (await hasHead(pi, repoRoot)) {
    const againstHead = await runGit(pi, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", "HEAD", "--", repoRelPath], true);
    if (againstHead.trim()) sections.push(againstHead.trim());
  } else {
    const staged = await runGit(pi, repoRoot, ["diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", "--", repoRelPath], true);
    const unstaged = await runGit(pi, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", "--", repoRelPath], true);
    if (staged.trim()) sections.push(staged.trim());
    if (unstaged.trim()) sections.push(unstaged.trim());
  }

  if (await isUntracked(pi, repoRoot, repoRelPath)) {
    const patch = await noIndexPatch(pi, repoRoot, repoRelPath);
    if (patch.trim()) sections.push(patch.trim());
  }

  return sections.filter(Boolean).join("\n\n").trim();
}

function firstParsedPatch(patchText: string): ParsedFilePatch | null {
  const [section] = splitPatchIntoFileSections(patchText);
  if (!section) return null;
  return parseSingleFilePatch({ rawPatch: section });
}

function advisoryMetaRows(fileKey: string, lines: string[]): ParsedDiffRow[] {
  return lines.map((line, rowIndex) => ({
    kind: "meta",
    text: line,
    rawText: line,
    fileKey,
    rowIndex,
  }));
}

function rewritePatchIdentity(patchText: string, repoRelPath: string, artifactPath: string): string {
  if (repoRelPath === artifactPath) return patchText;
  const escapedRepoRelPath = repoRelPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return patchText
    .replace(new RegExp(`^diff --git a/${escapedRepoRelPath} b/${escapedRepoRelPath}$`, "gm"), `diff --git a/${artifactPath} b/${artifactPath}`)
    .replace(new RegExp(`^--- a/${escapedRepoRelPath}$`, "gm"), `--- a/${artifactPath}`)
    .replace(new RegExp(`^\\+\\+\\+ b/${escapedRepoRelPath}$`, "gm"), `+++ b/${artifactPath}`)
    .replace(new RegExp(`^Binary files a/${escapedRepoRelPath} and b/${escapedRepoRelPath} differ$`, "gm"), `Binary files a/${artifactPath} and b/${artifactPath} differ`)
    .replace(new RegExp(`^Binary files a/${escapedRepoRelPath} and /dev/null differ$`, "gm"), `Binary files a/${artifactPath} and /dev/null differ`)
    .replace(new RegExp(`^Binary files /dev/null and b/${escapedRepoRelPath} differ$`, "gm"), `Binary files /dev/null and b/${artifactPath} differ`);
}

function withArtifactIdentity(file: ParsedFilePatch, artifactPath: string): ParsedFilePatch {
  const fileKey = buildFileKey(file.status, artifactPath, artifactPath);
  return {
    ...file,
    fileKey,
    oldPath: artifactPath,
    newPath: artifactPath,
    displayPath: artifactPath,
    editablePath: artifactPath,
    rows: file.rows.map((row) => ({ ...row, fileKey })),
  };
}

function placeholderReportedOnlyFile({
  artifactPath,
  summary,
  resolvedRepoRoot,
  resolvedEditablePath,
  diffState,
}: {
  artifactPath: string;
  summary?: string;
  resolvedRepoRoot: string | null;
  resolvedEditablePath: string | null;
  diffState: "no_current_repo_diff" | "deferred_current_repo_diff";
}): ParsedFilePatch {
  const fileKey = buildFileKey("M", artifactPath, artifactPath);
  const statusLine = diffState === "deferred_current_repo_diff"
    ? "pi-diff-review: current repo diff not loaded yet for this reported-only path"
    : "pi-diff-review: no current repo diff exists for this path";
  const lines = [
    `pi-diff-review: reported-only advisory file ${artifactPath}`,
    statusLine,
    ...(summary ? [`pi-diff-review: agent summary ${summary}`] : []),
  ];
  return {
    fileKey,
    status: "M",
    oldPath: artifactPath,
    newPath: artifactPath,
    displayPath: artifactPath,
    editablePath: artifactPath,
    rawPatch: "",
    rows: advisoryMetaRows(fileKey, lines),
    hunks: [],
    changeBlocks: [],
    isBinary: false,
    reviewProvenance: "reported_only",
    agentMismatch: "missing_from_observed",
    agentSummary: summary ?? null,
    observedChangedPath: artifactPath,
    reportedOnlyDiffState: diffState,
    resolvedRepoRoot,
    resolvedEditablePath,
  };
}

async function buildReportedOnlyFile({
  pi,
  metadata,
  artifactPath,
  summary,
  currentPatch,
  deferCurrentRepoDiff,
}: {
  pi: ExtensionAPI;
  metadata: TurnSourceMetadata;
  artifactPath: string;
  summary?: string;
  currentPatch: (input: { repoRoot: string; repoRelPath: string }) => Promise<string>;
  deferCurrentRepoDiff?: boolean;
}): Promise<ParsedFilePatch | null> {
  const resolved = resolvedPathForArtifact(metadata, artifactPath);
  if (!resolved) return null;

  if (deferCurrentRepoDiff) {
    return placeholderReportedOnlyFile({
      artifactPath,
      summary,
      resolvedRepoRoot: resolved.repoRoot,
      resolvedEditablePath: resolved.repoRelPath,
      diffState: "deferred_current_repo_diff",
    });
  }

  const patchText = await currentPatch({ repoRoot: resolved.repoRoot, repoRelPath: resolved.repoRelPath });
  if (!patchText.trim()) {
    return placeholderReportedOnlyFile({
      artifactPath,
      summary,
      resolvedRepoRoot: resolved.repoRoot,
      resolvedEditablePath: resolved.repoRelPath,
      diffState: "no_current_repo_diff",
    });
  }

  const artifactPatchText = rewritePatchIdentity(patchText, resolved.repoRelPath, artifactPath);
  const parsed = firstParsedPatch(artifactPatchText);
  if (!parsed) {
    return placeholderReportedOnlyFile({
      artifactPath,
      summary,
      resolvedRepoRoot: resolved.repoRoot,
      resolvedEditablePath: resolved.repoRelPath,
      diffState: "no_current_repo_diff",
    });
  }

  return {
    ...withArtifactIdentity({ ...parsed, rawPatch: artifactPatchText }, artifactPath),
    reviewProvenance: "reported_only",
    agentMismatch: "missing_from_observed",
    agentSummary: summary ?? null,
    observedChangedPath: artifactPath,
    reportedOnlyDiffState: "derived_current_repo_diff",
    resolvedRepoRoot: resolved.repoRoot,
    resolvedEditablePath: resolved.repoRelPath,
  };
}

export function rebuildTurnBundleFiles(bundle: DiffBundle, files: ParsedFilePatch[]): DiffBundle {
  const fileHashes = new Map(files.map((file) => [file.fileKey, sha256(JSON.stringify({
    rawPatch: file.rawPatch,
    provenance: file.reviewProvenance ?? "observed",
    agentMismatch: file.agentMismatch ?? null,
    agentSummary: file.agentSummary ?? null,
    reportedOnlyDiffState: file.reportedOnlyDiffState ?? null,
  }))]));
  const fingerprint = sha256(JSON.stringify({
    scope: bundle.scope,
    sourceKind: bundle.sourceKind,
    turnId: bundle.turnMetadata?.turn_id ?? null,
    files: [...fileHashes.entries()],
  }));

  return {
    ...bundle,
    files,
    fileHashes,
    fingerprint,
  };
}

export async function hydrateDeferredReportedOnlyBundleFile(
  pi: ExtensionAPI,
  bundle: DiffBundle,
  fileKey: string,
  options?: {
    currentRepoPatchForPath?: (input: { repoRoot: string; repoRelPath: string }) => Promise<string>;
  },
): Promise<DiffBundle> {
  if (bundle.sourceKind !== "turn" || !bundle.turnMetadata) return bundle;

  const fileIndex = bundle.files.findIndex((file) => file.fileKey === fileKey);
  if (fileIndex < 0) return bundle;
  const file = bundle.files[fileIndex];
  if (!file || file.reviewProvenance !== "reported_only" || file.reportedOnlyDiffState !== "deferred_current_repo_diff") {
    return bundle;
  }

  const artifactPath = normalizeArtifactPath(file.observedChangedPath ?? file.displayPath);
  if (!artifactPath) return bundle;

  const currentPatch = options?.currentRepoPatchForPath
    ? options.currentRepoPatchForPath
    : ({ repoRoot, repoRelPath }: { repoRoot: string; repoRelPath: string }) => currentRepoPatchForPath(pi, repoRoot, repoRelPath);
  const hydrated = await buildReportedOnlyFile({
    pi,
    metadata: bundle.turnMetadata,
    artifactPath,
    summary: file.agentSummary ?? undefined,
    currentPatch,
  });
  if (!hydrated) return bundle;

  const files = bundle.files.slice();
  files[fileIndex] = hydrated;
  return rebuildTurnBundleFiles(bundle, files);
}

export async function enrichTurnBundleWithAgentReport(
  pi: ExtensionAPI,
  bundle: DiffBundle,
  options?: {
    currentRepoPatchForPath?: (input: { repoRoot: string; repoRelPath: string }) => Promise<string>;
    deferReportedOnlyFiles?: boolean;
  },
): Promise<DiffBundle> {
  if (bundle.sourceKind !== "turn" || !bundle.turnMetadata) return bundle;

  const metadata = bundle.turnMetadata;
  const currentPatch = options?.currentRepoPatchForPath
    ? options.currentRepoPatchForPath
    : ({ repoRoot, repoRelPath }: { repoRoot: string; repoRelPath: string }) => currentRepoPatchForPath(pi, repoRoot, repoRelPath);
  const canonicalFiles = bundle.files.map((file) => withResolvedLocation(file, metadata));
  const agentReport = metadata.agent_change_report;
  if (!agentReport) {
    return { ...bundle, files: canonicalFiles };
  }

  const candidatePaths = candidateArtifactPaths(metadata);
  const validAgentFiles = agentReport.files
    .map((entry) => ({ path: normalizeArtifactPath(entry.path), summary: entry.summary }))
    .filter((entry): entry is { path: string; summary?: string } => Boolean(entry.path) && candidatePaths.has(entry.path));
  const summaryByPath = new Map(validAgentFiles.map((entry) => [entry.path, entry.summary]));
  const missingFromAgent = new Set(
    agentReport.missing_from_agent_report
      .map((entry) => normalizeArtifactPath(entry))
      .filter((entry): entry is string => Boolean(entry) && candidatePaths.has(entry)),
  );

  const observedFiles = canonicalFiles.map((file) => {
    const observedPath = file.observedChangedPath ?? observedPathForFile(file);
    return {
      ...file,
      reviewProvenance: "observed" as const,
      observedChangedPath: observedPath,
      agentSummary: observedPath ? summaryByPath.get(observedPath) ?? null : null,
      agentMismatch: observedPath && missingFromAgent.has(observedPath) ? "missing_from_agent_report" as const : null,
    };
  });

  const reportedOnlyPaths = agentReport.missing_from_observed
    .map((entry) => normalizeArtifactPath(entry))
    .filter((entry): entry is string => Boolean(entry) && candidatePaths.has(entry));
  const reportedOnlyFiles = (await Promise.all(
    reportedOnlyPaths.map(async (artifactPath) => buildReportedOnlyFile({
      pi,
      metadata,
      artifactPath,
      summary: summaryByPath.get(artifactPath),
      currentPatch,
      deferCurrentRepoDiff: options?.deferReportedOnlyFiles === true,
    })),
  )).filter((file): file is ParsedFilePatch => Boolean(file));

  return rebuildTurnBundleFiles(bundle, [...observedFiles, ...reportedOnlyFiles]);
}
