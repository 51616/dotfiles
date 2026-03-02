import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export function normalizeSteerMessage(args: string): string {
  return String(args || "").trim();
}

export async function handleSteerCommand({
  args,
  ctx,
  pi,
}: {
  args: string;
  ctx: ExtensionCommandContext;
  pi: ExtensionAPI;
}): Promise<{ ok: boolean; message?: string }> {
  const message = normalizeSteerMessage(args);
  if (!message) {
    if (ctx.hasUI) {
      ctx.ui.notify("Usage: /steer <message>", "warning");
    }
    return { ok: false };
  }

  pi.sendUserMessage(message, { deliverAs: "steer" });

  if (ctx.hasUI) {
    ctx.ui.notify("Steering message queued (bypasses instance-manager queue).", "info");
  }

  return { ok: true, message };
}
