import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CommandLookup = Pick<ExtensionAPI, "getCommands">;

function stripFrontmatter(content: string): string {
  const raw = String(content || "");
  if (!raw.startsWith("---")) return raw;

  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i += 1) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }

    if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: string[]): string {
  let result = content;

  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = Number.parseInt(startStr, 10) - 1;
    if (start < 0) start = 0;

    if (lengthStr) {
      const length = Number.parseInt(lengthStr, 10);
      return args.slice(start, start + length).join(" ");
    }

    return args.slice(start).join(" ");
  });

  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

export function expandPromptTemplateCommand(text: string, commandLookup: CommandLookup): string {
  const raw = String(text || "");
  if (!raw.startsWith("/")) return raw;

  const spaceIndex = raw.indexOf(" ");
  const commandName = spaceIndex === -1 ? raw.slice(1) : raw.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : raw.slice(spaceIndex + 1);

  if (!commandName) return raw;

  const promptTemplate = commandLookup
    .getCommands()
    .find((command) => command.source === "prompt" && command.name === commandName);
  const promptPath = String(promptTemplate?.sourceInfo?.path || "").trim();
  if (!promptPath) return raw;

  try {
    const fileContent = fs.readFileSync(promptPath, "utf8");
    const templateBody = stripFrontmatter(fileContent);
    return substituteArgs(templateBody, parseCommandArgs(argsString));
  } catch {
    return raw;
  }
}
