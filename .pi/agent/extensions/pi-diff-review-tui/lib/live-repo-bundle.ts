import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildFileKey, parseSingleFilePatch, splitPatchIntoFileSections } from "./diff-parser.ts";
import { buildBundleFromPatchText, getHeadHash, parseNameStatus, runGit } from "./git.ts";
import type { DiffBundle } from "./types.ts";

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

async function getWorkspacePaths(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await runGit(pi, repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"], true);
  return [...new Set(output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => fs.existsSync(path.join(repoRoot, filePath))))].sort((left, right) => left.localeCompare(right));
}

function mergePatchTexts(primary: string, supplement: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();

  for (const patchText of [primary, supplement]) {
    for (const section of splitPatchIntoFileSections(patchText)) {
      const fileKey = parseSingleFilePatch({ rawPatch: section }).fileKey;
      if (seen.has(fileKey)) continue;
      seen.add(fileKey);
      sections.push(section.trim());
    }
  }

  return sections.filter(Boolean).join("\n");
}

function mergeNameStatusEntries(primaryOutput: string, supplementOutput: string) {
  const merged = [];
  const seen = new Set<string>();

  for (const entry of [...parseNameStatus(primaryOutput), ...parseNameStatus(supplementOutput)]) {
    const fileKey = buildFileKey(entry.status, entry.oldPath, entry.newPath);
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    merged.push(entry);
  }

  return merged;
}

async function getWorkspacePatchText(pi: ExtensionAPI, repoRoot: string, head: string | null): Promise<string> {
  if (head) {
    const [headTracked, stagedOnlyTracked, untrackedPaths] = await Promise.all([
      runGit(pi, repoRoot, ["diff", "--no-color", "--find-renames", "-M", "--binary", head, "--"], true),
      runGit(pi, repoRoot, ["diff", "--cached", "--no-color", "--find-renames", "-M", "--binary", head, "--"], true),
      getUntrackedPaths(pi, repoRoot),
    ]);
    const untrackedPatches = await Promise.all(untrackedPaths.map((filePath) => getNoIndexPatch(pi, repoRoot, filePath)));
    return [
      mergePatchTexts(headTracked, stagedOnlyTracked),
      ...untrackedPatches.map((text) => text.trim()).filter(Boolean),
    ].filter(Boolean).join("\n");
  }

  const workspacePaths = await getWorkspacePaths(pi, repoRoot);
  const workspacePatches = await Promise.all(workspacePaths.map((filePath) => getNoIndexPatch(pi, repoRoot, filePath)));
  return workspacePatches.map((text) => text.trim()).filter(Boolean).join("\n");
}

async function getWorkspaceNameStatusEntries(pi: ExtensionAPI, repoRoot: string, head: string | null) {
  if (head) {
    const [headTracked, stagedOnlyTracked, untrackedPaths] = await Promise.all([
      runGit(pi, repoRoot, ["diff", "--name-status", "--find-renames", "-M", head, "--"], true),
      runGit(pi, repoRoot, ["diff", "--cached", "--name-status", "--find-renames", "-M", head, "--"], true),
      getUntrackedPaths(pi, repoRoot),
    ]);
    const mergedTracked = mergeNameStatusEntries(headTracked, stagedOnlyTracked);
    const untrackedEntries = untrackedPaths.map((filePath) => ({ status: "A" as const, oldPath: null, newPath: filePath }));
    return [...mergedTracked, ...untrackedEntries];
  }

  const workspacePaths = await getWorkspacePaths(pi, repoRoot);
  return workspacePaths.map((filePath) => ({ status: "A" as const, oldPath: null, newPath: filePath }));
}

export async function getWorkspaceReviewBundle(pi: ExtensionAPI, repoRoot: string): Promise<DiffBundle> {
  const head = await getHeadHash(pi, repoRoot);
  const [patchTextRaw, nameStatusEntries] = await Promise.all([
    getWorkspacePatchText(pi, repoRoot, head),
    getWorkspaceNameStatusEntries(pi, repoRoot, head),
  ]);

  return buildBundleFromPatchText({
    scope: "a",
    repoRoot,
    head,
    patchTextRaw,
    nameStatusEntries,
    sourceKind: "git",
  });
}
