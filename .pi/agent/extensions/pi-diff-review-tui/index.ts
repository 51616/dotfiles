import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffReviewApp } from "./lib/app.ts";
import { getDiffBundle, getLatestTurnBundle, getRepoRoot } from "./lib/git.ts";
import type { DiffScope } from "./lib/types.ts";

function noTurnDiffMessage(): string {
  return "No last-turn agent-touched diff was found for this session; falling back to unstaged scope.";
}

export default function piDiffReviewTui(pi: ExtensionAPI) {
  pi.registerCommand("diff-review", {
    description: "Open a pi-native TUI diff review overlay",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/diff-review requires an interactive TUI session.", "warning");
        return;
      }

      let repoRoot = "";
      try {
        repoRoot = await getRepoRoot(pi, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const sessionId = String(ctx.sessionManager.getSessionId() ?? "").trim();
      let initialScope: DiffScope = "u";
      const turnBundle = getLatestTurnBundle(repoRoot, sessionId);
      if (turnBundle?.files.length) {
        initialScope = "t";
      } else if (turnBundle) {
        ctx.ui.notify(turnBundle.turnMetadata?.note || noTurnDiffMessage(), "info");
      }

      const initial = initialScope === "t"
        ? turnBundle as NonNullable<typeof turnBundle>
        : await getDiffBundle(pi, repoRoot, "u", { sessionId });
      if (!initial.files.length) {
        ctx.ui.notify(initialScope === "t" ? noTurnDiffMessage() : "No diff to review in unstaged scope.", "info");
        return;
      }

      await ctx.ui.custom<{ submitted: boolean; outputPath?: string }>(async (tui, theme, keybindings, done) => {
        const app = new DiffReviewApp({
          pi,
          repoRoot,
          sessionId,
          tui,
          theme,
          keybindings,
          callbacks: {
            done,
            notify: (message, type) => ctx.ui.notify(message, type),
            setEditorText: (text) => ctx.ui.setEditorText(text),
          },
        });
        await app.init(initialScope);
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
