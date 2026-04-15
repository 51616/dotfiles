import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chooseOmittedInfo } from "./files.ts";
import { resolveDiffReviewRootForWrite } from "./diff-review-paths.ts";
import { observedChangedPathsFromPatch } from "./observed-changed-paths.ts";
import type {
  FileImage,
  RepoTurnArtifact,
  RepoTurnArtifactMetadata,
  RepoTurnState,
  TurnArtifactMetadata,
} from "./types.ts";

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeImageTree(root: string, repoRelPath: string, image: FileImage): boolean {
  if (image.kind !== "content") return false;
  const target = path.join(root, repoRelPath);
  ensureParent(target);
  fs.writeFileSync(target, image.text, "utf8");
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function postProcessNoIndexPatch(patchText: string, preTree: string, postTree: string): string {
  const variants = [preTree, postTree]
    .map((value) => value.replace(/^\/+/, ""))
    .map((value) => escapeRegExp(value));
  let next = patchText;
  for (const variant of variants) {
    next = next
      .replace(new RegExp(`a/${variant}/`, "g"), "a/")
      .replace(new RegExp(`b/${variant}/`, "g"), "b/")
      .replace(new RegExp(`^rename from ${variant}/`, "gm"), "rename from ")
      .replace(new RegExp(`^rename to ${variant}/`, "gm"), "rename to ");
  }
  return next;
}

function fileImagesEqual(pre: FileImage, post: FileImage): boolean {
  if (pre.kind !== post.kind) return false;
  if (pre.kind === "missing" && post.kind === "missing") return true;
  if (pre.kind === "content" && post.kind === "content") return pre.sha256 === post.sha256;
  if (pre.kind === "omitted" && post.kind === "omitted") {
    return pre.exists === post.exists
      && pre.reason === post.reason
      && pre.sizeBytes === post.sizeBytes
      && pre.sha256 === post.sha256
      && pre.mtimeMs === post.mtimeMs;
  }
  return false;
}

function syntheticPatch(repoRelPath: string, pre: FileImage, post: FileImage): string | null {
  const omission = chooseOmittedInfo(pre, post);
  if (!omission) return null;

  const oldPath = pre.exists ? `a/${repoRelPath}` : "/dev/null";
  const newPath = post.exists ? `b/${repoRelPath}` : "/dev/null";
  const lines = [
    `diff --git a/${repoRelPath} b/${repoRelPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
  ];

  if (omission.reason === "binary") {
    if (pre.exists && post.exists) lines.push(`Binary files a/${repoRelPath} and b/${repoRelPath} differ`);
    else if (pre.exists) lines.push(`Binary files a/${repoRelPath} and /dev/null differ`);
    else lines.push(`Binary files /dev/null and b/${repoRelPath} differ`);
    if (omission.size_bytes != null) lines.push(`pi-diff-review: binary diff omitted (size=${omission.size_bytes})`);
    return lines.join("\n");
  }

  const size = omission.size_bytes != null ? `, size=${omission.size_bytes}` : "";
  lines.push(`pi-diff-review: diff omitted (reason=${omission.reason}${size})`);
  return lines.join("\n");
}

export function buildRepoPatch(repo: RepoTurnState): { patchText: string; observedChangedPaths: string[]; omittedPaths?: Record<string, { reason: string; size_bytes?: number }> } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-turn-"));
  const preTree = path.join(tmpRoot, "pre");
  const postTree = path.join(tmpRoot, "post");
  fs.mkdirSync(preTree, { recursive: true });
  fs.mkdirSync(postTree, { recursive: true });

  const syntheticSections: string[] = [];
  const omittedPaths: Record<string, { reason: string; size_bytes?: number }> = {};
  let hasMaterialized = false;

  try {
    for (const tracked of [...repo.touchedPaths.values()].sort((a, b) => a.repoRelPath.localeCompare(b.repoRelPath))) {
      const pre = tracked.baseline;
      const post = tracked.final ?? { kind: "missing", exists: false };
      if (fileImagesEqual(pre, post)) continue;
      const canMaterialize = pre.kind !== "omitted" && post.kind !== "omitted";
      if (canMaterialize) {
        hasMaterialized = writeImageTree(preTree, tracked.repoRelPath, pre) || hasMaterialized;
        hasMaterialized = writeImageTree(postTree, tracked.repoRelPath, post) || hasMaterialized;
      }
      const synthetic = syntheticPatch(tracked.repoRelPath, pre, post);
      const omission = chooseOmittedInfo(pre, post);
      if (omission) omittedPaths[tracked.repoRelPath] = omission;
      if (synthetic) syntheticSections.push(synthetic);
    }

    let patch = "";
    if (hasMaterialized) {
      const result = spawnSync(
        "git",
        ["diff", "--no-index", "--no-ext-diff", "-M", "--binary", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", preTree, postTree],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (result.status === 1 || result.status === 0) {
        patch = postProcessNoIndexPatch(result.stdout.trim(), preTree, postTree);
      } else {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "git diff --no-index failed while building the turn snapshot patch");
      }
    }

    const joined = [patch, ...syntheticSections].filter(Boolean).join("\n\n").trim();
    const patchText = joined ? `${joined}\n` : "";
    return {
      patchText,
      observedChangedPaths: observedChangedPathsFromPatch(patchText),
      omittedPaths: Object.keys(omittedPaths).length ? omittedPaths : undefined,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: TurnArtifactMetadata): void {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath: string, value: string): void {
  ensureParent(filePath);
  fs.writeFileSync(filePath, value, "utf8");
}

function writeNamedArtifact(root: string, stem: string, patchText: string, metadata: TurnArtifactMetadata): void {
  writeText(path.join(root, `${stem}.patch`), patchText);
  writeJson(path.join(root, `${stem}.json`), metadata);
}

function writeLatestArtifact(root: string, patchText: string, metadata: TurnArtifactMetadata): void {
  writeNamedArtifact(root, "latest", patchText, metadata);
}

function writeLatestReviewableArtifact(root: string, patchText: string, metadata: TurnArtifactMetadata): void {
  writeNamedArtifact(root, "latest-reviewable", patchText, metadata);
}

export function writeRepoArtifacts({
  repoArtifact,
  scopeKey,
  allowRepoRoot,
}: {
  repoArtifact: RepoTurnArtifact;
  scopeKey?: string;
  allowRepoRoot?: boolean;
}): void {
  const { rootDir } = resolveDiffReviewRootForWrite({
    repoRoot: repoArtifact.repoRoot,
    scopeKey,
    allowRepoRoot,
  });
  const turnsRoot = path.join(rootDir, "turns");
  const sessionRoot = path.join(turnsRoot, "sessions", repoArtifact.metadata.session_id);
  const repoRoot = path.join(sessionRoot, repoArtifact.repoKey);

  writeLatestArtifact(repoRoot, repoArtifact.patchText, repoArtifact.metadata);
  if (repoArtifact.patchText.trim()) writeLatestReviewableArtifact(repoRoot, repoArtifact.patchText, repoArtifact.metadata);

  writeLatestArtifact(sessionRoot, repoArtifact.patchText, repoArtifact.metadata);
  writeLatestArtifact(turnsRoot, repoArtifact.patchText, repoArtifact.metadata);
  if (repoArtifact.patchText.trim()) {
    writeLatestReviewableArtifact(sessionRoot, repoArtifact.patchText, repoArtifact.metadata);
    writeLatestReviewableArtifact(turnsRoot, repoArtifact.patchText, repoArtifact.metadata);
  }
}

export function writeEmptyLatestArtifact({
  repoRoot,
  repoKey,
  sessionId,
  turnId,
  note,
  hasBashCalls,
  agentChangeReport,
  scopeKey,
  allowRepoRoot,
}: {
  repoRoot: string;
  repoKey: string;
  sessionId: string;
  turnId: string;
  note?: string;
  hasBashCalls: boolean;
  agentChangeReport?: RepoTurnArtifactMetadata["agent_change_report"];
  scopeKey?: string;
  allowRepoRoot?: boolean;
}): void {
  const savedAt = new Date().toISOString();
  const metadata: RepoTurnArtifactMetadata = {
    saved_at: savedAt,
    session_id: sessionId,
    turn_id: turnId,
    source: "last_turn_repo_snapshot",
    review_source: "last turn (repo snapshot)",
    repo_root: repoRoot,
    repo_key: repoKey,
    touched_paths: [],
    observed_changed_paths: [],
    has_bash_calls: hasBashCalls,
    note,
    agent_change_report: agentChangeReport,
    workspace: false,
  };
  const { rootDir } = resolveDiffReviewRootForWrite({ repoRoot, scopeKey, allowRepoRoot });
  const turnsRoot = path.join(rootDir, "turns");
  const sessionRoot = path.join(turnsRoot, "sessions", sessionId);
  const repoSessionRoot = path.join(sessionRoot, repoKey);
  writeLatestArtifact(repoSessionRoot, "", metadata);
  writeLatestArtifact(sessionRoot, "", metadata);
  writeLatestArtifact(turnsRoot, "", metadata);
}
