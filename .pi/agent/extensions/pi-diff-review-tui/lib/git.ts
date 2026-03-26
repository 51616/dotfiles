import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildFileKey, parsePatchPaths, parseSingleFilePatch, sha256, splitPatchIntoFileSections } from "./diff-parser.ts";
import type { DiffBundle, DiffScope, FileStatus, ParsedFilePatch, TurnSourceMetadata } from "./types.ts";
import { resolveTurnLatestCandidates } from "./diff-review-paths.ts";

interface NameStatusEntry {
  status: FileStatus;
  oldPath: string | null;
  newPath: string | null;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[], allowFailure = false): Promise<string> {
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

function parseNameStatus(output: string): NameStatusEntry[] {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => parseNameStatusLine(line))
    .filter((entry): entry is NameStatusEntry => Boolean(entry));
}

async function getUntrackedPaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await runGit(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"], true);
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getNoIndexPatch(pi: ExtensionAPI, repoRoot: string, filePath: string): Promise<string> {
  const result = await pi.exec("git", ["diff", "--no-index", "--no-color", "--binary", "--", "/dev/null", filePath], { cwd: repoRoot });
  return result.stdout.replace(/\r\n/g, "\n").trim();
}

async function getPatchText(pi: ExtensionAPI, repoRoot: string, scope: Exclude<DiffScope, "t">, head: string | null): Promise<string> {
  if (scope === "u") {
    const tracked = await runGit(pi, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", "--"], true);
    const untrackedPaths = await getUntrackedPaths(pi, repoRoot);
    const untrackedPatches = await Promise.all(untrackedPaths.map((filePath) => getNoIndexPatch(pi, repoRoot, filePath)));
    return [tracked.trim(), ...untrackedPatches.map((text) => text.trim()).filter(Boolean)].filter(Boolean).join("\n");
  }

  if (scope === "s") {
    const args = ["diff", "--cached", "--no-color", "--find-renames", "-M", "--binary"];
    if (!head) args.push("--root");
    args.push("--");
    return runGit(pi, repoRoot, args, true);
  }

  if (head) {
    const tracked = await runGit(pi, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", head, "--"], true);
    const untrackedPaths = await getUntrackedPaths(pi, repoRoot);
    const untrackedPatches = await Promise.all(untrackedPaths.map((filePath) => getNoIndexPatch(pi, repoRoot, filePath)));
    return [tracked.trim(), ...untrackedPatches.map((text) => text.trim()).filter(Boolean)].filter(Boolean).join("\n");
  }

  const staged = await getPatchText(pi, repoRoot, "s", head);
  const unstaged = await getPatchText(pi, repoRoot, "u", head);
  return [staged.trim(), unstaged.trim()].filter(Boolean).join("\n");
}

async function getNameStatusText(pi: ExtensionAPI, repoRoot: string, scope: Exclude<DiffScope, "t">, head: string | null): Promise<string> {
  if (scope === "u") {
    const tracked = await runGit(pi, repoRoot, ["diff", "--name-status", "--find-renames", "-M", "--"], true);
    const untrackedPaths = await getUntrackedPaths(pi, repoRoot);
    const untrackedLines = untrackedPaths.map((filePath) => `A\t${filePath}`).join("\n");
    return [tracked.trim(), untrackedLines].filter(Boolean).join("\n");
  }

  if (scope === "s") {
    const args = ["diff", "--cached", "--name-status", "--find-renames", "-M"];
    if (!head) args.push("--root");
    args.push("--");
    return runGit(pi, repoRoot, args, true);
  }

  if (head) {
    const tracked = await runGit(pi, repoRoot, ["diff", "--name-status", "--find-renames", "-M", head, "--"], true);
    const untrackedPaths = await getUntrackedPaths(pi, repoRoot);
    const untrackedLines = untrackedPaths.map((filePath) => `A\t${filePath}`).join("\n");
    return [tracked.trim(), untrackedLines].filter(Boolean).join("\n");
  }

  const staged = await getNameStatusText(pi, repoRoot, "s", head);
  const unstaged = await getNameStatusText(pi, repoRoot, "u", head);
  return [staged.trim(), unstaged.trim()].filter(Boolean).join("\n");
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

export function summarizeFileHashChanges(before: Map<string, string>, after: Map<string, string>): {
  changed: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
} {
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

function buildBundleFromPatchText({
  scope,
  repoRoot,
  head,
  patchTextRaw,
  nameStatusEntries,
  sourceKind,
  turnMetadata,
}: {
  scope: DiffScope;
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
  const fileHashes = new Map<string, string>(mergedFiles.map((file) => [file.fileKey, hashText(file.rawPatch)]));
  const fingerprint = sha256(JSON.stringify({ scope, sourceKind, files: [...fileHashes.entries()], turnId: turnMetadata?.turn_id ?? null }));

  return {
    scope,
    repoRoot,
    head,
    files: mergedFiles,
    patchText,
    fingerprint,
    fileHashes,
    loadedAt: new Date().toISOString(),
    sourceKind,
    sourceLabel: sourceKind === "turn" ? "last turn (agent-touched)" : undefined,
    turnMetadata: turnMetadata ?? null,
  };
}

function latestTurnCandidates(repoRoot: string): Array<{ patchPath: string; jsonPath: string }> {
  return resolveTurnLatestCandidates({ repoRoot });
}

export function readLatestTurnArtifact(repoRoot: string, sessionId: string): { patchText: string; metadata: TurnSourceMetadata } | null {
  if (!sessionId.trim()) return null;
  for (const { patchPath, jsonPath } of latestTurnCandidates(repoRoot)) {
    if (!fs.existsSync(jsonPath)) continue;

    try {
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as TurnSourceMetadata;
      if (metadata.session_id != sessionId) continue;
      const patchText = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, "utf8") : "";
      return { patchText, metadata };
    } catch {
      // ignore and continue
    }
  }

  return null;
}

export function getLatestTurnBundle(repoRoot: string, sessionId: string): DiffBundle | null {
  const artifact = readLatestTurnArtifact(repoRoot, sessionId);
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

export async function getDiffBundle(
  pi: ExtensionAPI,
  repoRoot: string,
  scope: DiffScope,
  options?: { sessionId?: string },
): Promise<DiffBundle> {
  if (scope === "t") {
    const bundle = getLatestTurnBundle(repoRoot, options?.sessionId ?? "");
    if (bundle) return bundle;
    return buildBundleFromPatchText({
      scope: "t",
      repoRoot,
      head: null,
      patchTextRaw: "",
      sourceKind: "turn",
      turnMetadata: null,
    });
  }

  const head = await getHeadHash(pi, repoRoot);
  const [patchTextRaw, nameStatusRaw] = await Promise.all([
    getPatchText(pi, repoRoot, scope, head),
    getNameStatusText(pi, repoRoot, scope, head),
  ]);

  return buildBundleFromPatchText({
    scope,
    repoRoot,
    head,
    patchTextRaw,
    nameStatusEntries: parseNameStatus(nameStatusRaw),
    sourceKind: "git",
  });
}
