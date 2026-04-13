import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type SelfCheckpointingDebugFile = {
  append: (ctx: ExtensionContext, line: string) => void;
  logPathFor: (ctx: ExtensionContext) => string | null;
};

function sessionIdFor(ctx: ExtensionContext): string {
  try {
    const sid = (ctx as any)?.sessionManager?.getSessionId?.();
    return String(sid || "").trim();
  } catch {
    return "";
  }
}

function sessionHashFor(ctx: ExtensionContext): string {
  const sid = sessionIdFor(ctx);
  const basis = sid || `no-session:${process.pid}`;
  return createHash("sha1").update(basis).digest("hex").slice(0, 12);
}

export function createSelfCheckpointingDebugFile(options: {
  pendingDir: string;
  pathOverride?: string;
  isEnabled: () => boolean;
  pid: number;
}): SelfCheckpointingDebugFile {
  const override = String(options.pathOverride || "").trim();

  const logPathFor = (ctx: ExtensionContext): string | null => {
    if (!options.isEnabled()) return null;
    if (override) return override;
    return path.join(options.pendingDir, `debug.${sessionHashFor(ctx)}.jsonl`);
  };

  const append = (ctx: ExtensionContext, line: string) => {
    const logPath = logPathFor(ctx);
    if (!logPath) return;

    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(
        logPath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          pid: options.pid,
          sessionId: sessionIdFor(ctx) || null,
          cwd: (() => {
            try {
              return (ctx as any)?.sessionManager?.getCwd?.() ?? null;
            } catch {
              return null;
            }
          })(),
          line,
        })}\n`,
        "utf8",
      );
    } catch {
      // ignore debug-file failures
    }
  };

  return {
    append,
    logPathFor,
  };
}
