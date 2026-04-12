import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildFileKey, parsePatchPaths, parseSingleFilePatch, sha256, splitPatchIntoFileSections } from "./diff-parser.ts";
import type { ChangeSummary, DiffBundle, FileStatus, ParsedFilePatch, TurnSourceMetadata } from "./types.ts";

interface NameStatusEntry {
  status: FileStatus;
  oldPath: string | null;
  newPath: string | null;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[], allowFailure = false): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    if (allowFailure) return "";
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

export async function getHeadHash(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

function parseNameStatusLine(line: string): NameStatusEntry | null {
  if (!line.trim()) return null;
  const parts = line.split("\t");
  const rawStatus = parts[0] ?? "";
  const code = rawStatus[0] ?? "M";

  if (code === "R") {
    return {
      status: "R",
      oldPath: parts[1] ?? null,
      newPath: parts[2] ?? null,
    };
  }

  if (code === "A") return { status: "A", oldPath: null, newPath: parts[1] ?? null };
  if (code === "D") return { status: "D", oldPath: parts[1] ?? null, newPath: null };
  return { status: "M", oldPath: parts[1] ?? null, newPath: parts[1] ?? null };
}

export function parseNameStatus(output: string): NameStatusEntry[] {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => parseNameStatusLine(line))
    .filter((entry): entry is NameStatusEntry => Boolean(entry));
}

function matchNameStatus(
  entries: NameStatusEntry[],
  oldPath: string | null,
  newPath: string | null,
  rawPatch: string,
): NameStatusEntry {
  const exact = entries.find((entry) => entry.oldPath === oldPath && entry.newPath === newPath);
  if (exact) return exact;

  const byNew = entries.find((entry) => entry.newPath != null && entry.newPath === newPath);
  if (byNew) return byNew;

  const byOld = entries.find((entry) => entry.oldPath != null && entry.oldPath === oldPath);
  if (byOld) return byOld;

  const inferred = parseSingleFilePatch({ rawPatch });
  return {
    status: inferred.status,
    oldPath: inferred.oldPath,
    newPath: inferred.newPath,
  };
}

function mergeDuplicateFiles(files: ParsedFilePatch[]): ParsedFilePatch[] {
  const byKey = new Map<string, ParsedFilePatch>();

  for (const file of files) {
    const existing = byKey.get(file.fileKey);
    if (!existing) {
      byKey.set(file.fileKey, file);
      continue;
    }

    const mergedPatch = [existing.rawPatch, file.rawPatch].filter(Boolean).join("\n");
    byKey.set(
      file.fileKey,
      parseSingleFilePatch({
        rawPatch: mergedPatch,
        status: file.status,
        oldPath: file.oldPath,
        newPath: file.newPath,
      }),
    );
  }

  return Array.from(byKey.values()).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function shouldHideFromReview(file: ParsedFilePatch, sourceKind: "git" | "turn"): boolean {
  if (sourceKind !== "git") return false;
  if (file.status !== "A" || file.isBinary) return false;
  if (file.hunks.length > 0 || file.changeBlocks.length > 0) return false;
  return file.rows.every((row) => row.kind === "meta");
}

function humanizeFileKey(key: string): string {
  const colon = key.indexOf(":");
  const body = colon >= 0 ? key.slice(colon + 1) : key;
  const arrow = body.indexOf("->");
  if (arrow < 0) return body;
  const oldPath = body.slice(0, arrow);
  const newPath = body.slice(arrow + 2);
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} → ${newPath}`;
  return newPath || oldPath || body;
}

export function summarizeFileHashChanges(before: Map<string, string>, after: Map<string, string>): ChangeSummary {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  for (const key of [...keys].sort()) {
    const label = humanizeFileKey(key);
    const prev = before.get(key);
    const next = after.get(key);
    if (prev == null && next != null) {
      added.push(label);
      continue;
    }
    if (prev != null && next == null) {
      removed.push(label);
      continue;
    }
    if (prev === next) unchanged.push(label);
    else changed.push(label);
  }

  return { changed, added, removed, unchanged };
}

export function observedChangedPathsFromPatchText(patchText: string): string[] {
  const seen = new Set<string>();
  const observed: string[] = [];
  for (const section of splitPatchIntoFileSections(patchText)) {
    const { oldPath, newPath } = parsePatchPaths(section);
    const observedPath = newPath ?? oldPath;
    if (!observedPath || seen.has(observedPath)) continue;
    seen.add(observedPath);
    observed.push(observedPath);
  }
  return observed;
}

export function buildBundleFromPatchText({
  scope,
  repoRoot,
  head,
  patchTextRaw,
  nameStatusEntries,
  sourceKind,
  turnMetadata,
}: {
  scope: DiffBundle["scope"];
  repoRoot: string;
  head: string | null;
  patchTextRaw: string;
  nameStatusEntries?: NameStatusEntry[];
  sourceKind: "git" | "turn";
  turnMetadata?: TurnSourceMetadata | null;
}): DiffBundle {
  const patchText = patchTextRaw.replace(/\r\n/g, "\n").trim();
  const sections = splitPatchIntoFileSections(patchText);
  const files: ParsedFilePatch[] = [];
  const seenKeys = new Set<string>();

  for (const section of sections) {
    const { oldPath, newPath } = parsePatchPaths(section);
    const matched = nameStatusEntries ? matchNameStatus(nameStatusEntries, oldPath, newPath, section) : null;
    const file = parseSingleFilePatch({
      rawPatch: section,
      status: matched?.status,
      oldPath: matched?.oldPath ?? oldPath,
      newPath: matched?.newPath ?? newPath,
    });
    files.push(file);
    seenKeys.add(file.fileKey);
  }

  for (const entry of nameStatusEntries ?? []) {
    const key = buildFileKey(entry.status, entry.oldPath, entry.newPath);
    if (seenKeys.has(key)) continue;
    const syntheticPatch = [
      `diff --git a/${entry.oldPath ?? entry.newPath ?? "unknown"} b/${entry.newPath ?? entry.oldPath ?? "unknown"}`,
      entry.oldPath == null ? "--- /dev/null" : `--- a/${entry.oldPath}`,
      entry.newPath == null ? "+++ /dev/null" : `+++ b/${entry.newPath}`,
    ].join("\n");
    files.push(parseSingleFilePatch({
      rawPatch: syntheticPatch,
      status: entry.status,
      oldPath: entry.oldPath,
      newPath: entry.newPath,
    }));
  }

  const mergedFiles = mergeDuplicateFiles(files);
  const visibleFiles = mergedFiles.filter((file) => !shouldHideFromReview(file, sourceKind));
  const fileHashes = new Map<string, string>(visibleFiles.map((file) => [file.fileKey, hashText(file.rawPatch)]));
  const fingerprint = sha256(JSON.stringify({ scope, sourceKind, files: [...fileHashes.entries()], turnId: turnMetadata?.turn_id ?? null }));

  return {
    scope,
    repoRoot,
    head,
    files: visibleFiles,
    patchText,
    fingerprint,
    fileHashes,
    loadedAt: new Date().toISOString(),
    sourceKind,
    sourceLabel: sourceKind === "turn" ? "last turn (agent-touched)" : undefined,
    turnMetadata: turnMetadata ?? null,
  };
}
