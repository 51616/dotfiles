import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join as pathJoin, posix as pathPosix } from "node:path";
import type { SkillStageTransport } from "./backend-runtime.ts";
import { SkillRegistry, parseSkillUri, skillUriToVirtualPath, type ResolvedSkillPath, type SkillEntry } from "./skill-uris.ts";

type RunSkillScriptExecutionBackend = "local" | "remote";

export interface RunSkillScriptRequest {
  script: string;
  interpreter: string;
  args?: string[];
}

export interface ResolvedRunSkillScriptRequest {
  executionBackend: RunSkillScriptExecutionBackend;
  skillUri: string;
  interpreter: string;
  args: string[];
  normalizedRelativePath: string;
  resolvedScript: ResolvedSkillPath;
}

export interface PreparedRunSkillScript {
  executionBackend: RunSkillScriptExecutionBackend;
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
export const RUN_SKILL_SCRIPT_TARGET_REMOVED_ERROR =
  "run_skill_script no longer accepts `target`. Execution follows the active backend automatically.";

function isLegacySourcePrefixedSkillUri(path: string): boolean {
  return path.startsWith("skill://local/") || path.startsWith("skill://remote/");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
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

function resolveRunSkillScriptExecutionBackend(hasRemoteBackend: boolean): RunSkillScriptExecutionBackend {
  return hasRemoteBackend ? "remote" : "local";
}

export function resolveRunSkillScriptRequest(
  request: RunSkillScriptRequest,
  registry: SkillRegistry,
  hasRemoteBackend: boolean,
): ResolvedRunSkillScriptRequest {
  const executionBackend = resolveRunSkillScriptExecutionBackend(hasRemoteBackend);
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
    executionBackend,
    skillUri: script,
    interpreter,
    args,
    normalizedRelativePath,
    resolvedScript,
  };
}

function isMissingRemotePathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("missing") || message.includes("no such file") || message.includes("not found");
}

function getFsErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.trim()) {
      return code;
    }
  }
  return null;
}

async function assertResolvedSkillScriptPathExists(request: ResolvedRunSkillScriptRequest): Promise<void> {
  const realPath = request.resolvedScript.realPath;

  let linkStats: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStats = await lstat(realPath);
  } catch (error) {
    const code = getFsErrorCode(error);
    if (code === "ENOENT") {
      throw new Error(`run_skill_script target does not exist: ${request.skillUri}`);
    }
    throw new Error(
      code
        ? `run_skill_script could not access target ${request.skillUri} (${code})`
        : `run_skill_script could not access target ${request.skillUri}`,
    );
  }

  if (linkStats.isDirectory()) {
    throw new Error(`run_skill_script target must point to a file, not a directory: ${request.skillUri}`);
  }

  if (request.executionBackend === "remote" && linkStats.isSymbolicLink()) {
    throw new Error(`run_skill_script remote execution does not support symlink script targets: ${request.skillUri}`);
  }

  let targetStats: Awaited<ReturnType<typeof stat>>;
  try {
    targetStats = await stat(realPath);
  } catch (error) {
    const code = getFsErrorCode(error);
    if (code === "ENOENT") {
      throw new Error(`run_skill_script target does not exist: ${request.skillUri}`);
    }
    throw new Error(
      code
        ? `run_skill_script could not access target ${request.skillUri} (${code})`
        : `run_skill_script could not access target ${request.skillUri}`,
    );
  }

  if (!targetStats.isFile()) {
    throw new Error(`run_skill_script target must point to a regular file: ${request.skillUri}`);
  }
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
  expectedRelativePath?: string,
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
    if (expectedRelativePath) {
      // A remote cleanup or partial cache corruption can leave the marker behind
      // while the script itself is gone. Re-stage instead of trusting the marker.
      await transport.readFile(`${stageRoot}/${expectedRelativePath}`, signal);
    }
    return { stageRoot, staged: false };
  } catch (error) {
    if (!isMissingRemotePathError(error)) {
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
  await assertResolvedSkillScriptPathExists(request);

  if (request.executionBackend === "local") {
    return {
      ...request,
      executionPath: request.resolvedScript.realPath,
      staged: false,
    };
  }

  if (!options.remoteHome || !options.transport) {
    throw new Error("Remote run_skill_script execution requires a remote home and transport");
  }

  const stage = await stageLocalSkillRootToRemote(
    request.resolvedScript.entry,
    options.remoteHome,
    options.transport,
    options.signal,
    request.normalizedRelativePath,
  );
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
