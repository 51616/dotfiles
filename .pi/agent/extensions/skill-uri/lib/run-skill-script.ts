import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join as pathJoin, posix as pathPosix } from "node:path";
import type { SkillStageTransport } from "./backend-runtime.ts";
import { SkillRegistry, parseSkillUri, skillUriToVirtualPath, type ResolvedSkillPath, type SkillEntry } from "./skill-uris.ts";

export type SkillScriptTarget = "local" | "remote";

export interface RunSkillScriptRequest {
  script: string;
  interpreter: string;
  args?: string[];
  target?: SkillScriptTarget;
}

export interface ResolvedRunSkillScriptRequest {
  target: SkillScriptTarget;
  skillUri: string;
  interpreter: string;
  args: string[];
  normalizedRelativePath: string;
  resolvedScript: ResolvedSkillPath;
}

export interface PreparedRunSkillScript {
  target: SkillScriptTarget;
  skillUri: string;
  interpreter: string;
  args: string[];
  executionPath: string;
  staged: boolean;
  stageRoot?: string;
  resolvedScript: ResolvedSkillPath;
}

interface SkillFileEntry {
  relativePath: string;
  content: Buffer;
}

const STAGE_SKIP_NAMES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".ssh", ".aws"]);
const STAGE_SKIP_FILES = new Set([".envrc", ".npmrc", ".pypirc"]);
const MAX_STAGE_BYTES = 10 * 1024 * 1024;
const RUN_SKILL_SCRIPT_URI_EXAMPLE = "skill://pi-ssh/scripts/demo.sh";
const RUN_SKILL_SCRIPT_URI_REQUIRED_ERROR =
  `run_skill_script requires script to be a full skill://<skill-id>/relative/path URI, for example ${RUN_SKILL_SCRIPT_URI_EXAMPLE}. Relative paths like scripts/demo.sh are not allowed.`;

function isLegacySourcePrefixedSkillUri(path: string): boolean {
  return path.startsWith("skill://local/") || path.startsWith("skill://remote/");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Missing ${label}`);
  }
  return trimmed;
}

function normalizeSkillRelativePath(relativePath: string): string {
  const normalized = pathPosix.normalize(relativePath).replace(/^(\.\/)+/, "");
  return normalized === "." ? "" : normalized;
}

function shouldSkipStageFile(name: string): boolean {
  return STAGE_SKIP_FILES.has(name) || name.startsWith(".env");
}

export function resolveRunSkillScriptTarget(hasRemoteBackend: boolean, target?: SkillScriptTarget): SkillScriptTarget {
  if (!target) {
    return hasRemoteBackend ? "remote" : "local";
  }

  if (target !== "local" && target !== "remote") {
    throw new Error(`Unsupported run_skill_script target: ${target}`);
  }

  if (target === "remote" && !hasRemoteBackend) {
    throw new Error("Remote run_skill_script execution requires an active remote backend");
  }

  return target;
}

export function resolveRunSkillScriptRequest(
  request: RunSkillScriptRequest,
  registry: SkillRegistry,
  hasRemoteBackend: boolean,
): ResolvedRunSkillScriptRequest {
  const target = resolveRunSkillScriptTarget(hasRemoteBackend, request.target);
  const script = normalizeTrimmed(request.script, "script");
  const interpreter = normalizeTrimmed(request.interpreter, "interpreter");
  if (/\r|\n/.test(interpreter)) {
    throw new Error("Interpreter must be a single shell command line");
  }

  const args = (request.args ?? []).map((arg) => String(arg));
  if (isLegacySourcePrefixedSkillUri(script)) {
    throw new Error(
      `run_skill_script no longer accepts source-prefixed skill URIs like ${script}. Use skill://<skill-id>/relative/path instead, for example ${RUN_SKILL_SCRIPT_URI_EXAMPLE}.`,
    );
  }
  const parsed = parseSkillUri(script);
  if (!parsed) {
    throw new Error(RUN_SKILL_SCRIPT_URI_REQUIRED_ERROR);
  }

  const normalizedRequestedPath = normalizeSkillRelativePath(parsed.relativePath);
  if (!normalizedRequestedPath) {
    throw new Error(
      `run_skill_script requires script to point to a file under the skill root. Use a URI like ${RUN_SKILL_SCRIPT_URI_EXAMPLE}. Received: ${script}`,
    );
  }

  const resolvedScript = registry.resolveVirtualPath(skillUriToVirtualPath(script));
  if (!resolvedScript) {
    throw new Error(`Unable to resolve skill script URI: ${script}`);
  }

  const normalizedRelativePath = normalizeSkillRelativePath(resolvedScript.relativePath);
  if (!normalizedRelativePath) {
    throw new Error(
      `run_skill_script requires script to point to a file under the skill root. Use a URI like ${RUN_SKILL_SCRIPT_URI_EXAMPLE}. Received: ${script}`,
    );
  }

  return {
    target,
    skillUri: script,
    interpreter,
    args,
    normalizedRelativePath,
    resolvedScript,
  };
}

