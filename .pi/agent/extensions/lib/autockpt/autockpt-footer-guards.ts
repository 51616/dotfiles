import { existsSync, statSync } from "node:fs";
import {
  AUTOCHECKPOINT_DONE_MARKER,
  COMPACTION_INSTR_BEGIN,
  COMPACTION_INSTR_END,
} from "./autockpt-markers.ts";

const NL = "\\r?\\n";
const INDENT = "[\\t ]*";

// Footer parser should be robust to indentation because the directive message shows the markers
// inside an indented list.
//
// In practice, the LLM sometimes adds markdown bullets/backticks or slightly different whitespace.
// This parser is intentionally tolerant so compaction remains reliable.
const INSTRUCTION_BLOCK_RE = new RegExp(
  `(?:^|${NL})${INDENT}${COMPACTION_INSTR_BEGIN}${INDENT}${NL}` +
    `([\\s\\S]*?)` +
    `${NL}${INDENT}${COMPACTION_INSTR_END}${INDENT}(?:${NL}|$)`,
);

// Matches lines like:
//   __pi_autocheckpoint_done__ path=work/log/checkpoints/....md
// and tolerates bullets / surrounding backticks:
//   - `__pi_autocheckpoint_done__ path=...md.`
const DONE_LINE_RE = new RegExp(
  `^${INDENT}(?:[-*]\\s*)?(?:\`+)?${AUTOCHECKPOINT_DONE_MARKER}(?:\`+)?(?:\\s+path=([^\\r\\n]+?))?\\s*$`,
  "gm",
);

function sanitizeCheckpointPath(value: string): string {
  let p = String(value || "").trim();

  // Strip common markdown wrappers.
  p = p.replace(/^[`"']+/, "").replace(/[`"']+$/, "");

  // Strip common trailing punctuation that the model sometimes appends.
  // (Keep this conservative so we don't mangle valid paths.)
  p = p.replace(/[\]\)\.,;:]+$/, "");

  // Occasionally the path gets wrapped in parentheses.
  p = p.replace(/^\(+/, "").replace(/\)+$/, "");

  return p.trim();
}

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
  if (!raw.includes(AUTOCHECKPOINT_DONE_MARKER)) return null;

  // Extract the last done-marker line. (The directive message may contain examples earlier.)
  const matches = Array.from(raw.matchAll(DONE_LINE_RE));
  if (!matches.length) return null;

  const last = matches[matches.length - 1];
  const checkpointPathRaw = sanitizeCheckpointPath(String(last?.[1] || ""));
  if (!checkpointPathRaw) return null;

  let compactionInstructions = "";
  const instrMatch = raw.match(INSTRUCTION_BLOCK_RE);
  if (instrMatch) {
    compactionInstructions = String(instrMatch[1] || "").trim();
    if (compactionInstructions.length > maxInstructionChars) {
      compactionInstructions = compactionInstructions.slice(0, maxInstructionChars);
    }
  }

  return { checkpointPath: checkpointPathRaw, compactionInstructions };
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
