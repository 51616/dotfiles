import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  formatQuotaStatus,
  readLatestCodexSessionRateLimits,
} from "./lib/quota-footer.ts";

const STATUS_KEY = "quota-footer";
const POLL_INTERVAL_MS = 60_000;

let activeCtx: ExtensionContext | null = null;
let refreshInFlight = false;
let interval: ReturnType<typeof setInterval> | undefined;
let generation = 0;

async function refreshQuotaStatus(): Promise<void> {
  const ctx = activeCtx;
  if (!ctx?.hasUI || refreshInFlight) return;

  refreshInFlight = true;
  const refreshGeneration = generation;

  try {
    const snapshot = await readLatestCodexSessionRateLimits();
    if (refreshGeneration === generation) {
      ctx.ui.setStatus(STATUS_KEY, formatQuotaStatus(snapshot));
    }
  } catch {
    if (refreshGeneration === generation) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  } finally {
    refreshInFlight = false;
  }
}

function startQuotaFooter(ctx: ExtensionContext): void {
  activeCtx = ctx;
  generation += 1;

  if (interval) clearInterval(interval);
  interval = setInterval(() => {
    void refreshQuotaStatus();
  }, POLL_INTERVAL_MS);
  interval.unref?.();

  void refreshQuotaStatus();
}

function stopQuotaFooter(): void {
  const ctx = activeCtx;
  activeCtx = null;
  generation += 1;

  if (interval) clearInterval(interval);
  interval = undefined;

  if (ctx?.hasUI) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export default function quotaFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startQuotaFooter(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startQuotaFooter(ctx);
  });

  pi.on("session_fork", (_event, ctx) => {
    if (!ctx.hasUI) return;
    startQuotaFooter(ctx);
  });

  pi.on("agent_end", () => {
    void refreshQuotaStatus();
  });

  pi.on("session_shutdown", () => {
    stopQuotaFooter();
  });
}
