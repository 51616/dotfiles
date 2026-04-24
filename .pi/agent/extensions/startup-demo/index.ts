import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  formatSkillsForPrompt,
  getAgentDir,
  loadSkills,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

type StartupDemoContext = Pick<ExtensionContext, "hasUI" | "ui" | "cwd">;
export type CatalogScope = "project" | "user";
export type CatalogItem = {
  name: string;
  scopes: CatalogScope[];
};
export type SkillPromptStats = {
  totalSkills: number;
  visibleSkills: number;
  frontmatterTokens: number;
  promptTokens: number;
};

function clearHeader(ctx: StartupDemoContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setHeader(undefined);
}

function discoverSkills(cwd: string): { items: CatalogItem[]; stats: SkillPromptStats } {
  const { skills } = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true });
  const items = skills
    .map((skill) => ({
      name: skill.name,
      scopes: skill.sourceInfo.scope === "project" || skill.sourceInfo.scope === "user" ? [skill.sourceInfo.scope] : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);

  return {
    items,
    stats: {
      totalSkills: skills.length,
      visibleSkills: visibleSkills.length,
      frontmatterTokens: estimateFrontmatterTokens(visibleSkills.map((skill) => skill.filePath)),
      promptTokens: estimateTokenCount(formatSkillsForPrompt(skills)),
    },
  };
}

export function discoverExtensions(cwd: string, agentDir = getAgentDir()): CatalogItem[] {
  return discoverCatalogItems(
    [
      { dir: join(cwd, ".pi", "extensions"), scope: "project" as const },
      { dir: join(agentDir, "extensions"), scope: "user" as const },
    ],
    (entryPath, entryName, isDirectoryLike, isFileLike) => {
      if (entryName.startsWith(".")) return null;

      if (isFileLike) {
        const extension = extname(entryName);
        if ([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"].includes(extension)) {
          return basename(entryName, extension);
        }
        return null;
      }

      if (!isDirectoryLike) return null;
      if (existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "index.js"))) return entryName;
      if (existsSync(join(entryPath, "index.mts")) || existsSync(join(entryPath, "index.mjs"))) return entryName;
      if (existsSync(join(entryPath, "package.json"))) return entryName;
      return null;
    },
  );
}

export function discoverPromptFiles(cwd: string, agentDir = getAgentDir()): CatalogItem[] {
  const items: CatalogItem[] = [];
  const seen = new Set<string>();
  const home = homedir();

  const addItem = (filePath: string | null, scope: CatalogScope): void => {
    if (!filePath || seen.has(filePath)) return;
    seen.add(filePath);
    items.push({
      name: formatDisplayPath(filePath, home),
      scopes: [scope],
    });
  };

  const projectSystemPrompt = discoverPreferredFile(join(cwd, ".pi"), ["SYSTEM.md"]);
  addItem(projectSystemPrompt, "project");
  if (!projectSystemPrompt) {
    addItem(discoverPreferredFile(agentDir, ["SYSTEM.md"]), "user");
  }

  const projectAppendSystemPrompt = discoverPreferredFile(join(cwd, ".pi"), ["APPEND_SYSTEM.md"]);
  addItem(projectAppendSystemPrompt, "project");
  if (!projectAppendSystemPrompt) {
    addItem(discoverPreferredFile(agentDir, ["APPEND_SYSTEM.md"]), "user");
  }

  addItem(discoverPreferredFile(agentDir, ["AGENTS.md", "CLAUDE.md"]), "user");

  const projectContext: CatalogItem[] = [];
  let currentDir = resolve(cwd);
  const root = resolve("/");

  while (true) {
    const filePath = discoverPreferredFile(currentDir, ["AGENTS.md", "CLAUDE.md"]);
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      projectContext.unshift({
        name: formatDisplayPath(filePath, home),
        scopes: ["project"],
      });
    }

    if (currentDir === root) break;
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  items.push(...projectContext);
  return items;
}

