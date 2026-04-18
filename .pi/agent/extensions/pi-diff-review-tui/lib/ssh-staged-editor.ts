import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TUI } from "@mariozechner/pi-tui";
import {
  compareAndWriteRepoPath,
  inspectRepoPathForStage,
  readRepoPath,
  type DiffReviewSshIdentity,
} from "../../lib/pi-diff-review-ssh.ts";
import { resolveDiffReviewRootForWrite } from "./diff-review-paths.ts";
import { openExternalEditorPath } from "./external-editor.ts";

const MAX_STAGED_EDIT_BYTES = 4 * 1024 * 1024;

export type PreparedSshEditorStage = {
  repoRelPath: string;
  stagePath: string;
  baselineBytes: Buffer;
  sizeBytes: number | null;
  mtimeMs: number | null;
};

export type SshStagedEditorResult = {
  status: number | null;
  changed: boolean;
  uploaded: boolean;
  conflict: boolean;
  stagePath: string;
};

export class SshStagedEditorError extends Error {
  readonly stagePath?: string;

  constructor(message: string, options: { stagePath?: string } = {}) {
    super(message);
    this.name = "SshStagedEditorError";
    this.stagePath = options.stagePath;
  }
}

function stageRoot(scopeKey: string): string {
  return path.join(resolveDiffReviewRootForWrite({
    repoRoot: "/ssh-diff-review",
    scopeKey,
    allowRepoRoot: false,
  }).rootDir, "edit-stage");
}

function sanitizeStagePathSegment(value: string, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\\/]+/g, "__")
    .replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!normalized || normalized === "." || normalized === "..") {
    return fallback;
  }
  return normalized;
}

function normalizeStageRelativePath(repoRelPath: string): string {
  const normalized = String(repoRelPath ?? "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid SSH staged editor repo path: ${repoRelPath}`);
  }
  return path.join(...parts);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

function assertTextLike(bytes: Buffer, repoRelPath: string, stagePath?: string): void {
  if (!looksBinary(bytes)) {
    return;
  }
  const suffix = stagePath ? ` Kept the staged copy at ${stagePath}.` : "";
  throw new SshStagedEditorError(`Refusing to edit a binary-looking file over SSH: ${repoRelPath}.${suffix}`, { stagePath });
}

export function resolveSshEditorStagePath({
  scopeKey,
  sessionId,
  repoRelPath,
}: {
  scopeKey: string;
  sessionId: string;
  repoRelPath: string;
}): string {
  return path.join(
    stageRoot(scopeKey),
    "sessions",
    sanitizeStagePathSegment(sessionId, "anonymous"),
    normalizeStageRelativePath(repoRelPath),
  );
}

async function cleanupStageFile(stagePath: string): Promise<void> {
  await fs.rm(stagePath, { force: true });
}

export async function disposePreparedSshEditorStage(stage: PreparedSshEditorStage | null | undefined): Promise<void> {
  if (!stage) return;
  await cleanupStageFile(stage.stagePath);
}

async function resolveWritableStagePath(stagePath: string): Promise<string> {
  try {
    await fs.access(stagePath);
  } catch {
    return stagePath;
  }

  const parsed = path.parse(stagePath);
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}__retry_${Date.now()}_${attempt}${parsed.ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }

  throw new Error(`Could not allocate a unique SSH staged editor path for ${stagePath}`);
}

async function prepareRemoteStageProbe(ssh: DiffReviewSshIdentity, repoRelPath: string): Promise<{ exists: boolean; isFile: boolean; isSymlink: boolean; linkCount: number | null; sizeBytes: number | null; mtimeMs: number | null }> {
  const remoteProbe = await inspectRepoPathForStage(ssh.session, ssh.repoRoot, repoRelPath);
  if (!remoteProbe.exists) {
    throw new Error(`Remote file no longer exists: ${repoRelPath}`);
  }
  if (remoteProbe.isSymlink) {
    throw new Error(`Refusing to stage a symlinked remote file over SSH edit: ${repoRelPath}`);
  }
  if (!remoteProbe.isFile) {
    throw new Error(`Refusing to stage a non-file remote path over SSH edit: ${repoRelPath}`);
  }
  if ((remoteProbe.linkCount ?? 0) > 1) {
    throw new Error(`Refusing to stage a hardlinked remote file over SSH edit: ${repoRelPath}`);
  }
  if (typeof remoteProbe.sizeBytes === "number" && remoteProbe.sizeBytes > MAX_STAGED_EDIT_BYTES) {
    throw new Error(`Remote file is too large to stage locally (> ${MAX_STAGED_EDIT_BYTES} bytes): ${repoRelPath}`);
  }
  return remoteProbe;
}

