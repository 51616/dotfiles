export const DO_NOT_STOP_PROMPT =
  "Do not stop yet. Audit your work for gaps, improvements, and unimplemented features. If this is a track, finish the track. For any solid next step you find, make a plan and implement it immediately.";

export const DEFAULT_DO_NOT_STOP_REPEATS = 1;

export type DoNotStopCommand =
  | { kind: "toggle" }
  | { kind: "set"; enabled: boolean }
  | { kind: "setRepeats"; repeats: number }
  | { kind: "status" }
  | { kind: "help"; invalid?: string };

export function brightRed(text: string): string {
  return `\x1b[91m${text}\x1b[0m`;
}

export function buildDoNotStopBorderLabel(options: { step: number; total: number }): string {
  const step = Math.max(0, options.step);
  const total = Math.max(0, options.total);
  return `↻ repeat ${step}/${total}`;
}

export function normalizeDoNotStopRepeats(value: unknown, fallback = DEFAULT_DO_NOT_STOP_REPEATS): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(999, n);
}

export function parseDoNotStopCommand(args: string): DoNotStopCommand {
  const tokens = String(args ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const first = tokens[0];

  if (!first || first === "toggle") return { kind: "toggle" };
  if (first === "on" || first === "enable" || first === "enabled") return { kind: "set", enabled: true };
  if (first === "off" || first === "disable" || first === "disabled") return { kind: "set", enabled: false };
  if (first === "status") return { kind: "status" };

  if (first === "repeats" || first === "set") {
    const next = tokens[1];
    const repeats = normalizeDoNotStopRepeats(next, Number.NaN);
    if (!Number.isFinite(repeats)) {
      return { kind: "help", invalid: next ? `${first} ${next}` : first };
    }
    return { kind: "setRepeats", repeats };
  }

  if (first === "help") return { kind: "help" };
  return { kind: "help", invalid: first };
}

export function isExtensionInputSource(source: unknown): boolean {
  return String(source ?? "").trim().toLowerCase() === "extension";
}

export function shouldArmDoNotStopFollowUp(options: {
  enabled: boolean;
  text: string;
  source?: unknown;
}): boolean {
  if (!options.enabled) return false;

  const text = String(options.text ?? "").trim();
  if (!text) return false;
  if (text.startsWith("/")) return false;
  if (text === DO_NOT_STOP_PROMPT) return false;
  if (isExtensionInputSource(options.source)) return false;

  return true;
}

export function shouldDispatchDoNotStopFollowUp(options: {
  enabled: boolean;
  pendingRepeats: number;
  isIdle: boolean;
  hasPendingMessages: boolean;
}): boolean {
  return Boolean(options.enabled && options.pendingRepeats > 0 && options.isIdle && !options.hasPendingMessages);
}
