import { relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";

export const VIRTUAL_SKILL_PREFIX = "/__pi_skill__";
export const SKILL_URI_PREFIX = "skill://";

export type SkillOriginHint = "project" | "global" | "other";

export interface PromptSkill {
  name: string;
  description: string;
  filePath: string;
}

export interface SkillEntry {
  id: string;
  encodedId: string;
  name: string;
  description: string;
  filePath: string;
  rootPath: string;
  originHint: SkillOriginHint;
}

export interface DuplicateSkillWarning {
  name: string;
  fingerprint: string;
  winner: SkillEntry;
  overridden: SkillEntry[];
  message: string;
}

export interface SkillRegistryUpdateResult {
  orderedEntries: SkillEntry[];
  warnings: DuplicateSkillWarning[];
}

export interface ResolvedSkillPath {
  entry: SkillEntry;
  encodedId: string;
  relativePath: string;
  realPath: string;
}

export interface SkillRegistryUpdateOptions {
  toRootPath: (filePath: string) => string;
  inferOriginHint: (filePath: string) => SkillOriginHint;
}

export function encodeSkillId(id: string): string {
  return encodeURIComponent(id);
}

export function decodeSkillId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function buildVirtualSkillPath(encodedId: string, relativePath: string): string {
  const rel = relativePath.replace(/^\/+/, "");
  if (!rel) {
    return `${VIRTUAL_SKILL_PREFIX}/${encodedId}`;
  }
  return `${VIRTUAL_SKILL_PREFIX}/${encodedId}/${rel}`;
}

export function isVirtualSkillPath(path: string): boolean {
  return path === VIRTUAL_SKILL_PREFIX || path.startsWith(`${VIRTUAL_SKILL_PREFIX}/`);
}

export function buildSkillUri(encodedId: string, relativePath: string): string {
  const rel = relativePath.replace(/^\/+/, "");
  if (!rel) {
    return `${SKILL_URI_PREFIX}${encodedId}`;
  }
  return `${SKILL_URI_PREFIX}${encodedId}/${rel}`;
}

export function isSkillUri(path: string): boolean {
  return path.startsWith(SKILL_URI_PREFIX);
}

function isLegacySkillUri(path: string): boolean {
  return path.startsWith(`${SKILL_URI_PREFIX}local/`) || path.startsWith(`${SKILL_URI_PREFIX}remote/`);
}

function buildLegacySkillUriError(path: string): Error {
  return new Error(
    `Legacy skill URIs with source prefixes are no longer supported: ${path}. Use skill://<skill-id>/... instead, for example skill://pi-ssh/SKILL.md or skill://pi-ssh/scripts/pi-ssh-setup.sh.`,
  );
}

function isLegacyVirtualSkillPath(path: string): boolean {
  return path.startsWith(`${VIRTUAL_SKILL_PREFIX}/local/`) || path.startsWith(`${VIRTUAL_SKILL_PREFIX}/remote/`);
}

export function parseSkillUri(path: string): { encodedId: string; relativePath: string } | null {
  if (!isSkillUri(path)) return null;
  if (isLegacySkillUri(path)) return null;

  const withoutScheme = path.slice(SKILL_URI_PREFIX.length);
  const parts = withoutScheme.split("/");
  const rawId = parts[0];
  if (!rawId) return null;

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    return null;
  }

  return {
    encodedId: encodeSkillId(decodedId),
    relativePath: parts.slice(1).join("/"),
  };
}

export function skillUriToVirtualPath(path: string): string {
  if (isLegacySkillUri(path)) {
    throw buildLegacySkillUriError(path);
  }
  const parsed = parseSkillUri(path);
  if (!parsed) {
    throw new Error(`Not a skill URI: ${path}`);
  }
  const relativePath = parsed.relativePath.trim() ? parsed.relativePath : "SKILL.md";
  return buildVirtualSkillPath(parsed.encodedId, relativePath);
}

export function isVirtualizedSkillLocation(location: string): boolean {
  return isVirtualSkillPath(location) || isSkillUri(location);
}

