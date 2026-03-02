import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  asString,
  readUnitSnapshot,
  shouldEnableMasterServices,
  unitBadge,
} from "./lib/pi-instance-master-services.ts";

export default function piInstanceMaster(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let enabled = false;

  function clearStatus(ctx: ExtensionContext | null) {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus("pi-services", undefined);
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI || !enabled) return;

    const router = readUnitSnapshot("pi-router.service");
    const discord = readUnitSnapshot("pi-discord-bot.service");

    const routerBadge = unitBadge("Router", router);
    const discordBadge = unitBadge("Discord", discord);

    ctx.ui.setStatus("pi-services", `| ${routerBadge} | ${discordBadge}`);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clearStatus(lastCtx);
  }

  pi.on("session_start", async (_event, ctx) => {
    stop();
    lastCtx = ctx;
    if (!ctx?.hasUI) return;

    const cwd = asString(ctx.cwd).trim() || process.cwd();
    enabled = shouldEnableMasterServices(cwd);

    if (!enabled) {
      clearStatus(ctx);
      return;
    }

    render(ctx);
    timer = setInterval(() => {
      try {
        if (!lastCtx) return;
        render(lastCtx);
      } catch {
        // ignore UI/status refresh errors
      }
    }, 15_000);
    timer.unref?.();
  });

  pi.on("session_end", async (_event, ctx) => {
    lastCtx = ctx || lastCtx;
    stop();
    lastCtx = null;
    enabled = false;
  });
}
