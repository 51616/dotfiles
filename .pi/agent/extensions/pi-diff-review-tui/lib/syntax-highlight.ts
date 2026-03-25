import { highlight, supportsLanguage } from "cli-highlight";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ParsedFilePatch, ParsedRowKind } from "./types.ts";

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedThemeFor: Theme | null = null;
let cachedCliTheme: CliHighlightTheme | null = null;

function buildCliHighlightTheme(theme: Theme): CliHighlightTheme {
  return {
    keyword: (s: string) => theme.fg("syntaxKeyword", s),
    built_in: (s: string) => theme.fg("syntaxType", s),
    literal: (s: string) => theme.fg("syntaxNumber", s),
    number: (s: string) => theme.fg("syntaxNumber", s),
    string: (s: string) => theme.fg("syntaxString", s),
    comment: (s: string) => theme.fg("syntaxComment", s),
    function: (s: string) => theme.fg("syntaxFunction", s),
    title: (s: string) => theme.fg("syntaxFunction", s),
    class: (s: string) => theme.fg("syntaxType", s),
    type: (s: string) => theme.fg("syntaxType", s),
    attr: (s: string) => theme.fg("syntaxVariable", s),
    variable: (s: string) => theme.fg("syntaxVariable", s),
    params: (s: string) => theme.fg("syntaxVariable", s),
    operator: (s: string) => theme.fg("syntaxOperator", s),
    punctuation: (s: string) => theme.fg("syntaxPunctuation", s),
  };
}

function cliTheme(theme: Theme): CliHighlightTheme {
  if (cachedThemeFor !== theme || !cachedCliTheme) {
    cachedThemeFor = theme;
    cachedCliTheme = buildCliHighlightTheme(theme);
  }
  return cachedCliTheme;
}

function lineExactSplit(text: string, fallback: string[]): string[] {
  const lines = text.split("\n");
  return lines.length === fallback.length ? lines : fallback;
}

function highlightableRowText(kind: ParsedRowKind, side: "old" | "new", text: string): string {
  if (kind === "context") return text;
  if (side === "old" && kind === "removed") return text;
  if (side === "new" && kind === "added") return text;
  return "";
}

/**
 * Matches pi-coding-agent's file-extension-to-language mapping enough for diff review.
 * The language ids are highlight.js ids used by cli-highlight.
 */
export function getLanguageFromPath(filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  const lower = filePath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";

  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  if (!ext) return undefined;

  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    cmake: "cmake",
    lua: "lua",
    pl: "perl",
    perl: "perl",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    vim: "vim",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
  };

  return extToLang[ext];
}

export function highlightCodeLines({
  code,
  language,
  theme,
}: {
  code: string;
  language: string | undefined;
  theme: Theme;
}): string[] {
  const normalized = replaceTabs(code);
  const fallback = normalized.split("\n");
  if (!language || !supportsLanguage(language)) return fallback;

  try {
    const highlighted = highlight(normalized, {
      language,
      ignoreIllegals: true,
      theme: cliTheme(theme),
    });
    return lineExactSplit(highlighted, fallback);
  } catch {
    return fallback;
  }
}

export function highlightFileRows({
  file,
  language,
  theme,
}: {
  file: ParsedFilePatch;
  language: string | undefined;
  theme: Theme;
}): Map<number, string> {
  if (!language || !supportsLanguage(language)) return new Map();

  const oldChunkLines = file.rows.map((row) => replaceTabs(highlightableRowText(row.kind, "old", row.text)));
  const newChunkLines = file.rows.map((row) => replaceTabs(highlightableRowText(row.kind, "new", row.text)));
  const oldHighlighted = highlightCodeLines({ code: oldChunkLines.join("\n"), language, theme });
  const newHighlighted = highlightCodeLines({ code: newChunkLines.join("\n"), language, theme });

  const highlightedRows = new Map<number, string>();
  for (const row of file.rows) {
    if (row.kind === "removed") {
      highlightedRows.set(row.rowIndex, oldHighlighted[row.rowIndex] ?? replaceTabs(row.text));
      continue;
    }
    if (row.kind === "added") {
      highlightedRows.set(row.rowIndex, newHighlighted[row.rowIndex] ?? replaceTabs(row.text));
      continue;
    }
    if (row.kind === "context") {
      highlightedRows.set(row.rowIndex, newHighlighted[row.rowIndex] ?? oldHighlighted[row.rowIndex] ?? replaceTabs(row.text));
    }
  }
  return highlightedRows;
}
