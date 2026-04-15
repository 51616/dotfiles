import { createHash } from "node:crypto";
import fs from "node:fs";
import { TextDecoder } from "node:util";
import {
  MAX_FILE_BYTES_FOR_CONTENT,
  MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO,
  type FileImage,
  type OmitReason,
  type RepoTurnState,
} from "./types.ts";
import { inspectRepoPathForStage, readRepoPath } from "../../lib/pi-diff-review-ssh.ts";
import type { PiSshSession } from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type CaptureOptions = {
  allowContentCapture?: boolean;
  enforceTotalCap?: boolean;
};

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function omitted(reason: OmitReason, stat?: fs.Stats | null, digest?: string): FileImage {
  return {
    kind: "omitted",
    exists: !!stat,
    reason,
    sizeBytes: stat?.size,
    mtimeMs: stat?.mtimeMs,
    sha256: digest,
  };
}

export function chooseOmittedInfo(pre: FileImage, post: FileImage): { reason: OmitReason; size_bytes?: number } | null {
  const preferred = post.kind === "omitted" ? post : pre.kind === "omitted" ? pre : null;
  if (!preferred) return null;
  return {
    reason: preferred.reason,
    size_bytes: preferred.sizeBytes,
  };
}

export function captureFileImage(
  repoState: RepoTurnState,
  absolutePath: string,
  phase: "pre" | "post",
  options?: CaptureOptions,
): FileImage {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing", exists: false };
    }
    return omitted(phase === "pre" ? "read_error_pre" : "read_error_post");
  }

  if (!stat.isFile()) {
    return omitted("non_file", stat);
  }
  if (stat.size > MAX_FILE_BYTES_FOR_CONTENT) return omitted("too_large", stat);
  if (options?.allowContentCapture === false) return omitted("total_cap_exceeded", stat);
  if ((options?.enforceTotalCap ?? true) && repoState.capturedBytes + stat.size > MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO) {
    return omitted("total_cap_exceeded", stat);
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch {
    return omitted(phase === "pre" ? "read_error_pre" : "read_error_post", stat);
  }

  if (bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) {
    return omitted("binary", stat, sha256(bytes));
  }

  let text = "";
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return omitted("binary", stat, sha256(bytes));
  }

  if (options?.enforceTotalCap ?? true) {
    repoState.capturedBytes += bytes.length;
  }

  return {
    kind: "content",
    exists: true,
    text,
    sizeBytes: bytes.length,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(bytes),
  };
}

export async function captureFileImageRemote(
  repoState: RepoTurnState,
  session: PiSshSession,
  repoRoot: string,
  repoRelPath: string,
  phase: "pre" | "post",
  options?: CaptureOptions,
): Promise<FileImage> {
  const readErrorReason: OmitReason = phase === "pre" ? "read_error_pre" : "read_error_post";

  let st: { exists: boolean; isFile: boolean; isSymlink: boolean; linkCount: number | null; sizeBytes: number | null; mtimeMs: number | null };
  try {
    st = await inspectRepoPathForStage(session, repoRoot, repoRelPath);
  } catch {
    return omitted(readErrorReason);
  }

  if (!st.exists) return { kind: "missing", exists: false };
  const size = typeof st.sizeBytes === "number" ? st.sizeBytes : undefined;
  if (!st.isFile || st.isSymlink) {
    return { kind: "omitted", exists: true, reason: "non_file", sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }
  if (typeof size === "number" && size > MAX_FILE_BYTES_FOR_CONTENT) {
    return { kind: "omitted", exists: true, reason: "too_large", sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }
  if (options?.allowContentCapture === false) {
    return { kind: "omitted", exists: true, reason: "total_cap_exceeded", sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }
  if ((options?.enforceTotalCap ?? true) && typeof size === "number" && repoState.capturedBytes + size > MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO) {
    return { kind: "omitted", exists: true, reason: "total_cap_exceeded", sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }

  let read: { exists: boolean; bytes: Buffer; truncated: boolean };
  try {
    read = await readRepoPath(session, repoRoot, repoRelPath, MAX_FILE_BYTES_FOR_CONTENT);
  } catch {
    return { kind: "omitted", exists: true, reason: readErrorReason, sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }

  if (!read.exists) return { kind: "missing", exists: false };
  if (read.truncated) {
    return { kind: "omitted", exists: true, reason: "too_large", sizeBytes: size, mtimeMs: st.mtimeMs ?? undefined };
  }

  const bytes = read.bytes;
  if (bytes.subarray(0, Math.min(bytes.length, 1024)).includes(0)) {
    return {
      kind: "omitted",
      exists: true,
      reason: "binary",
      sizeBytes: bytes.length,
      mtimeMs: st.mtimeMs ?? undefined,
      sha256: sha256(bytes),
    };
  }

  let text = "";
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return {
      kind: "omitted",
      exists: true,
      reason: "binary",
      sizeBytes: bytes.length,
      mtimeMs: st.mtimeMs ?? undefined,
      sha256: sha256(bytes),
    };
  }

  if (options?.enforceTotalCap ?? true) {
    repoState.capturedBytes += bytes.length;
  }

  return {
    kind: "content",
    exists: true,
    text,
    sizeBytes: bytes.length,
    mtimeMs: typeof st.mtimeMs === "number" ? st.mtimeMs : Date.now(),
    sha256: sha256(bytes),
  };
}
