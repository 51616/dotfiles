import type { ExtensionAPI, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";
import { DiffReviewApp } from "./app.ts";
import { renderStatusShell } from "./app-shell-render.ts";
import { resolveInitialBundleSelection } from "./review-bundles.ts";
import { resolveRepoIdentity } from "./backend.ts";

export class DiffReviewLauncher implements Component, Focusable {
  focused = false;

  private readonly theme: Theme;
  private readonly done: (result: { submitted: boolean; outputPath?: string }) => void;
  private app: DiffReviewApp | null = null;
  private loadingMessage = "Resolving repo…";
  private closed = false;

  constructor({
    pi,
    cwd,
    sessionId,
    tui,
    theme,
    keybindings,
    done,
    notify,
    confirm,
    setEditorText,
  }: {
    pi: ExtensionAPI;
    cwd: string;
    sessionId: string;
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    done: (result: { submitted: boolean; outputPath?: string }) => void;
    notify: (message: string, type: "info" | "success" | "warning" | "error") => void;
    confirm: (title: string, body: string) => Promise<boolean>;
    setEditorText: (text: string) => void;
  }) {
    this.theme = theme;
    this.done = done;
    void this.start({ pi, cwd, sessionId, tui, theme, keybindings, notify, confirm, setEditorText });
  }

  private finish(result: { submitted: boolean; outputPath?: string } = { submitted: false }): void {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  private async start({
    pi,
    cwd,
    sessionId,
    tui,
    theme,
    keybindings,
    notify,
    confirm,
    setEditorText,
  }: {
    pi: ExtensionAPI;
    cwd: string;
    sessionId: string;
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    notify: (message: string, type: "info" | "success" | "warning" | "error") => void;
    confirm: (title: string, body: string) => Promise<boolean>;
    setEditorText: (text: string) => void;
  }): Promise<void> {
    let identity;
    try {
      identity = await resolveRepoIdentity(pi, cwd);
    } catch (error) {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      notify(message, "error");
      this.finish();
      return;
    }
    if (this.closed) return;

    this.loadingMessage = "Loading diff…";
    tui.requestRender();

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
        done: (result) => this.finish(result),
        notify,
        confirm,
        setEditorText,
      },
    });
    this.app = app;
    tui.requestRender();

    await app.initInitialSelection(() => resolveInitialBundleSelection(pi, identity, sessionId));
  }

  invalidate(): void {
    this.app?.invalidate();
  }

  handleInput(data: string): void {
    if (this.app) {
      this.app.handleInput(data);
      return;
    }
    if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
      this.finish();
    }
  }

  render(width: number): string[] {
    if (this.app) {
      return this.app.render(width);
    }
    return renderStatusShell({ theme: this.theme, width, title: "π Diff Review", message: this.loadingMessage });
  }
}
