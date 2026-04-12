import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
type CatalogScope = "project" | "user";
type CatalogItem = {
  name: string;
  scopes: CatalogScope[];
};
type SkillPromptStats = {
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
  const { skills } = loadSkills({ cwd, agentDir: getAgentDir() });
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

function discoverExtensions(cwd: string): CatalogItem[] {
  return discoverCatalogItems(
    [
      { dir: join(cwd, ".pi", "extensions"), scope: "project" as const },
      { dir: join(getAgentDir(), "extensions"), scope: "user" as const },
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

function discoverCatalogItems(
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
  const extensions = discoverExtensions(ctx.cwd);

  ctx.ui.setHeader((_tui, theme) => new StartupDemoHeader(theme, skills, extensions, skillStats));
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

  constructor(
    private readonly theme: Theme,
    private readonly skills: CatalogItem[],
    private readonly extensions: CatalogItem[],
    private readonly skillStats: SkillPromptStats,
  ) {}

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
    lines.push(row(` ${this.theme.fg("muted", "Loaded skills and extensions for this workspace")}`));
    lines.push(row(` ${this.theme.fg("dim", fitPlain(promptCostLine, innerWidth - 1))}`));
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
