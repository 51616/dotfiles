export type FooterHandledRecord = {
  checkpointPath: string;
  handledAtMs: number;
};

export function parseFooterDedupeWindowMs(raw: unknown, fallbackMs = 15_000): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return Math.min(n, 600_000);
}

export function shouldSkipDuplicateFooter(args: {
  lastHandled: FooterHandledRecord | null;
  checkpointPath: string;
  nowMs: number;
  dedupeWindowMs: number;
}): boolean {
  if (args.dedupeWindowMs <= 0) return false;
  if (!args.lastHandled) return false;
  if (args.lastHandled.checkpointPath !== args.checkpointPath) return false;

  return args.nowMs - args.lastHandled.handledAtMs <= args.dedupeWindowMs;
}

export function markFooterHandled(checkpointPath: string, nowMs: number): FooterHandledRecord {
  return {
    checkpointPath,
    handledAtMs: nowMs,
  };
}