export async function prepareRemoteFileStage({
  ssh,
  sessionId,
  repoRelPath,
}: {
  ssh: DiffReviewSshIdentity;
  sessionId: string;
  repoRelPath: string;
}): Promise<PreparedSshEditorStage> {
  const remoteProbe = await prepareRemoteStageProbe(ssh, repoRelPath);
  const baseline = await readRepoPath(ssh.session, ssh.repoRoot, repoRelPath, MAX_STAGED_EDIT_BYTES + 1);
  if (!baseline.exists) {
    throw new Error(`Remote file no longer exists: ${repoRelPath}`);
  }
  if (baseline.truncated) {
    throw new Error(`Remote file is too large to stage locally (> ${MAX_STAGED_EDIT_BYTES} bytes): ${repoRelPath}`);
  }
  assertTextLike(baseline.bytes, repoRelPath);

  const stagePath = await resolveWritableStagePath(resolveSshEditorStagePath({
    scopeKey: ssh.scopeKey,
    sessionId,
    repoRelPath,
  }));
  await fs.mkdir(path.dirname(stagePath), { recursive: true });
  await fs.writeFile(stagePath, baseline.bytes);
  return {
    repoRelPath,
    stagePath,
    baselineBytes: baseline.bytes,
    sizeBytes: remoteProbe.sizeBytes,
    mtimeMs: remoteProbe.mtimeMs,
  };
}

async function canReusePreparedStage({
  ssh,
  repoRelPath,
  preparedStage,
}: {
  ssh: DiffReviewSshIdentity;
  repoRelPath: string;
  preparedStage: PreparedSshEditorStage;
}): Promise<boolean> {
  if (preparedStage.repoRelPath !== repoRelPath) {
    return false;
  }
  const remoteProbe = await prepareRemoteStageProbe(ssh, repoRelPath);
  return remoteProbe.sizeBytes === preparedStage.sizeBytes && remoteProbe.mtimeMs === preparedStage.mtimeMs;
}

async function resolvePreparedStageForEdit({
  ssh,
  sessionId,
  repoRelPath,
  preparedStage,
}: {
  ssh: DiffReviewSshIdentity;
  sessionId: string;
  repoRelPath: string;
  preparedStage?: PreparedSshEditorStage;
}): Promise<PreparedSshEditorStage> {
  if (preparedStage) {
    const reusable = await canReusePreparedStage({ ssh, repoRelPath, preparedStage }).catch(() => false);
    if (reusable) {
      await fs.mkdir(path.dirname(preparedStage.stagePath), { recursive: true });
      await fs.writeFile(preparedStage.stagePath, preparedStage.baselineBytes);
      return preparedStage;
    }
    await disposePreparedSshEditorStage(preparedStage);
  }
  return prepareRemoteFileStage({ ssh, sessionId, repoRelPath });
}

export async function editRemoteFileViaLocalStage({
  tui,
  ssh,
  sessionId,
  repoRelPath,
  line,
  lineTargeted,
  preparedStage,
  openEditor = openExternalEditorPath,
}: {
  tui: TUI;
  ssh: DiffReviewSshIdentity;
  sessionId: string;
  repoRelPath: string;
  line?: number | null;
  lineTargeted: boolean;
  preparedStage?: PreparedSshEditorStage;
  openEditor?: typeof openExternalEditorPath;
}): Promise<SshStagedEditorResult> {
  const prepared = await resolvePreparedStageForEdit({ ssh, sessionId, repoRelPath, preparedStage });
  const stagePath = prepared.stagePath;
  const baselineBytes = prepared.baselineBytes;

  const result = openEditor({
    tui,
    filePath: stagePath,
    line,
    lineTargeted,
  });

  const stagedStat = await fs.stat(stagePath).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new SshStagedEditorError(`Could not inspect the staged SSH edit file after the editor closed: ${message}`, { stagePath });
  });
  if (stagedStat.size > MAX_STAGED_EDIT_BYTES) {
    throw new SshStagedEditorError(
      `Refusing to upload an oversized staged SSH edit (> ${MAX_STAGED_EDIT_BYTES} bytes): ${repoRelPath}`,
      { stagePath },
    );
  }

  let stagedBytes: Buffer;
  try {
    stagedBytes = await fs.readFile(stagePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SshStagedEditorError(`Could not read the staged SSH edit file after the editor closed: ${message}`, { stagePath });
  }
  assertTextLike(stagedBytes, repoRelPath, stagePath);
  if (hashBytes(stagedBytes) === hashBytes(baselineBytes)) {
    await cleanupStageFile(stagePath);
    return {
      status: result.status,
      changed: false,
      uploaded: false,
      conflict: false,
      stagePath,
    };
  }

  const writeResult = await compareAndWriteRepoPath(ssh.session, ssh.repoRoot, repoRelPath, baselineBytes, stagedBytes);
  if (writeResult.symlink) {
    throw new SshStagedEditorError(
      `Refusing to overwrite a symlinked remote file via SSH edit: ${repoRelPath}. Kept the staged copy for manual recovery.`,
      { stagePath },
    );
  }
  if (writeResult.hardlink) {
    throw new SshStagedEditorError(
      `Refusing to overwrite a hardlinked remote file via SSH edit: ${repoRelPath}. Kept the staged copy for manual recovery.`,
      { stagePath },
    );
  }
  if (!writeResult.ok) {
    return {
      status: result.status,
      changed: true,
      uploaded: false,
      conflict: true,
      stagePath,
    };
  }

  await cleanupStageFile(stagePath);
  return {
    status: result.status,
    changed: true,
    uploaded: true,
    conflict: false,
    stagePath,
  };
}
