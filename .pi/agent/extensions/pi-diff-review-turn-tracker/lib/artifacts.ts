import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chooseOmittedInfo } from "./files.ts";
import { resolveDiffReviewRootForWrite } from "./diff-review-paths.ts";
import type {
  FileImage,
  RepoTurnArtifact,
  RepoTurnArtifactMetadata,
  RepoTurnState,
  TurnArtifactMetadata,
  WorkspaceTurnArtifactMetadata,
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

export function buildRepoPatch(repo: RepoTurnState): { patchText: string; omittedPaths?: Record<string, { reason: string; size_bytes?: number }> } {
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
      hasMaterialized = writeImageTree(preTree, tracked.repoRelPath, pre) || hasMaterialized;
      hasMaterialized = writeImageTree(postTree, tracked.repoRelPath, post) || hasMaterialized;
      const synthetic = syntheticPatch(tracked.repoRelPath, pre, post);
      const omission = chooseOmittedInfo(pre, post);
      if (omission) omittedPaths[tracked.repoRelPath] = omission;
      if (synthetic) syntheticSections.push(synthetic);
    }

    let patch = "";
    if (hasMaterialized) {
      const result = spawnSync(
        "git",
        ["diff", "--no-index", "-M", "--binary", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", preTree, postTree],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (result.status === 1 || result.status === 0) patch = postProcessNoIndexPatch(result.stdout.trim(), preTree, postTree);
    }

    const joined = [patch, ...syntheticSections].filter(Boolean).join("\n\n").trim();
    return {
      patchText: joined ? `${joined}\n` : "",
      omittedPaths: Object.keys(omittedPaths).length ? omittedPaths : undefined,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function prefixPatchPaths(patchText: string, repoKey: string): string {
  return patchText
    .replace(/^diff --git a\/(.+) b\/(.+)$/gm, (_m, oldPath, newPath) => `diff --git a/${repoKey}/${oldPath} b/${repoKey}/${newPath}`)
    .replace(/^--- a\/(.+)$/gm, (_m, filePath) => `--- a/${repoKey}/${filePath}`)
    .replace(/^\+\+\+ b\/(.+)$/gm, (_m, filePath) => `+++ b/${repoKey}/${filePath}`)
    .replace(/^rename from (.+)$/gm, (_m, filePath) => `rename from ${repoKey}/${filePath}`)
    .replace(/^rename to (.+)$/gm, (_m, filePath) => `rename to ${repoKey}/${filePath}`)
    .replace(/^Binary files a\/(.+) and b\/(.+) differ$/gm, (_m, oldPath, newPath) => `Binary files a/${repoKey}/${oldPath} and b/${repoKey}/${newPath} differ`);
}

export function buildWorkspaceArtifact({
  repoArtifacts,
  savedAt,
  sessionId,
  turnId,
  hasBashCalls,
}: {
  repoArtifacts: RepoTurnArtifact[];
  savedAt: string;
  sessionId: string;
  turnId: string;
  hasBashCalls: boolean;
}): { patchText: string; metadata: WorkspaceTurnArtifactMetadata } {
  const patchText = repoArtifacts.map((artifact) => prefixPatchPaths(artifact.patchText.trim(), artifact.repoKey)).filter(Boolean).join("\n\n").trim();
  const note = hasBashCalls ? "bash calls occurred; non-edit/write file changes may not be fully attributed." : undefined;
  return {
    patchText: patchText ? `${patchText}\n` : "",
    metadata: {
      saved_at: savedAt,
      session_id: sessionId,
      turn_id: turnId,
      source: "last_turn_agent_touched",
      review_source: "last turn (agent-touched)",
      repo_root: "workspace",
      repo_key: "workspace",
      touched_paths: repoArtifacts.flatMap((artifact) => artifact.metadata.touched_paths.map((filePath) => `${artifact.repoKey}/${filePath}`)),
      has_bash_calls: hasBashCalls,
      note,
      workspace: true,
      repos: repoArtifacts.map((artifact) => ({
        repo_key: artifact.repoKey,
        repo_root: artifact.repoRoot,
        touched_paths: artifact.metadata.touched_paths,
        omitted_paths: artifact.metadata.omitted_paths,
      })),
    },
  };
}

function writeJson(filePath: string, value: TurnArtifactMetadata): void {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath: string, value: string): void {
  ensureParent(filePath);
  fs.writeFileSync(filePath, value, "utf8");
}

export function writeRepoArtifacts({
  repoArtifact,
  workspace,
}: {
  repoArtifact: RepoTurnArtifact;
  workspace?: { patchText: string; metadata: WorkspaceTurnArtifactMetadata } | null;
}): void {
  const { rootDir } = resolveDiffReviewRootForWrite({ repoRoot: repoArtifact.repoRoot });
  const turnsRoot = path.join(rootDir, "turns");
  const sessionRoot = path.join(turnsRoot, "sessions", repoArtifact.metadata.session_id);
  const repoRoot = path.join(sessionRoot, repoArtifact.repoKey);

  writeText(path.join(repoRoot, "latest.patch"), repoArtifact.patchText);
  writeJson(path.join(repoRoot, "latest.json"), repoArtifact.metadata);

  if (workspace) {
    const workspaceRoot = path.join(sessionRoot, "workspace");
    writeText(path.join(workspaceRoot, "latest.patch"), workspace.patchText);
    writeJson(path.join(workspaceRoot, "latest.json"), workspace.metadata);
    writeText(path.join(turnsRoot, "latest.patch"), workspace.patchText);
    writeJson(path.join(turnsRoot, "latest.json"), workspace.metadata);
    return;
  }

  writeText(path.join(turnsRoot, "latest.patch"), repoArtifact.patchText);
  writeJson(path.join(turnsRoot, "latest.json"), repoArtifact.metadata);
}

export function writeEmptyLatestArtifact({
  repoRoot,
  repoKey,
  sessionId,
  turnId,
  note,
  hasBashCalls,
}: {
  repoRoot: string;
  repoKey: string;
  sessionId: string;
  turnId: string;
  note?: string;
  hasBashCalls: boolean;
}): void {
  const savedAt = new Date().toISOString();
  const metadata: RepoTurnArtifactMetadata = {
    saved_at: savedAt,
    session_id: sessionId,
    turn_id: turnId,
    source: "last_turn_agent_touched",
    review_source: "last turn (agent-touched)",
    repo_root: repoRoot,
    repo_key: repoKey,
    touched_paths: [],
    has_bash_calls: hasBashCalls,
    note,
    workspace: false,
  };
  const { rootDir } = resolveDiffReviewRootForWrite({ repoRoot });
  const turnsRoot = path.join(rootDir, "turns");
  writeText(path.join(turnsRoot, "latest.patch"), "");
  writeJson(path.join(turnsRoot, "latest.json"), metadata);
}
