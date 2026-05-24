import { Buffer } from "node:buffer";

export interface GrepCursorToken {
  kind: "grep";
  basePath: string;
  query: string;
  pattern: string;
  mode: "plain" | "regex" | "fuzzy";
  smartCase: boolean;
  maxMatchesPerFile: number;
  beforeContext: number;
  afterContext: number;
  cursorOffset: number;
}

export interface FindCursorToken {
  kind: "find";
  basePath: string;
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
}

type CursorToken = GrepCursorToken | FindCursorToken;

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function parseToken(raw: string, prefix: string): unknown {
  if (!raw.startsWith(prefix)) {
    throw new Error(`Invalid cursor for remote FFF tool: expected ${prefix}<payload>`);
  }
  const payload = raw.slice(prefix.length);
  try {
    return JSON.parse(decodeBase64Url(payload)) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid remote FFF cursor payload: ${message}`);
  }
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid remote FFF cursor: ${name} must be a non-empty string`);
  }
  return value;
}

function assertNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid remote FFF cursor: ${name} must be a finite number`);
  }
  return value;
}

function assertGrepMode(value: unknown): "plain" | "regex" | "fuzzy" {
  if (value === "plain" || value === "regex" || value === "fuzzy") return value;
  throw new Error("Invalid remote FFF cursor: mode is invalid");
}

function encodeCursor(prefix: string, token: CursorToken): string {
  return `${prefix}${encodeBase64Url(JSON.stringify(token))}`;
}

export function encodeGrepCursor(token: GrepCursorToken): string {
  return encodeCursor("rfff_grep_", token);
}

export function decodeGrepCursor(raw: string): GrepCursorToken {
  const parsed = parseToken(raw, "rfff_grep_");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid remote FFF grep cursor: payload must be an object");
  }
  const input = parsed as Record<string, unknown>;
  if (input.kind !== "grep") {
    throw new Error("Invalid remote FFF grep cursor: kind mismatch");
  }
  return {
    kind: "grep",
    basePath: assertString(input.basePath, "basePath"),
    query: assertString(input.query, "query"),
    pattern: assertString(input.pattern, "pattern"),
    mode: assertGrepMode(input.mode),
    smartCase: Boolean(input.smartCase),
    maxMatchesPerFile: assertNumber(input.maxMatchesPerFile, "maxMatchesPerFile"),
    beforeContext: assertNumber(input.beforeContext, "beforeContext"),
    afterContext: assertNumber(input.afterContext, "afterContext"),
    cursorOffset: assertNumber(input.cursorOffset, "cursorOffset"),
  };
}

export function encodeFindCursor(token: FindCursorToken): string {
  return encodeCursor("rfff_find_", token);
}

export function decodeFindCursor(raw: string): FindCursorToken {
  const parsed = parseToken(raw, "rfff_find_");
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid remote FFF find cursor: payload must be an object");
  }
  const input = parsed as Record<string, unknown>;
  if (input.kind !== "find") {
    throw new Error("Invalid remote FFF find cursor: kind mismatch");
  }
  return {
    kind: "find",
    basePath: assertString(input.basePath, "basePath"),
    query: assertString(input.query, "query"),
    pattern: assertString(input.pattern, "pattern"),
    pageSize: assertNumber(input.pageSize, "pageSize"),
    nextPageIndex: assertNumber(input.nextPageIndex, "nextPageIndex"),
  };
}
