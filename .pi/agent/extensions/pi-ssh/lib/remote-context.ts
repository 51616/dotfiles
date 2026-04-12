export interface PromptContextFile {
  path: string;
  content: string;
}

export interface PromptContextResolveResult {
  file: PromptContextFile | null;
  warnings: string[];
}

export const PROJECT_CONTEXT_SECTION = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
export const PROJECT_CONTEXT_HEADING = "# Project Context";
export const SKILLS_SECTION_MARKER = "\nThe following skills provide specialized instructions for specific tasks.\n";
export const CURRENT_DATE_MARKER = "\nCurrent date:";
export const REMOTE_CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;
export const PROMPT_CONTEXT_STATUS_MARKER = "__PI_PROMPT_CONTEXT_STATUS__:";
export const PROMPT_CONTEXT_END_MARKER = "__PI_PROMPT_CONTEXT_END__";

function joinPosixPath(dir: string, basename: string): string {
  if (dir === "/") {
    return `/${basename}`;
  }
  return `${dir.replace(/\/+$/, "")}/${basename}`;
}

function findPromptTailInsertionIndex(systemPrompt: string, minIndex = 0): number {
  const skillsIndex = systemPrompt.indexOf(SKILLS_SECTION_MARKER, minIndex);
  const currentDateIndex = systemPrompt.lastIndexOf(CURRENT_DATE_MARKER);

  if (skillsIndex !== -1) {
    return skillsIndex;
  }

  if (currentDateIndex !== -1 && currentDateIndex >= minIndex) {
    return currentDateIndex;
  }

  return systemPrompt.length;
}

export async function resolvePreferredPromptContextFile(
  cwd: string,
  readIfExists: (path: string) => Promise<string | null>,
): Promise<PromptContextResolveResult> {
  const warnings: string[] = [];

  for (const filename of REMOTE_CONTEXT_FILENAMES) {
    const filePath = joinPosixPath(cwd, filename);
    try {
      const content = await readIfExists(filePath);
      if (content !== null) {
        return { file: { path: filePath, content }, warnings };
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return { file: null, warnings };
    }
  }

  return { file: null, warnings };
}

export function parsePromptContextProbeOutput(stdout: string, stderr: string, remotePath: string): string | null {
  const normalizedStdout = stdout.replace(/\r\n/g, "\n");
  const statusIndex = normalizedStdout.indexOf(PROMPT_CONTEXT_STATUS_MARKER);
  if (statusIndex === -1) {
    const output = normalizedStdout.trim();
    const err = stderr.trim();
    throw new Error(err || output || `Failed to probe remote prompt context: ${remotePath}`);
  }

  const statusLineEnd = normalizedStdout.indexOf("\n", statusIndex);
  const status = normalizedStdout
    .slice(statusIndex + PROMPT_CONTEXT_STATUS_MARKER.length, statusLineEnd === -1 ? undefined : statusLineEnd)
    .trim();
  if (status === "missing") {
    return null;
  }
  if (status === "unreadable") {
    throw new Error(`Remote prompt context is not a readable regular file: ${remotePath}`);
  }
  if (status !== "ok") {
    throw new Error(`Unexpected remote prompt context status \"${status}\" for ${remotePath}`);
  }

  const contentStart = statusLineEnd === -1 ? normalizedStdout.length : statusLineEnd + 1;
  const endIndex = normalizedStdout.indexOf(`\n${PROMPT_CONTEXT_END_MARKER}`, contentStart);
  if (endIndex === -1) {
    throw new Error(`Failed to parse remote prompt context payload: ${remotePath}`);
  }

  const encoded = normalizedStdout.slice(contentStart, endIndex).replace(/[\n\r]/g, "");
  return Buffer.from(encoded, "base64").toString("utf-8");
}

export function formatPromptContextFileBlock(file: PromptContextFile): string {
  return `## ${file.path}\n\n${file.content}\n\n`;
}

export function injectPromptContextFile(systemPrompt: string, file: PromptContextFile): string {
  const block = formatPromptContextFileBlock(file);
  if (systemPrompt.includes(block)) {
    return systemPrompt;
  }

  const standardSectionIndex = systemPrompt.indexOf(PROJECT_CONTEXT_SECTION);
  const projectContextIndex = standardSectionIndex !== -1
    ? standardSectionIndex
    : systemPrompt.indexOf(PROJECT_CONTEXT_HEADING);
  if (projectContextIndex !== -1) {
    const sectionStart = standardSectionIndex !== -1 ? standardSectionIndex + PROJECT_CONTEXT_SECTION.length : projectContextIndex + PROJECT_CONTEXT_HEADING.length;
    const insertAt = findPromptTailInsertionIndex(systemPrompt, sectionStart);
    let prefix = systemPrompt.slice(0, insertAt);
    let suffix = systemPrompt.slice(insertAt);

    if (!prefix.endsWith("\n\n")) {
      prefix += prefix.endsWith("\n") ? "\n" : "\n\n";
    }
    if (suffix.startsWith("\n")) {
      suffix = suffix.slice(1);
    }

    return `${prefix}${block}${suffix}`;
  }

  const insertAt = findPromptTailInsertionIndex(systemPrompt);
  const prefix = systemPrompt.slice(0, insertAt);
  const suffix = systemPrompt.slice(insertAt).startsWith("\n") ? systemPrompt.slice(insertAt + 1) : systemPrompt.slice(insertAt);
  return `${prefix}${PROJECT_CONTEXT_SECTION}${block}${suffix}`;
}
