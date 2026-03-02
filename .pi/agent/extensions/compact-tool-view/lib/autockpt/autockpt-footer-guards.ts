import { existsSync, statSync } from "node:fs";
import {
  AUTOCHECKPOINT_DONE_MARKER,
  COMPACTION_INSTR_BEGIN,
  COMPACTION_INSTR_END,
} from "./autockpt-markers.ts";

const NL = "\\r?\\n";
const INDENT = "[\\t ]*";

// Footer parser should be robust to indentation because the directive message shows the markers
// inside an indented list. We still require the markers to appear as standalone lines (optionally
// preceded/followed by spaces/tabs).
const FOOTER_WITH_INSTR_RE = new RegExp(
  `(?:^|${NL})${INDENT}${COMPACTION_INSTR_BEGIN}${INDENT}${NL}` +
    `([\\s\\S]*?)` +
    `${NL}${INDENT}${COMPACTION_INSTR_END}${INDENT}` +
    `(?:${NL}${INDENT})+` +
    `${INDENT}${AUTOCHECKPOINT_DONE_MARKER}\\s+path=([^\\r\\n]+?)\\s*$`,
);

export function shouldParseFooterGate(args: {
  handledThisTurn: boolean;
  role: unknown;
  contextPercent: number | null | undefined;
  thresholdPercent: number;
}): boolean {
  if (args.handledThisTurn) return false;
  if (String(args.role || "") !== "assistant") return false;
  const pct = args.contextPercent;
  if (pct === null || pct === undefined) return false;
  return pct >= args.thresholdPercent;
}

export function assistantTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as any).type === "text" &&
        typeof (item as any).text === "string",
    )
    .map((item) => String((item as any).text))
    .join("\n");
}

export function parseCheckpointFooter(
  text: unknown,
  maxInstructionChars = 8000,
): { checkpointPath: string; compactionInstructions: string } | null {
  const raw = String(text || "");
  const matched = raw.match(FOOTER_WITH_INSTR_RE);
  if (!matched) return null;

  const checkpointPath = String(matched[2] || "").trim();
  if (!checkpointPath) return null;

  let compactionInstructions = String(matched[1] || "").trim();
  if (compactionInstructions && compactionInstructions.length > maxInstructionChars) {
    compactionInstructions = compactionInstructions.slice(0, maxInstructionChars);
  }

  return { checkpointPath, compactionInstructions };
}

export function isLikelyCheckpointPath(checkpointPath: string): boolean {
  return (
    checkpointPath.length > 0 &&
    checkpointPath.startsWith("work/log/checkpoints/") &&
    checkpointPath.endsWith(".md") &&
    !checkpointPath.includes("<") &&
    !checkpointPath.includes(">") &&
    !checkpointPath.includes("`")
  );
}

export function isFreshCheckpointFile(checkpointPath: string, maxCheckpointAgeMs: number): boolean {
  if (!isLikelyCheckpointPath(checkpointPath)) return false;
  if (!existsSync(checkpointPath)) return false;

  if (maxCheckpointAgeMs <= 0) return true;

  try {
    const st = statSync(checkpointPath);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs <= maxCheckpointAgeMs;
  } catch {
    return false;
  }
}
