import { createHash } from "node:crypto";
import type { FileStatus, ParsedDiffRow, ParsedFilePatch, ParsedHunk } from "./types.ts";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function splitPatchIntoFileSections(patchText: string): string[] {
  const text = patchText.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

function stripPrefixPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/dev/null") return null;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

export function inferStatusFromPatch(rawPatch: string, fallback: FileStatus = "M"): FileStatus {
  const text = rawPatch;
  if (/^new file mode /m.test(text)) return "A";
  if (/^deleted file mode /m.test(text)) return "D";
  if (/^rename from /m.test(text) || /^rename to /m.test(text)) return "R";
  if (/^Binary files /m.test(text) || /^GIT binary patch$/m.test(text)) return "B";
  return fallback;
}

export function parsePatchPaths(rawPatch: string): {
  oldPath: string | null;
  newPath: string | null;
} {
  const lines = rawPatch.replace(/\r\n/g, "\n").split("\n");
  let oldPath: string | null = null;
  let newPath: string | null = null;

  const diffGit = lines.find((line) => line.startsWith("diff --git "));
  if (diffGit) {
    const match = diffGit.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      oldPath = match[1] ?? null;
      newPath = match[2] ?? null;
    }
  }

  const fromLine = lines.find((line) => line.startsWith("--- "));
  const toLine = lines.find((line) => line.startsWith("+++ "));
  if (fromLine) oldPath = stripPrefixPath(fromLine.slice(4));
  if (toLine) newPath = stripPrefixPath(toLine.slice(4));

  return { oldPath, newPath };
}

export function buildFileKey(status: FileStatus, oldPath: string | null, newPath: string | null): string {
  return `${status}:${oldPath ?? ""}->${newPath ?? ""}`;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | null {
  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1] ?? "0", 10),
    oldCount: Number.parseInt(match[2] ?? "1", 10),
    newStart: Number.parseInt(match[3] ?? "0", 10),
    newCount: Number.parseInt(match[4] ?? "1", 10),
  };
}

function lineTextForBody(line: string): string {
  if (!line) return "";
  return line.length > 0 ? line.slice(1) : "";
}

export function parseSingleFilePatch({
  rawPatch,
  status,
  oldPath,
  newPath,
}: {
  rawPatch: string;
  status?: FileStatus;
  oldPath?: string | null;
  newPath?: string | null;
}): ParsedFilePatch {
  const patchText = rawPatch.replace(/\r\n/g, "\n").trimEnd();
  const inferred = inferStatusFromPatch(patchText, status ?? "M");
  const parsedPaths = parsePatchPaths(patchText);
  const effectiveOldPath = oldPath ?? parsedPaths.oldPath;
  const effectiveNewPath = newPath ?? parsedPaths.newPath;
  const fileKey = buildFileKey(inferred, effectiveOldPath, effectiveNewPath);
  const displayPath = inferred === "R"
    ? `${effectiveOldPath ?? "(unknown)"} → ${effectiveNewPath ?? "(unknown)"}`
    : effectiveNewPath ?? effectiveOldPath ?? "(unknown)";
  const editablePath = inferred === "D" ? null : (effectiveNewPath ?? effectiveOldPath);

  const lines = patchText ? patchText.split("\n") : [];
  const rows: ParsedDiffRow[] = [];
  const hunks: ParsedHunk[] = [];
  let currentHunk: ParsedHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let isBinary = inferred === "B";

  for (const line of lines) {
    const rowIndex = rows.length;

    if (line.startsWith("@@ ")) {
      const parsed = parseHunkHeader(line);
      if (parsed) {
        if (currentHunk) currentHunk.rowEnd = rowIndex - 1;
        currentHunk = {
          id: `${fileKey}:hunk:${hunks.length + 1}`,
          header: line,
          oldStart: parsed.oldStart,
          oldCount: parsed.oldCount,
          newStart: parsed.newStart,
          newCount: parsed.newCount,
          rowStart: rowIndex,
          rowEnd: rowIndex,
        };
        hunks.push(currentHunk);
        oldLine = parsed.oldStart;
        newLine = parsed.newStart;
      }

      rows.push({
        kind: "hunk_header",
        text: line,
        rawText: line,
        fileKey,
        hunkId: currentHunk?.id,
        rowIndex,
      });
      continue;
    }

    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      isBinary = true;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      rows.push({
        kind: "no_newline",
        text: line,
        rawText: line,
        fileKey,
        hunkId: currentHunk?.id,
        rowIndex,
      });
      continue;
    }

    if (currentHunk && line.startsWith(" ")) {
      rows.push({
        kind: "context",
        text: lineTextForBody(line),
        rawText: line,
        oldLine,
        newLine,
        fileKey,
        hunkId: currentHunk.id,
        rowIndex,
      });
      oldLine += 1;
      newLine += 1;
      currentHunk.rowEnd = rowIndex;
      continue;
    }

    if (currentHunk && line.startsWith("-") && !line.startsWith("--- ")) {
      rows.push({
        kind: "removed",
        text: lineTextForBody(line),
        rawText: line,
        oldLine,
        fileKey,
        hunkId: currentHunk.id,
        rowIndex,
      });
      oldLine += 1;
      currentHunk.rowEnd = rowIndex;
      continue;
    }

    if (currentHunk && line.startsWith("+") && !line.startsWith("+++ ")) {
      rows.push({
        kind: "added",
        text: lineTextForBody(line),
        rawText: line,
        newLine,
        fileKey,
        hunkId: currentHunk.id,
        rowIndex,
      });
      newLine += 1;
      currentHunk.rowEnd = rowIndex;
      continue;
    }

    rows.push({
      kind: "meta",
      text: line,
      rawText: line,
      fileKey,
      rowIndex,
    });
  }

  if (currentHunk) currentHunk.rowEnd = rows.length - 1;
  if (isBinary && !rows.some((row) => row.text.includes("binary diff not shown"))) {
    rows.push({
      kind: "meta",
      text: "Binary diff not shown",
      rawText: "Binary diff not shown",
      fileKey,
      rowIndex: rows.length,
    });
  }

  return {
    fileKey,
    status: inferred,
    oldPath: effectiveOldPath,
    newPath: effectiveNewPath,
    displayPath,
    editablePath,
    rawPatch: patchText,
    rows,
    hunks,
    isBinary,
  };
}

