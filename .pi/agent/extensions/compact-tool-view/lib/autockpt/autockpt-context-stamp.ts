import { CHECKPOINT_NOW_MARKER, CONTEXT_STAMP_MARKER } from "./autockpt-markers.ts";

/**
 * Context-stamp detection helpers.
 *
 * Why this exists:
 * - Self-checkpointing uses a marker in tool results to interrupt and inject a checkpoint directive.
 * - Tool output can legitimately contain the raw marker string (e.g. when reading source files).
 * - Therefore we only treat the marker as "armed" when it appears in the *trailing* context-stamp
 *   line format.
 */

export function isContextStampLine(line: string): boolean {
  const s = String(line ?? "").trim();
  if (!s.startsWith(CONTEXT_STAMP_MARKER)) return false;
  if (!s.includes(CHECKPOINT_NOW_MARKER)) return false;

  // Keep this loose enough to survive minor formatting tweaks, but strict enough to prevent
  // accidental matches from source code or logs.
  if (!/\bused=\d+\b/.test(s)) return false;
  if (!/\bwindow=\d+\b/.test(s)) return false;

  return true;
}

export function hasTrailingCheckpointNowStamp(text: unknown): boolean {
  const raw = String(text ?? "");
  const trimmed = raw.replace(/\s+$/g, "");
  if (!trimmed) return false;

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    return isContextStampLine(line);
  }

  return false;
}
