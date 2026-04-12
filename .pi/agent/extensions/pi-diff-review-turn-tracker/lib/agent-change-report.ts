import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  normalizeArtifactPath,
  observedChangedPathsFromPatch,
  parsePatchPaths,
  splitPatchIntoFileSections,
} from "./observed-changed-paths.ts";
import type {
  AgentChangeFile,
  AgentChangeReport,
  AgentChangeReportDraft,
  RepoTurnArtifactMetadata,
  TurnArtifactMetadata,
  WorkspaceTurnArtifactMetadata,
} from "./types.ts";

const MODEL = "gpt-5.3-codex";
const GENERATOR = `codex/${MODEL}`;
const MAX_FILES = 50;
const MAX_TOTAL_CONTEXT_BYTES = 32 * 1024;
const MAX_SUMMARY_CHARS = 240;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS = 5_000;

function logFailure(turnId: string, failureClass: string, detail?: string): void {
  const suffix = detail ? `: ${detail}` : "";
  console.warn(`[pi-diff-review-turn-tracker] turn_id=${turnId} agent_change_report=${failureClass}${suffix}`);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function trimSummary(value: string | undefined): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_SUMMARY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function repoKeysForMetadata(metadata: TurnArtifactMetadata): Set<string> {
  if (!metadata.workspace) return new Set([metadata.repo_key]);
  return new Set((metadata.repos ?? []).map((repo) => repo.repo_key));
}

function hasForbiddenPathSyntax(filePath: string): boolean {
  return filePath.includes(":") || filePath.startsWith(":(");
}

function pathFitsArtifactNamespace(filePath: string, metadata: TurnArtifactMetadata): boolean {
  if (hasForbiddenPathSyntax(filePath)) return false;
  if (!metadata.workspace) return !filePath.startsWith(`${metadata.repo_key}/`);
  const [repoKey, ...rest] = filePath.split("/");
  return rest.length > 0 && repoKeysForMetadata(metadata).has(repoKey ?? "");
}

function validateDraftFiles(files: unknown, metadata: TurnArtifactMetadata): AgentChangeFile[] | null {
  if (!Array.isArray(files)) return null;
  if (files.length > MAX_FILES) return null;

  const normalized: AgentChangeFile[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (!entry || typeof entry !== "object") return null;
    const rawPath = (entry as { path?: unknown }).path;
    if (typeof rawPath !== "string") return null;
    const filePath = normalizeArtifactPath(rawPath);
    if (!filePath || !pathFitsArtifactNamespace(filePath, metadata)) return null;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const summary = trimSummary(typeof (entry as { summary?: unknown }).summary === "string" ? (entry as { summary?: string }).summary : undefined);
    normalized.push(summary ? { path: filePath, summary } : { path: filePath });
  }
  return normalized;
}

function boundedCandidatePaths(metadata: TurnArtifactMetadata): string[] {
  return uniqueSorted([
    ...metadata.touched_paths.slice(0, MAX_FILES),
    ...metadata.observed_changed_paths.slice(0, MAX_FILES),
  ]);
}

function exactMismatches(observedChangedPaths: string[], reportedPaths: string[]): {
  missingFromObserved: string[];
  missingFromAgentReport: string[];
} {
  const observed = new Set(observedChangedPaths);
  const reported = new Set(reportedPaths);
  return {
    missingFromObserved: uniqueSorted([...reported].filter((filePath) => !observed.has(filePath))),
    missingFromAgentReport: uniqueSorted([...observed].filter((filePath) => !reported.has(filePath))),
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("invalid_json");
  }
}

export function buildPersistedAgentChangeReport({
  draft,
  metadata,
  generatedAt,
}: {
  draft: AgentChangeReportDraft;
  metadata: TurnArtifactMetadata;
  generatedAt: string;
}): AgentChangeReport | null {
  const observedChangedPaths = uniqueSorted(metadata.observed_changed_paths ?? observedChangedPathsFromPatch(""));
  const files = validateDraftFiles(draft.files, metadata);
  if (!files) return null;
  if (!observedChangedPaths.length && files.length) return null;

  const candidatePaths = new Set(boundedCandidatePaths(metadata));
  if (files.some((entry) => !candidatePaths.has(entry.path))) return null;

  const mismatches = exactMismatches(observedChangedPaths, files.map((entry) => entry.path));
  const generator = trimSummary(typeof draft.generator === "string" ? draft.generator : GENERATOR) ?? GENERATOR;
  return {
    generated_at: generatedAt,
    generator,
    files,
    missing_from_observed: mismatches.missingFromObserved,
    missing_from_agent_report: mismatches.missingFromAgentReport,
  };
}

function omittedPathLines(metadata: RepoTurnArtifactMetadata | WorkspaceTurnArtifactMetadata): string[] {
  const lines: string[] = [];
  for (const [filePath, info] of Object.entries(metadata.omitted_paths ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`${filePath} (${info.reason}${info.size_bytes != null ? `, size=${info.size_bytes}` : ""})`);
  }
  if (metadata.workspace) {
    for (const repo of metadata.repos ?? []) {
      for (const [filePath, info] of Object.entries(repo.omitted_paths ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
        lines.push(`${repo.repo_key}/${filePath} (${info.reason}${info.size_bytes != null ? `, size=${info.size_bytes}` : ""})`);
      }
    }
  }
  return lines;
}

function boundedPatchSections(patchText: string): Array<{ path: string; patch: string }> {
  const sections = splitPatchIntoFileSections(patchText);
  const selected: Array<{ path: string; patch: string }> = [];
  let usedBytes = 0;

  for (const section of sections) {
    const { oldPath, newPath } = parsePatchPaths(section);
    const filePath = newPath ?? oldPath;
    if (!filePath) continue;
    if (selected.length >= MAX_FILES) break;

    const sectionText = section.trim();
    if (!sectionText) continue;
    const remaining = MAX_TOTAL_CONTEXT_BYTES - usedBytes;
    if (remaining <= 0) break;

    const clipped = Buffer.from(sectionText, "utf8");
    const next = clipped.length <= remaining ? sectionText : clipped.subarray(0, Math.max(0, remaining)).toString("utf8");
    if (!next.trim()) break;
    selected.push({ path: filePath, patch: next.trimEnd() });
    usedBytes += Buffer.byteLength(next, "utf8");
  }

  return selected;
}

export function buildSummarizerPayload({
  metadata,
  patchText,
}: {
  metadata: TurnArtifactMetadata;
  patchText: string;
}): {
  turn_id: string;
  review_source: string;
  touched_paths: string[];
  observed_changed_paths: string[];
  omitted_paths: string[];
  patch_sections: Array<{ path: string; patch: string }>;
  note?: string;
} {
  return {
    turn_id: metadata.turn_id,
    review_source: metadata.review_source,
    touched_paths: metadata.touched_paths.slice(0, MAX_FILES),
    observed_changed_paths: metadata.observed_changed_paths.slice(0, MAX_FILES),
    omitted_paths: omittedPathLines(metadata).slice(0, MAX_FILES),
    patch_sections: boundedPatchSections(patchText),
    note: metadata.note,
  };
}

function codexPrompt(payload: ReturnType<typeof buildSummarizerPayload>): string {
  return [
    "You are generating an advisory changed-file report for pi diff review.",
    "Work only from the serialized payload below. Do not inspect the repo or filesystem.",
    "Return strict JSON only. No markdown. No code fences.",
    `Use this exact schema: {\"generator\":\"${GENERATOR}\",\"files\":[{\"path\":\"...\",\"summary\":\"...\"}]}`,
    "Rules:",
    "- files must be a subset of candidate paths implied by touched_paths and observed_changed_paths.",
    "- paths must stay in the provided artifact namespace.",
    "- no absolute paths, no ./ prefixes, no ../ escapes.",
    `- at most ${MAX_FILES} files.`,
    `- each summary must be <= ${MAX_SUMMARY_CHARS} characters.`,
    "- if observed_changed_paths is empty, return an empty files array.",
    "- you may omit summary when the payload is too weak to support one.",
    "Payload:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

async function runCodexPrompt({ prompt, timeoutMs }: { prompt: string; timeoutMs: number }): Promise<{ ok: true; message: string } | { ok: false; failureClass: string; detail?: string }> {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-change-report-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "-m",
          MODEL,
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          prompt,
        ],
        {
          cwd: tempCwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let lastMessage = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
            if (event.type !== "item.completed") continue;
            if (event.item?.type !== "agent_message") continue;
            if (typeof event.item.text === "string") lastMessage = event.item.text;
          } catch {
            // ignore malformed JSONL fragments from the helper stream
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, failureClass: "spawn_failed", detail: error.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ ok: false, failureClass: "timeout" });
          return;
        }
        if (code !== 0) {
          resolve({ ok: false, failureClass: "subprocess_failed", detail: stderr.trim() || `codex exited with ${code}` });
          return;
        }
        if (!lastMessage.trim()) {
          resolve({ ok: false, failureClass: "empty_response" });
          return;
        }
        resolve({ ok: true, message: lastMessage });
      });
    });
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
}