export function discoverCatalogItems(
  roots: Array<{ dir: string; scope: CatalogScope }>,
  classify: (entryPath: string, entryName: string, isDirectoryLike: boolean, isFileLike: boolean) => string | null,
): CatalogItem[] {
  const scopesByName = new Map<string, Set<CatalogScope>>();

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;

    try {
      for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
        const entryPath = join(root.dir, entry.name);
        const isDirectoryLike = entry.isDirectory() || entry.isSymbolicLink();
        const isFileLike = entry.isFile() || entry.isSymbolicLink();
        const name = classify(entryPath, entry.name, isDirectoryLike, isFileLike);
        if (!name) continue;

        const scopes = scopesByName.get(name) ?? new Set<CatalogScope>();
        scopes.add(root.scope);
        scopesByName.set(name, scopes);
      }
    } catch {
      // Ignore unreadable directories. This is a startup convenience view.
    }
  }

  return [...scopesByName.entries()]
    .map(([name, scopes]) => ({
      name,
      scopes: [...scopes].sort((a, b) => scopeOrder(a) - scopeOrder(b)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function discoverPreferredFile(dir: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const filePath = join(dir, candidate);
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function formatDisplayPath(filePath: string, home: string): string {
  if (filePath === home) {
    return "~";
  }
  if (filePath.startsWith(`${home}/`)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function scopeOrder(scope: CatalogScope): number {
  return scope === "project" ? 0 : 1;
}

function scopeLabel(scopes: CatalogScope[]): string {
  if (scopes.length === 0) return "";
  return `[${scopes.map((scope) => (scope === "project" ? "P" : "U")).join("/")}]`;
}

function installDashboardHeader(ctx: StartupDemoContext): void {
  if (!ctx.hasUI) return;

  const { items: skills, stats: skillStats } = discoverSkills(ctx.cwd);
  const promptFiles = discoverPromptFiles(ctx.cwd);
  const extensions = discoverExtensions(ctx.cwd);

  ctx.ui.setHeader((_tui, theme) => new StartupDemoHeader(theme, skills, promptFiles, extensions, skillStats));
}

export default function startupDemo(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    installDashboardHeader(ctx);
  });

  pi.registerCommand("startup-demo", {
    description: "Refresh the startup dashboard header",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      installDashboardHeader(ctx);
      ctx.ui.notify("Startup dashboard header refreshed.", "info");
    },
  });

  pi.registerCommand("startup-demo-off", {
    description: "Restore the built-in startup header",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      clearHeader(ctx);
      ctx.ui.notify("Built-in startup header restored.", "info");
    },
  });

  pi.registerCommand("startup-demo-on", {
    description: "Enable the custom startup dashboard header",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      installDashboardHeader(ctx);
      ctx.ui.notify("Startup dashboard header enabled.", "info");
    },
  });
}

class StartupDemoHeader {
  readonly width = 74;
  private readonly theme: Theme;
  private readonly skills: CatalogItem[];
  private readonly promptFiles: CatalogItem[];
  private readonly extensions: CatalogItem[];
  private readonly skillStats: SkillPromptStats;

  constructor(
    theme: Theme,
    skills: CatalogItem[],
    promptFiles: CatalogItem[],
    extensions: CatalogItem[],
    skillStats: SkillPromptStats,
  ) {
    this.theme = theme;
    this.skills = skills;
    this.promptFiles = promptFiles;
    this.extensions = extensions;
    this.skillStats = skillStats;
  }

  render(_width: number): string[] {
    const innerWidth = this.width - 2;
    const columnGap = 3;
    const leftWidth = Math.floor((innerWidth - columnGap) / 2);
    const rightWidth = innerWidth - columnGap - leftWidth;
    const divider = this.theme.fg("border", "│");
    const lines: string[] = [];

    const row = (text = ""): string => {
      const visible = visibleWidth(text);
      return `${divider}${text}${" ".repeat(Math.max(0, innerWidth - visible))}${divider}`;
    };

    const renderColumn = (
      title: string,
      items: CatalogItem[],
      width: number,
      color: "accent" | "warning",
    ): string[] => {
      const heading = this.theme.bold(this.theme.fg(color, `${title} (${items.length})`));
      const separator = this.theme.fg("dim", "─".repeat(Math.max(0, Math.min(width, 16))));
      const lines = [heading, separator, ...items.map((item) => `• ${item.name} ${scopeLabel(item.scopes)}`)];

      if (items.length === 0) {
        lines.push(this.theme.fg("dim", "(none)"));
      }

      return lines.map((line) => fitPlain(line, width));
    };

    const promptFilesLines = renderColumn("Prompt Files", this.promptFiles, innerWidth - 1, "accent");
    const leftLines = renderColumn("Skills", this.skills, Math.max(0, leftWidth - 1), "accent");
    const rightLines = renderColumn("Extensions", this.extensions, rightWidth, "warning");
    const bodyHeight = Math.max(leftLines.length, rightLines.length);
    const promptCostLine = [
      `frontmatter ≈ ${formatTokenCount(this.skillStats.frontmatterTokens)}`,
      `prompt ≈ ${formatTokenCount(this.skillStats.promptTokens)}`,
      `visible ${this.skillStats.visibleSkills}/${this.skillStats.totalSkills}`,
    ].join(" | ");

    lines.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(row(` ${this.theme.fg("accent", "Startup Dashboard")}`));
    lines.push(row(` ${this.theme.fg("muted", "Loaded prompt files, skills, and extensions for this workspace")}`));
    lines.push(row(` ${this.theme.fg("dim", fitPlain(promptCostLine, innerWidth - 1))}`));
    lines.push(row());

    for (const line of promptFilesLines) {
      lines.push(row(` ${line}`));
    }
    lines.push(row());

    for (let index = 0; index < bodyHeight; index += 1) {
      const left = leftLines[index] ?? " ".repeat(Math.max(0, leftWidth - 1));
      const right = rightLines[index] ?? " ".repeat(rightWidth);
      lines.push(row(` ${left} ${this.theme.fg("border", "│")} ${right}`));
    }

    lines.push(row());
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));

    return lines;
  }

  invalidate(): void {}
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return null;
  }

  return normalized.slice(4, endIndex);
}

function estimateFrontmatterTokens(filePaths: string[]): number {
  let total = 0;

  for (const filePath of filePaths) {
    try {
      const frontmatter = extractFrontmatter(readFileSync(filePath, "utf-8"));
      if (!frontmatter) continue;
      total += estimateTokenCount(frontmatter);
    } catch {
      // Ignore unreadable files. This is a startup estimate, not a strict accounting path.
    }
  }

  return total;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

function fitPlain(text: string, width: number): string {
  const clipped = clipPlain(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function clipPlain(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";

  let result = "";
  for (const char of text) {
    const next = result + char;
    if (visibleWidth(next + "…") > width) break;
    result = next;
  }
  return `${result}…`;
}