export function parseVirtualSkillPath(path: string): { encodedId: string; relativePath: string } | null {
  if (!isVirtualSkillPath(path)) return null;
  if (isLegacyVirtualSkillPath(path)) return null;

  const trimmed = path.slice(VIRTUAL_SKILL_PREFIX.length);
  const withoutLeadingSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = withoutLeadingSlash.split("/");
  const encodedId = parts[0];
  if (!encodedId) return null;
  return {
    encodedId,
    relativePath: parts.slice(1).join("/"),
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(str: string): string {
  return str
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function parseAvailableSkillsFromPrompt(prompt: string): PromptSkill[] {
  const blockMatch = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!blockMatch) return [];

  const skills: PromptSkill[] = [];
  const skillRegex = /<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<location>([\s\S]*?)<\/location>[\s\S]*?<\/skill>/g;
  let match: RegExpExecArray | null;
  while ((match = skillRegex.exec(blockMatch[0])) !== null) {
    const name = unescapeXml((match[1] ?? "").trim());
    const description = unescapeXml((match[2] ?? "").trim());
    const filePath = unescapeXml((match[3] ?? "").trim());
    if (!name || !filePath) continue;
    skills.push({ name, description, filePath });
  }
  return skills;
}

function buildDuplicateWarning(entries: SkillEntry[], winner: SkillEntry): DuplicateSkillWarning {
  const fingerprint = [winner.encodedId, winner.filePath, ...entries.map((entry) => entry.filePath)].join("|");
  const overridden = entries.filter((entry) => entry.filePath !== winner.filePath);
  const message = `skill-uri: duplicate skill name '${winner.name}'; last entry wins: ${winner.filePath} overrides ${overridden.map((entry) => entry.filePath).join(", ")}`;
  return {
    name: winner.name,
    fingerprint,
    winner,
    overridden,
    message,
  };
}

export class SkillRegistry {
  private entries = new Map<string, SkillEntry>();

  clear(): void {
    this.entries.clear();
  }

  set(entry: SkillEntry): void {
    this.entries.set(entry.encodedId, entry);
  }

  get(encodedId: string): SkillEntry | undefined {
    return this.entries.get(encodedId);
  }

  findByName(name: string): SkillEntry | undefined {
    return this.get(encodeSkillId(name));
  }

  updateFromPromptSkills(skills: PromptSkill[], options: SkillRegistryUpdateOptions): SkillRegistryUpdateResult {
    this.entries.clear();

    const latestById = new Map<string, { lastIndex: number; entries: SkillEntry[] }>();

    skills.forEach((skill, index) => {
      const encodedId = encodeSkillId(skill.name);
      const entry: SkillEntry = {
        id: skill.name,
        encodedId,
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        rootPath: options.toRootPath(skill.filePath),
        originHint: options.inferOriginHint(skill.filePath),
      };

      const existing = latestById.get(encodedId);
      if (existing) {
        latestById.set(encodedId, {
          lastIndex: index,
          entries: [...existing.entries, entry],
        });
        return;
      }

      latestById.set(encodedId, {
        lastIndex: index,
        entries: [entry],
      });
    });

    const ordered = Array.from(latestById.values())
      .sort((left, right) => left.lastIndex - right.lastIndex)
      .map((value) => value.entries[value.entries.length - 1]);

    for (const entry of ordered) {
      this.set(entry);
    }

    const warnings = Array.from(latestById.values())
      .filter((value) => value.entries.length > 1)
      .map((value) => buildDuplicateWarning(value.entries, value.entries[value.entries.length - 1]));

    return {
      orderedEntries: ordered,
      warnings,
    };
  }

  resolveVirtualPath(path: string): ResolvedSkillPath | null {
    if (isLegacyVirtualSkillPath(path)) {
      throw new Error(
        `Legacy internal skill paths with source prefixes are no longer supported: ${path}. Use canonical skill://<skill-id>/... URIs instead.`,
      );
    }

    const parsed = parseVirtualSkillPath(path);
    if (!parsed) return null;

    const entry = this.get(parsed.encodedId);
    if (!entry) {
      throw new Error(`Unknown skill id: ${decodeSkillId(parsed.encodedId)}`);
    }

    return {
      entry,
      encodedId: parsed.encodedId,
      relativePath: parsed.relativePath,
      realPath: resolvePathWithinRoot(entry.rootPath, parsed.relativePath),
    };
  }
}

export function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const rel = relativePath.replace(/^\/+/, "");
  const resolved = rel ? pathResolve(rootPath, rel) : rootPath;
  const relToRoot = pathRelative(rootPath, resolved);
  if (!relToRoot || relToRoot === ".") {
    return resolved;
  }
  if (relToRoot === ".." || relToRoot.startsWith(`..${pathSep}`)) {
    throw new Error(`Skill path escapes root: ${relativePath}`);
  }
  return resolved;
}

export const SKILL_URI_GUIDANCE_MARKER = "Skill `<location>` values use the `skill://` scheme";
export const LEGACY_SKILL_URI_FIRST_GUIDANCE_LINE = "Skill <location> values use the skill:// scheme and can be passed directly to the read tool.";
export const SKILL_URI_FIRST_GUIDANCE_LINE = `${SKILL_URI_GUIDANCE_MARKER} and can be passed directly to the \`read\` tool.`;
export const SKILL_URI_RUN_SCRIPT_GUIDANCE_LINE =
  "Use `run_skill_script` to execute files referenced by skills. Pass `script` as a full `skill://<skill-id>/relative/path` URI, not a relative path.";

const SKILL_URI_GUIDANCE_LINES = [
  SKILL_URI_FIRST_GUIDANCE_LINE,
  "When a skill mentions a relative path like `scripts/foo.sh`, resolve it relative to that skill's `skill://` location, not the current working directory.",
  "Example: if a skill `<location>` is `skill://pi-ssh/SKILL.md`, then `scripts/pi-ssh-setup.sh` refers to `skill://pi-ssh/scripts/pi-ssh-setup.sh`.",
  SKILL_URI_RUN_SCRIPT_GUIDANCE_LINE,
  "Do not pass `skill://` URIs to shell scripts or local filesystem tools such as `bash`, `python`, `ls`, `find`, `rg`, or `ast-grep`. Those URIs are agent resource identifiers, not local disk paths.",
];

export const SKILL_URI_READ_GUIDANCE = SKILL_URI_GUIDANCE_LINES.join("\n");

export function injectSkillUriReadGuidance(prompt: string): string {
  if (prompt.includes(SKILL_URI_READ_GUIDANCE)) {
    return prompt;
  }

  if (prompt.includes(SKILL_URI_FIRST_GUIDANCE_LINE) || prompt.includes(LEGACY_SKILL_URI_FIRST_GUIDANCE_LINE)) {
    const currentFirstLine = prompt.includes(SKILL_URI_FIRST_GUIDANCE_LINE)
      ? SKILL_URI_FIRST_GUIDANCE_LINE
      : LEGACY_SKILL_URI_FIRST_GUIDANCE_LINE;
    const missingLines = SKILL_URI_GUIDANCE_LINES.slice(1).filter((line) => !prompt.includes(line));
    const replacementFirstLine = SKILL_URI_FIRST_GUIDANCE_LINE;
    if (missingLines.length === 0) {
      return prompt.replace(currentFirstLine, replacementFirstLine);
    }
    return prompt.replace(currentFirstLine, `${replacementFirstLine}\n${missingLines.join("\n")}`);
  }

  const needle = "Use the read tool to load a skill's file when the task matches its description.";
  if (prompt.includes(needle)) {
    return prompt.replace(needle, `${needle}\n${SKILL_URI_READ_GUIDANCE}`);
  }

  const blockIndex = prompt.indexOf("<available_skills>");
  if (blockIndex !== -1) {
    const prefix = prompt.slice(0, blockIndex);
    const suffix = prompt.slice(blockIndex);
    const sep = prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
    return `${prefix}${sep}${SKILL_URI_READ_GUIDANCE}\n\n${suffix}`;
  }

  return prompt;
}

export function rewriteAvailableSkillsLocations(
  prompt: string,
  skills: PromptSkill[],
  getLocationForSkill: (skill: PromptSkill) => string,
): string {
  const blockMatch = prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
  if (!blockMatch) return prompt;

  const lines = ["<available_skills>"];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(getLocationForSkill(skill))}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");

  return prompt.replace(blockMatch[0], lines.join("\n"));
}
