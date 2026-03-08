import { AUTOCHECKPOINT_DONE_MARKER, COMPACTION_INSTR_BEGIN } from "../lib/autockpt/autockpt-markers.ts";

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((chunk: any) => chunk?.type === "text" && typeof chunk.text === "string")
    .map((chunk: any) => chunk.text as string)
    .join("\n");
}

export function isMachineControlAssistantText(text: string): boolean {
  return text.trimStart().startsWith("__pictl_result__");
}

export function containsAutockptFooterMarkers(text: string): boolean {
  return text.includes(AUTOCHECKPOINT_DONE_MARKER) || text.includes(COMPACTION_INSTR_BEGIN);
}

export function appendStampToText(text: string, stampLine: string): string {
  const trimmed = text.replace(/\s+$/g, "");
  return `${trimmed}\n\n${stampLine}`;
}
