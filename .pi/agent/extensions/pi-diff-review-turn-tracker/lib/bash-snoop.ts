import path from "node:path";
import { spawnSync } from "node:child_process";

function tokenizeShell(command: string): string[] | null {
  if (!command.trim()) return null;
  if (/[|;&><`]/.test(command) || /\$\(/.test(command) || /\n/.test(command)) return null;

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escape || quote) return null;
  if (current) tokens.push(current);
  return tokens.length ? tokens : null;
}

function hasUnsafeToken(tokens: string[]): boolean {
  return tokens.some((token) => /[*?\[\]{}~]/.test(token));
}

function nonFlagArgs(tokens: string[], startIndex: number): string[] {
  return tokens.slice(startIndex).filter((token) => token !== "--").filter((token) => !token.startsWith("-"));
}

function resolvePaths(cwd: string, values: string[]): string[] {
  return values.map((value) => path.resolve(cwd, value));
}

function parseRmMv(tokens: string[], cwd: string): string[] {
  if (tokens[0] === "rm") return resolvePaths(cwd, nonFlagArgs(tokens, 1));
  if (tokens[0] === "mv") {
    const args = nonFlagArgs(tokens, 1);
    if (args.length !== 2) return [];
    return resolvePaths(cwd, args);
  }
  return [];
}

function parseGitRmMv(tokens: string[], cwd: string): string[] {
  if (tokens[0] !== "git") return [];
  let index = 1;
  while (index < tokens.length && tokens[index]?.startsWith("-")) {
    if (tokens[index] === "-C" && index + 1 < tokens.length) {
      cwd = path.resolve(cwd, tokens[index + 1] ?? cwd);
      index += 2;
      continue;
    }
    index += 1;
  }
  const sub = tokens[index];
  if (!sub) return [];
  if (sub === "rm") return resolvePaths(cwd, nonFlagArgs(tokens, index + 1));
  if (sub === "mv") {
    const args = nonFlagArgs(tokens, index + 1);
    if (args.length !== 2) return [];
    return resolvePaths(cwd, args);
  }
  return [];
}

function astGrepDryRunFiles(tokens: string[], cwd: string): string[] {
  const command = tokens[0];
  const sub = tokens[1];
  if (!(command === "ast-grep" || command === "sg")) return [];
  if (!(sub === "run" || sub === "scan")) return [];
  if (!tokens.some((token) => token === "-i" || token === "--interactive" || token === "-U" || token === "--update-all")) return [];

  const args: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "-i" || token === "--interactive" || token === "-U" || token === "--update-all") continue;
    if (token === "--json" && index + 1 < tokens.length) {
      index += 1;
      continue;
    }
    if (token.startsWith("--json=")) continue;
    args.push(token);
  }
  args.push("--json=stream");

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0 && !result.stdout.trim()) return [];

  const files = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { file?: string };
      if (parsed.file) files.add(path.resolve(cwd, parsed.file));
    } catch {
      // ignore malformed dry-run lines
    }
  }
  return [...files];
}

export function snoopedBashPaths(command: string, cwd: string): string[] {
  const tokens = tokenizeShell(command);
  if (!tokens || !tokens.length) return [];
  if (hasUnsafeToken(tokens)) return [];

  const rmMv = parseRmMv(tokens, cwd);
  if (rmMv.length) return rmMv;

  const gitRmMv = parseGitRmMv(tokens, cwd);
  if (gitRmMv.length) return gitRmMv;

  return astGrepDryRunFiles(tokens, cwd);
}