function repoRootsForMetadata(metadata: TurnArtifactMetadata): string[] {
  if (!metadata.workspace) return [metadata.repo_root];
  return (metadata.repos ?? []).map((repo) => repo.repo_root);
}

function gitStatusSnapshot(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_GIT_SNAPSHOT_TIMEOUT_MS,
  });
  if (result.error?.name === "Error" && /timed out/i.test(result.error.message)) return "__STATUS_TIMEOUT__";
  if (result.status !== 0) return `__STATUS_FAILED__${result.stderr.trim()}`;
  return result.stdout.replace(/\r\n/g, "\n");
}

function captureWorkspaceSnapshot(repoRoots: string[]): Map<string, string> {
  return new Map(repoRoots.map((repoRoot) => [repoRoot, gitStatusSnapshot(repoRoot)]));
}

function snapshotHasFailure(snapshot: Map<string, string>): boolean {
  return [...snapshot.values()].some((value) => value.startsWith("__STATUS_"));
}

function workspaceChanged(before: Map<string, string>, after: Map<string, string>): boolean {
  for (const [repoRoot, status] of before.entries()) {
    if ((after.get(repoRoot) ?? "") !== status) return true;
  }
  return false;
}

export async function summarizeAgentChangeArtifact({
  metadata,
  patchText,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  metadata: TurnArtifactMetadata;
  patchText: string;
  timeoutMs?: number;
}): Promise<AgentChangeReport | null> {
  const payload = buildSummarizerPayload({ metadata, patchText });
  const repoRoots = repoRootsForMetadata(metadata);
  const before = captureWorkspaceSnapshot(repoRoots);
  if (snapshotHasFailure(before)) {
    logFailure(metadata.turn_id, "workspace_snapshot_failed", "before-codex");
    return null;
  }

  const result = await runCodexPrompt({ prompt: codexPrompt(payload), timeoutMs });
  const after = captureWorkspaceSnapshot(repoRoots);
  if (snapshotHasFailure(after)) {
    logFailure(metadata.turn_id, "workspace_snapshot_failed", "after-codex");
    return null;
  }

  if (workspaceChanged(before, after)) {
    logFailure(metadata.turn_id, "workspace_changed");
    return null;
  }
  if (!result.ok) {
    logFailure(metadata.turn_id, result.failureClass, result.detail);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonObject(result.message);
  } catch (error) {
    logFailure(metadata.turn_id, "invalid_json", error instanceof Error ? error.message : String(error));
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    logFailure(metadata.turn_id, "invalid_schema", "expected object response");
    return null;
  }

  const persisted = buildPersistedAgentChangeReport({
    draft: {
      generator: typeof (parsed as { generator?: unknown }).generator === "string"
        ? (parsed as { generator: string }).generator
        : GENERATOR,
      files: (parsed as { files?: unknown }).files,
    },
    metadata,
    generatedAt: new Date().toISOString(),
  });
  if (!persisted) {
    logFailure(metadata.turn_id, "invalid_schema", "response did not validate against artifact namespace");
    return null;
  }
  return persisted;
}