function isMissingStageMarkerError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("missing") || message.includes("no such file") || message.includes("not found");
}

async function collectLocalSkillFiles(rootPath: string, relativeDir = ""): Promise<SkillFileEntry[]> {
  const currentPath = relativeDir ? pathJoin(rootPath, relativeDir) : rootPath;
  const entries = await readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const files: SkillFileEntry[] = [];
  for (const entry of entries) {
    if (STAGE_SKIP_NAMES.has(entry.name)) continue;

    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectLocalSkillFiles(rootPath, relativePath)));
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`run_skill_script staging does not support symlinks: ${relativePath}`);
    }
    if (!entry.isFile()) continue;
    if (shouldSkipStageFile(entry.name)) continue;

    files.push({
      relativePath,
      content: await readFile(pathJoin(rootPath, relativePath)),
    });
  }

  return files;
}

function hashSkillFiles(files: SkillFileEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function stageLocalSkillRootToRemote(
  skillEntry: SkillEntry,
  remoteHome: string,
  transport: SkillStageTransport,
  signal?: AbortSignal,
): Promise<{ stageRoot: string; staged: boolean }> {
  const files = await collectLocalSkillFiles(skillEntry.rootPath);
  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalBytes > MAX_STAGE_BYTES) {
    throw new Error(`run_skill_script staging exceeds ${MAX_STAGE_BYTES} bytes for ${skillEntry.name}; trim the skill root or stage fewer assets`);
  }

  const contentHash = hashSkillFiles(files);
  const stageRoot = `${remoteHome}/.cache/pi/skill-stage/${skillEntry.encodedId}/${contentHash}`;
  const markerPath = `${stageRoot}/.pi-stage-complete.json`;

  try {
    await transport.readFile(markerPath, signal);
    return { stageRoot, staged: false };
  } catch (error) {
    if (!isMissingStageMarkerError(error)) {
      throw error;
    }
  }

  for (const file of files) {
    await transport.writeFile(`${stageRoot}/${file.relativePath}`, file.content, signal);
  }

  const marker = Buffer.from(
    JSON.stringify(
      {
        skill: skillEntry.name,
        hash: contentHash,
        fileCount: files.length,
      },
      null,
      2,
    ),
    "utf-8",
  );
  await transport.writeFile(markerPath, marker, signal);

  return { stageRoot, staged: true };
}

export async function prepareRunSkillScript(
  request: ResolvedRunSkillScriptRequest,
  options: {
    remoteHome?: string;
    transport?: SkillStageTransport;
    signal?: AbortSignal;
    assertLocalPathSafe?: (rootPath: string, relativePath: string) => Promise<void> | void;
  },
): Promise<PreparedRunSkillScript> {
  await options.assertLocalPathSafe?.(request.resolvedScript.entry.rootPath, request.resolvedScript.relativePath);

  if (request.target === "local") {
    return {
      ...request,
      executionPath: request.resolvedScript.realPath,
      staged: false,
    };
  }

  if (!options.remoteHome || !options.transport) {
    throw new Error("Remote run_skill_script execution requires a remote home and transport");
  }

  const stage = await stageLocalSkillRootToRemote(request.resolvedScript.entry, options.remoteHome, options.transport, options.signal);
  return {
    ...request,
    executionPath: `${stage.stageRoot}/${request.normalizedRelativePath}`,
    staged: stage.staged,
    stageRoot: stage.stageRoot,
  };
}

export function buildRunSkillScriptCommand(interpreter: string, scriptPath: string, args: string[] = []): string {
  const trimmedInterpreter = normalizeTrimmed(interpreter, "interpreter");
  if (/\r|\n/.test(trimmedInterpreter)) {
    throw new Error("Interpreter must be a single shell command line");
  }

  const quotedArgs = [scriptPath, ...args].map((value) => shellQuote(String(value))).join(" ");
  return `${trimmedInterpreter} ${quotedArgs}`;
}
