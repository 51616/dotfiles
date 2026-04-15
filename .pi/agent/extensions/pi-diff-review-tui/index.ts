// @lat: [[pi-diff-review-tui#Pi diff review TUI]]

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewLauncher } from "./lib/launcher.ts";
import { buildDiffReviewDebugReport, disposeDiffReviewSshBackend } from "./lib/backend.ts";

export default function piDiffReviewTui(pi: ExtensionAPI) {
  if (typeof (pi as unknown as { on?: unknown }).on === "function") {
    pi.on("session_shutdown", () => {
      disposeDiffReviewSshBackend();
    });
  }

  pi.registerCommand("diff-review", {
    description: "Open a pi-native TUI diff review overlay",
    handler: async (args, ctx) => {
      if (args.includes("debug") || args.includes("--debug")) {
        const report = await buildDiffReviewDebugReport(pi, ctx.cwd);
        console.error(report);
        if (ctx.hasUI) {
          ctx.ui.notify("Printed diff-review debug report to stderr.", "info");
        }
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/diff-review requires an interactive TUI session.", "error");
        return;
      }

      const sessionId = String(ctx.sessionManager.getSessionId() ?? "").trim();

      await ctx.ui.custom<{ submitted: boolean; outputPath?: string }>(async (tui, theme, keybindings, done) => new DiffReviewLauncher({
        pi,
        cwd: ctx.cwd,
        sessionId,
        tui,
        theme,
        keybindings,
        done,
        notify: (message, type) => ctx.ui.notify(message, type),
        confirm: (title, body) => ctx.ui.confirm(title, body),
        setEditorText: (text) => ctx.ui.setEditorText(text),
      }), {
        overlay: true,
        overlayOptions: {
          width: "90%",
          maxHeight: "98%",
          anchor: "center",
        },
      });
    },
  });
}
