import { constants as fsConstants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type EditOperations, type ReadOperations, type WriteOperations } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getActiveSkillUriBackend } from "./lib/backend-runtime.ts";
import { SkillPathGuard } from "./lib/skill-path-guard.ts";
import {
  buildRunSkillScriptCommand,
  prepareRunSkillScript,
  resolveRunSkillScriptRequest,
  RUN_SKILL_SCRIPT_TARGET_REMOVED_ERROR,
} from "./lib/run-skill-script.ts";
import {
  SkillRegistry,
  buildSkillUri,
  encodeSkillId,
  injectSkillUriReadGuidance,
  isSkillUri,
  isVirtualSkillPath,
  isVirtualizedSkillLocation,
  parseAvailableSkillsFromPrompt,
  rewriteAvailableSkillsLocations,
  skillUriToVirtualPath,
  type SkillOriginHint,
} from "./lib/skill-uris.ts";

function detectSupportedImageMimeTypeFromExtension(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return null;
}

function assertResolvedSkillAccess<T>(value: T | null | undefined): asserts value is T {
  if (!value) {
    throw new Error("Expected a resolved skill path");
  }
}

function createLocalSkillReadOps(skills: SkillRegistry, skillPathGuard: SkillPathGuard): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const resolved = skills.resolveVirtualPath(absolutePath);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      return fsReadFile(resolved.realPath);
    },
    access: async (absolutePath) => {
      const resolved = skills.resolveVirtualPath(absolutePath);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      await fsAccess(resolved.realPath, fsConstants.R_OK);
    },
    detectImageMimeType: async (absolutePath) => {
      const resolved = skills.resolveVirtualPath(absolutePath);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      return detectSupportedImageMimeTypeFromExtension(resolved.realPath);
    },
  };
}

function createLocalSkillWriteOps(skills: SkillRegistry, skillPathGuard: SkillPathGuard): WriteOperations {
  return {
    mkdir: async (absoluteDir) => {
      const resolved = skills.resolveVirtualPath(absoluteDir);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      await fsMkdir(resolved.realPath, { recursive: true });
    },
    writeFile: async (absolutePath, content) => {
      const resolved = skills.resolveVirtualPath(absolutePath);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      await fsMkdir(dirname(resolved.realPath), { recursive: true });
      await fsWriteFile(resolved.realPath, content, "utf-8");
    },
  };
}

function createLocalSkillEditOps(skills: SkillRegistry, skillPathGuard: SkillPathGuard): EditOperations {
  const readOps = createLocalSkillReadOps(skills, skillPathGuard);
  const writeOps = createLocalSkillWriteOps(skills, skillPathGuard);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (absolutePath) => {
      const resolved = skills.resolveVirtualPath(absolutePath);
      assertResolvedSkillAccess(resolved);
      await skillPathGuard.assertNoSymlinkEscape(resolved.entry.rootPath, resolved.relativePath);
      await fsAccess(resolved.realPath, fsConstants.R_OK | fsConstants.W_OK);
    },
  };
}

function shouldUseSkillOps(path: string): boolean {
  return isSkillUri(path) || isVirtualSkillPath(path);
}

function inferSkillOriginHint(filePath: string, localCwd: string, localHome: string): SkillOriginHint {
  if (filePath.startsWith(`${localCwd}/.pi/skills/`)) return "project";
  if (filePath.startsWith(`${localHome}/.pi/agent/skills/`)) return "global";
  return "other";
}

function warn(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, "warning");
    return;
  }
  console.warn(message);
}

