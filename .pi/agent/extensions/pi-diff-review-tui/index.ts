// @lat: [[pi-diff-review-tui#Pi diff review TUI]]

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewApp } from "./lib/app.ts";
import { buildDiffReviewDebugReport, disposeDiffReviewSshBackend, resolveRepoIdentity } from "./lib/backend.ts";
import { resolveInitialBundleSelection } from "./lib/review-bundles.ts";

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

      let identity;
      try {
        identity = await resolveRepoIdentity(pi, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const sessionId = String(ctx.sessionManager.getSessionId() ?? "").trim();
      let initialMode;
      let initialBundle;
      let notification;
      try {
        ({ initialMode, initialBundle, notification } = await resolveInitialBundleSelection(pi, identity, sessionId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to build initial diff bundle: ${message}`, "error");
        return;
      }
      if (notification) ctx.ui.notify(notification, "info");
      if (!initialBundle.files.length) {
        return;
      }

      await ctx.ui.custom<{ submitted: boolean; outputPath?: string }>(async (tui, theme, keybindings, done) => {
        const app = new DiffReviewApp({
          pi,
          repoRoot: identity.repoRoot,
          repoLabel: identity.repoLabel,
          scopeKey: identity.scopeKey,
          allowRepoRootWrites: identity.allowRepoRootWrites,
          backendKind: identity.backend,
          sshIdentity: identity.ssh,
          sessionId,
          tui,
          theme,
          keybindings,
          callbacks: {
            done,
            notify: (message, type) => ctx.ui.notify(message, type),
            confirm: (title, body) => ctx.ui.confirm(title, body),
            setEditorText: (text) => ctx.ui.setEditorText(text),
          },
        });
        await app.init(initialMode, initialBundle);
        return app;
      }, {
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
