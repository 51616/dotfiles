import { createHash } from "node:crypto";
import fs from "node:fs";
import { TextDecoder } from "node:util";
import {
  MAX_FILE_BYTES_FOR_CONTENT,
  MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO,
  MAX_TOUCHED_PATHS_PER_REPO,
  type FileImage,
  type OmitReason,
  type RepoTurnState,
} from "./types.ts";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

export function captureFileImage(repoState: RepoTurnState, absolutePath: string, phase: "pre" | "post"): FileImage {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { kind: "missing", exists: false };
    }
    return omitted(phase === "pre" ? "read_error_pre" : "read_error_post");
  }

  if (!stat.isFile()) {
    return omitted(phase === "pre" ? "read_error_pre" : "read_error_post", stat);
  }
  if (stat.size > MAX_FILE_BYTES_FOR_CONTENT) return omitted("too_large", stat);
  if (repoState.touchedPaths.size > MAX_TOUCHED_PATHS_PER_REPO) return omitted("total_cap_exceeded", stat);
  if (repoState.capturedBytes + stat.size > MAX_TOTAL_BYTES_FOR_CONTENT_PER_REPO) return omitted("total_cap_exceeded", stat);

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

  repoState.capturedBytes += bytes.length;
  return {
    kind: "content",
    exists: true,
    text,
    sizeBytes: bytes.length,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(bytes),
  };
}