export function compactSnippetFromRows(rows: ParsedDiffRow[], rowIndex: number, radius = 3): string {
  if (!rows.length) return "";
  const target = rows[Math.max(0, Math.min(rows.length - 1, rowIndex))];
  const hunkId = target?.hunkId;
  if (!hunkId) {
    const start = Math.max(0, rowIndex - radius);
    const end = Math.min(rows.length - 1, rowIndex + radius);
    return rows.slice(start, end + 1).map((row) => row.rawText).join("\n");
  }

  const hunkRows = rows.filter((row) => row.hunkId === hunkId);
  const headerRow = rows.find((row) => row.kind === "hunk_header" && row.hunkId === hunkId);
  const relativeIndex = hunkRows.findIndex((row) => row.rowIndex === rowIndex);
  const start = Math.max(0, relativeIndex - radius);
  const end = Math.min(hunkRows.length - 1, relativeIndex + radius);
  const snippetRows = hunkRows.slice(start, end + 1);
  const raw = [headerRow?.rawText, ...snippetRows.map((row) => row.rawText)].filter(Boolean);
  return raw.join("\n");
}

export function snippetFromRowRange(rows: ParsedDiffRow[], startRowIndex: number, endRowIndex: number, padding = 2): string {
  if (!rows.length) return "";
  const start = Math.max(0, Math.min(startRowIndex, endRowIndex));
  const end = Math.min(rows.length - 1, Math.max(startRowIndex, endRowIndex));
  const first = rows[start];
  const last = rows[end];
  const hunkId = first?.hunkId && first?.hunkId === last?.hunkId ? first.hunkId : null;

  if (!hunkId) {
    const sliceStart = Math.max(0, start - padding);
    const sliceEnd = Math.min(rows.length - 1, end + padding);
    return rows.slice(sliceStart, sliceEnd + 1).map((row) => row.rawText).join("\n");
  }

  const hunkRows = rows.filter((row) => row.hunkId === hunkId);
  const headerRow = rows.find((row) => row.kind === "hunk_header" && row.hunkId === hunkId);
  const relativeStart = hunkRows.findIndex((row) => row.rowIndex === start);
  const relativeEnd = hunkRows.findIndex((row) => row.rowIndex === end);
  const sliceStart = Math.max(0, Math.min(relativeStart, relativeEnd) - padding);
  const sliceEnd = Math.min(hunkRows.length - 1, Math.max(relativeStart, relativeEnd) + padding);
  const snippetRows = hunkRows.slice(sliceStart, sliceEnd + 1);
  const raw = [headerRow?.rawText, ...snippetRows.map((row) => row.rawText)].filter(Boolean);
  return raw.join("\n");
}

export function fileSnippetFromRows(rows: ParsedDiffRow[], limit = 8): string {
  const visible = rows
    .filter((row) => row.kind !== "meta")
    .slice(0, Math.max(1, limit));
  if (!visible.length) {
    return rows.slice(0, Math.max(1, limit)).map((row) => row.rawText).join("\n");
  }
  return visible.map((row) => row.rawText).join("\n");
}

export function fullHunkText(rows: ParsedDiffRow[], hunkId: string | null | undefined): string {
  if (!hunkId) return "";
  return rows.filter((row) => row.hunkId === hunkId || (row.kind === "hunk_header" && row.hunkId === hunkId)).map((row) => row.rawText).join("\n");
}
