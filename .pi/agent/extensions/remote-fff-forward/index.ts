import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

import { getActivePiSshSession, type PiSshSession } from "../pi-ssh/lib/pi-ssh-session-runtime.ts";
import { decodeFindCursor, decodeGrepCursor, encodeFindCursor, encodeGrepCursor } from "./lib/cursors.ts";
import {
  DEFAULT_FIND_LIMIT,
  DEFAULT_GREP_LIMIT,
  formatFindOutput,
  formatGrepOutput,
  renderTextContent,
  type FffGrepResult,
  type FffSearchResult,
} from "./lib/format.ts";
import { RemoteFffManager } from "./lib/manager.ts";
import { buildQuery } from "./lib/query.ts";

const TOOL_SOURCE = "remote-fff-forward";
const SCAN_TIMEOUT_MS = 15000;

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (literal text or regex)" }),
  path: Type.Optional(Type.String({ description: "Repo-relative path constraint. Directory prefix, filename, or glob." })),
  exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Exclude paths, comma/space-separated or array." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Force case-sensitive matching. Default uses smart-case." })),
  context: Type.Optional(Type.Number({ description: "Context lines before+after each match" })),
  limit: Type.Optional(Type.Number({ description: `Max matches (default ${DEFAULT_GREP_LIMIT})` })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

type GrepParams = Static<typeof grepSchema>;

const findSchema = Type.Object({
  pattern: Type.String({ description: "Fuzzy filename search and glob search. Frecency-ranked." }),
  path: Type.Optional(Type.String({ description: "Repo-relative path constraint. Directory prefix, filename, or glob." })),
  exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Exclude paths, comma/space-separated or array." })),
  limit: Type.Optional(Type.Number({ description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` })),
  cursor: Type.Optional(Type.String({ description: "Pagination cursor from previous result" })),
});

type FindParams = Static<typeof findSchema>;

type GrepMode = "plain" | "regex" | "fuzzy";

interface RemoteFffDetails {
  totalMatched?: number;
  totalFiles?: number;
  pageIndex?: number;
  hasMore?: boolean;
  remote: true;
  basePath: string;
  worker: typeof TOOL_SOURCE;
}

interface RemoteFffHealthResult {
  pid: number;
  basePath: string | null;
  cacheDir: string;
  health: {
    version?: string;
    filePicker?: {
      initialized: boolean;
      basePath?: string;
      indexedFiles?: number;
      isScanning?: boolean;
      error?: string;
    };
    git?: {
      available: boolean;
      repositoryFound: boolean;
      workdir?: string;
      libgit2Version?: string;
      error?: string;
    };
  };
}

function hasSshFlag(pi: ExtensionAPI): boolean {
  const flag = pi.getFlag("ssh");
  return typeof flag === "string" && flag.trim().length > 0;
}

function shouldInstallRemoteTools(pi: ExtensionAPI): boolean {
  return hasSshFlag(pi) || getActivePiSshSession() !== null;
}

function resolveRemoteBasePath(session: PiSshSession, ctx: ExtensionContext): string {
  const mapped = session.mapLocalPathToRemote(ctx.cwd);
  if (mapped && mapped.startsWith("/") && mapped !== ctx.cwd) return mapped;
  return session.getConnectionInfo().remoteCwd;
}

function workspaceRoots(ctx: ExtensionContext, remoteBasePath: string): string[] {
  return [ctx.cwd, remoteBasePath].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
}

function detectGrepMode(pattern: string): GrepMode {
  const hasRegexSyntax = pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!hasRegexSyntax) return "plain";
  try {
    new RegExp(pattern);
    return "regex";
  } catch {
    return "plain";
  }
}

function isWildcardOnlyPattern(pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasRegexSyntax = pattern !== escaped;
  const trimmed = pattern.trim();
  return hasRegexSyntax && /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(trimmed);
}

function buildTextResult(text: string, details: RemoteFffDetails): AgentToolResult<RemoteFffDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function runRemoteFind(
  manager: RemoteFffManager,
  session: PiSshSession,
  ctx: ExtensionContext,
  params: FindParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<RemoteFffDetails>> {
  const basePath = resolveRemoteBasePath(session, ctx);
  const resumed = params.cursor ? decodeFindCursor(params.cursor) : undefined;
  const effectiveLimit = resumed ? resumed.pageSize : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
  const query = resumed ? resumed.query : buildQuery(params.path, params.pattern, params.exclude, workspaceRoots(ctx, basePath));
  const pattern = resumed ? resumed.pattern : params.pattern;
  const pageIndex = resumed?.nextPageIndex ?? 0;

  const client = await manager.getClient(session, signal);
  const result = await client.request<FffSearchResult>("find", {
    basePath: resumed?.basePath ?? basePath,
    query,
    pageIndex,
    pageSize: effectiveLimit,
    scanTimeoutMs: SCAN_TIMEOUT_MS,
  }, signal);

  const formatted = formatFindOutput(result, effectiveLimit, pattern);
  let output = formatted.output;
  const shownSoFar = pageIndex * effectiveLimit + result.items.length;
  const hasMore = result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;
  const notices: string[] = [];

  if (formatted.weak && formatted.shownCount > 0) {
    notices.push(`Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`);
  }

  if (!formatted.weak && hasMore) {
    const remaining = result.totalMatched - shownSoFar;
    const cursor = encodeFindCursor({
      kind: "find",
      basePath: resumed?.basePath ?? basePath,
      query,
      pattern,
      pageSize: effectiveLimit,
      nextPageIndex: pageIndex + 1,
    });
    notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursor}" to continue`);
  }

  if (notices.length > 0) output += `\n\n[${notices.join(" ")}]`;

  return buildTextResult(output, {
    totalMatched: result.totalMatched,
    totalFiles: result.totalFiles,
    pageIndex,
    hasMore,
    remote: true,
    basePath: resumed?.basePath ?? basePath,
    worker: TOOL_SOURCE,
  });
}

async function runRemoteGrep(
  manager: RemoteFffManager,
  session: PiSshSession,
  ctx: ExtensionContext,
  params: GrepParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<RemoteFffDetails>> {
  if (isWildcardOnlyPattern(params.pattern)) {
    return buildTextResult(
      `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
      { totalMatched: 0, totalFiles: 0, remote: true, basePath: resolveRemoteBasePath(session, ctx), worker: TOOL_SOURCE },
    );
  }

  const basePath = resolveRemoteBasePath(session, ctx);
  const resumed = params.cursor ? decodeGrepCursor(params.cursor) : undefined;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const mode = resumed?.mode ?? detectGrepMode(params.pattern);
  const smartCase = resumed?.smartCase ?? params.caseSensitive !== true;
  const beforeContext = resumed?.beforeContext ?? params.context ?? 0;
  const afterContext = resumed?.afterContext ?? params.context ?? 0;
  const maxMatchesPerFile = resumed?.maxMatchesPerFile ?? Math.min(effectiveLimit, 50);
  const query = resumed ? resumed.query : buildQuery(params.path, params.pattern, params.exclude, workspaceRoots(ctx, basePath));
  const pattern = resumed?.pattern ?? params.pattern;

  const client = await manager.getClient(session, signal);
  let result = await client.request<FffGrepResult>("grep", {
    basePath: resumed?.basePath ?? basePath,
    query,
    mode,
    smartCase,
    maxMatchesPerFile,
    cursorOffset: resumed?.cursorOffset,
    beforeContext,
    afterContext,
    scanTimeoutMs: SCAN_TIMEOUT_MS,
  }, signal);

  let fuzzyNotice: string | null = null;
  if (result.items.length === 0 && !params.cursor && mode !== "regex") {
    const fuzzy = await client.request<FffGrepResult>("grep", {
      basePath,
      query: params.pattern,
      mode: "fuzzy",
      smartCase,
      maxMatchesPerFile,
      beforeContext: 0,
      afterContext: 0,
      scanTimeoutMs: SCAN_TIMEOUT_MS,
    }, signal);
    if (fuzzy.items.length > 0) {
      fuzzyNotice = "0 exact matches. Maybe you meant this?";
      result = fuzzy;
    }
  }

  let output = formatGrepOutput(result);
  const notices: string[] = [];
  if (result.regexFallbackError) {
    notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
  }
  if (typeof result.nextCursorOffset === "number") {
    const cursor = encodeGrepCursor({
      kind: "grep",
      basePath: resumed?.basePath ?? basePath,
      query,
      pattern,
      mode,
      smartCase,
      maxMatchesPerFile,
      beforeContext,
      afterContext,
      cursorOffset: result.nextCursorOffset,
    });
    notices.push(`Continue with cursor="${cursor}"`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

  return buildTextResult(output, {
    totalMatched: result.totalMatched,
    totalFiles: result.totalFiles,
    remote: true,
    basePath: resumed?.basePath ?? basePath,
    worker: TOOL_SOURCE,
  });
}

function renderTextResult(result: AgentToolResult<unknown>, maxLines: number): Text {
  const content = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return new Text(renderTextContent(content, maxLines), 0, 0);
}

export default function remoteFffForwardExtension(pi: ExtensionAPI): void {
  const manager = new RemoteFffManager();

  function registerRemoteTools(): void {
    pi.registerTool({
      name: "ffgrep",
      label: "ffgrep",
      description: `Grep file contents on the active pi-ssh remote using a persistent FFF worker. Smart-case, auto-detects regex vs literal, git-aware. Default limit ${DEFAULT_GREP_LIMIT}.`,
      promptSnippet: "Grep remote contents",
      promptGuidelines: [
        "Use ffgrep for plain-text content search in the active SSH workspace; prefer bare identifiers over syntax snippets.",
        "Use ffgrep path for include constraints and exclude for noise; use ast-grep through bash for syntax-aware source-code search.",
      ],
      parameters: grepSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const session = getActivePiSshSession();
        if (!session) throw new Error("ffgrep remote forwarding requires an active pi-ssh session");
        return runRemoteGrep(manager, session, ctx, params, signal);
      },
      renderCall(args, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const path = args?.path ?? ".";
        let content = theme.fg("toolTitle", theme.bold("ffgrep")) + " " + theme.fg("accent", `/${args?.pattern ?? ""}/`) + theme.fg("toolOutput", ` in ${path} via SSH`);
        if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
        if (args?.cursor) content += theme.fg("muted", " (page)");
        text.setText(content);
        return text;
      },
      renderResult(result) {
        return renderTextResult(result, 15);
      },
    });

    pi.registerTool({
      name: "fffind",
      label: "fffind",
      description: `Fuzzy path search on the active pi-ssh remote using a persistent FFF worker. Matches the whole repo-relative path. Default limit ${DEFAULT_FIND_LIMIT}.`,
      promptSnippet: "Find remote files by path or glob",
      promptGuidelines: [
        "Use fffind for path/file discovery in the active SSH workspace before falling back to ls/read.",
        "Use fffind path for include constraints and exclude for noise; keep queries to 1-2 terms.",
      ],
      parameters: findSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const session = getActivePiSshSession();
        if (!session) throw new Error("fffind remote forwarding requires an active pi-ssh session");
        return runRemoteFind(manager, session, ctx, params, signal);
      },
      renderCall(args, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const path = args?.path ?? ".";
        let content = theme.fg("toolTitle", theme.bold("fffind")) + " " + theme.fg("accent", `“${args?.pattern ?? ""}”`) + theme.fg("toolOutput", ` in ${path} via SSH`);
        if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
        if (args?.cursor) content += theme.fg("muted", " (page)");
        text.setText(content);
        return text;
      },
      renderResult(result) {
        return renderTextResult(result, 20);
      },
    });
  }

  if (shouldInstallRemoteTools(pi)) registerRemoteTools();

  pi.on("session_start", () => {
    // Re-register on every SSH session start so this extension wins tool-name
    // precedence even if the local pi-fff extension registered earlier/later.
    if (shouldInstallRemoteTools(pi)) registerRemoteTools();
  });

  pi.on("session_shutdown", () => {
    manager.dispose();
  });

  pi.registerCommand("remote-fff-health", {
    description: "Check the active remote FFF worker and FFF native library status",
    handler: async (_args, ctx) => {
      const session = getActivePiSshSession();
      if (!session) {
        ctx.ui.notify("remote-fff-forward: no active pi-ssh session", "warning");
        return;
      }
      const client = await manager.getClient(session, ctx.signal);
      const basePath = resolveRemoteBasePath(session, ctx);
      const health = await client.request<RemoteFffHealthResult>("health", { basePath, scanTimeoutMs: SCAN_TIMEOUT_MS }, ctx.signal);
      const picker = health.health.filePicker;
      const git = health.health.git;
      const lines = [
        `remote-fff worker pid: ${health.pid}`,
        `base: ${health.basePath ?? basePath}`,
        `cache: ${health.cacheDir}`,
        `FFF: ${health.health.version ?? "unknown"}`,
        `indexed files: ${picker?.indexedFiles ?? "unknown"}${picker?.isScanning ? " (scanning)" : ""}`,
        `git: ${git?.repositoryFound ? git.workdir ?? "repository found" : "no repository"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("remote-fff-restart", {
    description: "Restart the cached remote FFF worker on the next search call",
    handler: async (_args, ctx) => {
      manager.restart();
      ctx.ui.notify("remote-fff-forward: worker restart requested", "info");
    },
  });
}

export const __testInternals = {
  detectGrepMode,
  isWildcardOnlyPattern,
  resolveRemoteBasePath,
  runRemoteFind,
  runRemoteGrep,
};