export default function skillUriExtension(pi: ExtensionAPI): void {
  const localCwd = process.cwd();
  const localHome = homedir();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const skillRegistry = new SkillRegistry();
  const skillPathGuard = new SkillPathGuard();
  const warnedDuplicateFingerprints = new Set<string>();

  pi.on("session_start", () => {
    warnedDuplicateFingerprints.clear();
    skillRegistry.clear();
    skillPathGuard.clear();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt;
    let changed = false;

    const parsedSkills = parseAvailableSkillsFromPrompt(systemPrompt);
    const rawSkills = parsedSkills.filter((skill) => !isVirtualizedSkillLocation(skill.filePath));

    if (parsedSkills.length === 0) {
      skillRegistry.clear();
      skillPathGuard.clear();
    } else if (rawSkills.length > 0) {
      const update = skillRegistry.updateFromPromptSkills(rawSkills, {
        toRootPath: (filePath) => dirname(filePath),
        inferOriginHint: (filePath) => inferSkillOriginHint(filePath, localCwd, localHome),
      });

      for (const warningInfo of update.warnings) {
        if (warnedDuplicateFingerprints.has(warningInfo.fingerprint)) continue;
        warnedDuplicateFingerprints.add(warningInfo.fingerprint);
        warn(ctx, warningInfo.message);
      }

      const rewritten = rewriteAvailableSkillsLocations(
        systemPrompt,
        update.orderedEntries.map((entry) => ({
          name: entry.name,
          description: entry.description,
          filePath: entry.filePath,
        })),
        (skill) => buildSkillUri(encodeSkillId(skill.name), "SKILL.md"),
      );
      const updatedPrompt = injectSkillUriReadGuidance(rewritten);
      if (updatedPrompt !== systemPrompt) {
        systemPrompt = updatedPrompt;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }
    return { systemPrompt };
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      const rewrittenParams = isSkillUri(params.path) ? { ...params, path: skillUriToVirtualPath(params.path) } : params;
      if (shouldUseSkillOps(rewrittenParams.path)) {
        const tool = createReadTool(localCwd, { operations: createLocalSkillReadOps(skillRegistry, skillPathGuard) });
        return tool.execute(id, rewrittenParams, signal, onUpdate);
      }

      const backend = getActiveSkillUriBackend();
      if (!backend) {
        return localRead.execute(id, params, signal, onUpdate);
      }

      const tool = createReadTool(localCwd, { operations: backend.createReadOps(signal) });
      return tool.execute(id, rewrittenParams, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const rewrittenParams = isSkillUri(params.path) ? { ...params, path: skillUriToVirtualPath(params.path) } : params;
      if (shouldUseSkillOps(rewrittenParams.path)) {
        const tool = createWriteTool(localCwd, { operations: createLocalSkillWriteOps(skillRegistry, skillPathGuard) });
        return tool.execute(id, rewrittenParams, signal, onUpdate);
      }

      const backend = getActiveSkillUriBackend();
      if (!backend) {
        return localWrite.execute(id, params, signal, onUpdate);
      }

      const tool = createWriteTool(localCwd, { operations: backend.createWriteOps(signal) });
      return tool.execute(id, rewrittenParams, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const rewrittenParams = isSkillUri(params.path) ? { ...params, path: skillUriToVirtualPath(params.path) } : params;
      if (shouldUseSkillOps(rewrittenParams.path)) {
        const tool = createEditTool(localCwd, { operations: createLocalSkillEditOps(skillRegistry, skillPathGuard) });
        return tool.execute(id, rewrittenParams, signal, onUpdate);
      }

      const backend = getActiveSkillUriBackend();
      if (!backend) {
        return localEdit.execute(id, params, signal, onUpdate);
      }

      const tool = createEditTool(localCwd, { operations: backend.createEditOps(signal) });
      return tool.execute(id, rewrittenParams, signal, onUpdate);
    },
  });

  pi.registerTool({
    name: "run_skill_script",
    label: "Run Skill Script",
    description:
      "Execute a file shipped inside a skill. `script` must be a full `skill://<skill-id>/relative/path` URI, not a relative path.",
    parameters: Type.Object({
      script: Type.String({ description: "Required. Full skill file URI like `skill://pi-ssh/scripts/pi-ssh-setup.sh`. Relative paths are rejected." }),
      interpreter: Type.String({ description: "Interpreter command to invoke via `bash` on the target machine, e.g. `bash`, `python3`, or `uv run python`." }),
      args: Type.Optional(Type.Array(Type.String({ description: "Argument passed to the target file" }))),
      timeoutSeconds: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Timeout in seconds. Uses the active backend automatically: local by default, remote when a remote backend is active.",
        }),
      ),
    }),
    async execute(id, params, signal, onUpdate) {
      if (typeof params === "object" && params !== null && Object.hasOwn(params, "target")) {
        throw new Error(RUN_SKILL_SCRIPT_TARGET_REMOVED_ERROR);
      }

      const backend = getActiveSkillUriBackend();
      const request = resolveRunSkillScriptRequest(
        {
          script: params.script,
          interpreter: params.interpreter,
          args: params.args,
        },
        skillRegistry,
        Boolean(backend),
      );

      const remoteContext = request.executionBackend === "remote" ? backend?.getRemoteContext(signal) ?? null : null;
      if (request.executionBackend === "remote" && !backend) {
        throw new Error("Remote run_skill_script execution requires an active remote backend");
      }
      if (request.executionBackend === "remote" && !remoteContext) {
        throw new Error("Remote run_skill_script execution requires remote transport details from the active backend");
      }

      const prepared = await prepareRunSkillScript(request, {
        remoteHome: remoteContext?.remoteHome,
        transport: remoteContext?.transport,
        signal,
        assertLocalPathSafe: (rootPath, relativePath) => skillPathGuard.assertNoSymlinkEscape(rootPath, relativePath),
      });

      const command = buildRunSkillScriptCommand(prepared.interpreter, prepared.executionPath, prepared.args);
      const timeout = params.timeoutSeconds;
      const runner = prepared.executionBackend === "remote"
        ? createBashTool(localCwd, { operations: backend!.createBashOps() })
        : localBash;

      const result = await runner.execute(id, { command, timeout }, signal, onUpdate);
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          executionBackend: prepared.executionBackend,
          interpreter: prepared.interpreter,
          resolvedSkillUri: prepared.skillUri,
          executionPath: prepared.executionPath,
          skillRoot: prepared.resolvedScript.entry.rootPath,
          staged: prepared.staged,
          stageRoot: prepared.stageRoot,
        },
      };
    },
  });
}

export const __testInternals = {
  inferSkillOriginHint,
  createLocalSkillReadOps,
  createLocalSkillWriteOps,
  createLocalSkillEditOps,
};
