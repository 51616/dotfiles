import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CustomEditor,
  keyHint,
  type KeybindingsManager,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { getKeybindings, truncateToWidth, type Component, type EditorTheme, type Focusable, type TUI } from "@mariozechner/pi-tui";
import { bottomBorder, boxLine, topBorder } from "./ui-helpers.ts";

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text: string) => theme.fg("borderMuted", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("muted", text),
      noMatch: (text: string) => theme.fg("muted", text),
    },
  };
}

export class CommentEditorOverlay implements Component, Focusable {
  focused = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly title: string;
  private readonly contextLabel?: string;
  private readonly snippetLines: string[];
  private readonly editor: CustomEditor;
  private readonly emptySubmitHint?: string;
  private readonly onSubmit: (value: string) => void;
  private readonly onCancel: () => void;

  constructor({
    tui,
    theme,
    keybindings,
    title,
    contextLabel,
    snippetLines,
    prefill,
    emptySubmitHint,
    onSubmit,
    onCancel,
  }: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    title: string;
    contextLabel?: string;
    snippetLines?: string[];
    prefill?: string;
    emptySubmitHint?: string;
    onSubmit: (value: string) => void;
    onCancel: () => void;
  }) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.title = title;
    this.contextLabel = contextLabel;
    this.snippetLines = snippetLines ?? [];
    this.emptySubmitHint = emptySubmitHint;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;

    this.editor = new CustomEditor(tui, createEditorTheme(theme), keybindings, { paddingX: 0 });
    this.editor.focused = true;
    this.editor.onSubmit = (text) => this.onSubmit(text);
    if (prefill) this.editor.setText(prefill);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, "app.editor.external")) {
      this.openExternalEditor();
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const inner = Math.max(30, width - 2);
    const lines: string[] = [topBorder(this.theme, this.title, inner, "accent")];
    if (this.contextLabel) {
      lines.push(boxLine(this.theme, "│", `${this.theme.fg("muted", "target")} ${this.theme.fg("accent", this.contextLabel)}`, inner, "│", "accent"));
      lines.push(boxLine(this.theme, "│", "", inner, "│", "accent"));
    }
    if (this.snippetLines.length) {
      lines.push(boxLine(this.theme, "│", this.theme.fg("muted", "diff context (read-only)"), inner, "│", "accent"));
      for (const rawLine of this.snippetLines.slice(0, 12)) {
        lines.push(boxLine(this.theme, "│", this.theme.fg("dim", truncateToWidth(rawLine, inner, "…", true)), inner, "│", "accent"));
      }
      lines.push(boxLine(this.theme, "│", "", inner, "│", "accent"));
    }
    for (const line of this.editor.render(inner)) {
      lines.push(boxLine(this.theme, "│", line, inner, "│", "accent"));
    }
    lines.push(boxLine(this.theme, "│", "", inner, "│", "accent"));
    if (this.emptySubmitHint) {
      lines.push(boxLine(this.theme, "│", this.theme.fg("muted", this.emptySubmitHint), inner, "│", "accent"));
    }
    const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
    const hint = keyHint("tui.select.confirm", "submit")
      + "  "
      + keyHint("tui.input.newLine", "newline")
      + "  "
      + keyHint("tui.select.cancel", "cancel")
      + (hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
    lines.push(boxLine(this.theme, "│", this.theme.fg("dim", hint), inner, "│", "accent"));
    lines.push(bottomBorder(this.theme, inner, "accent"));
    return lines;
  }

  private openExternalEditor(): void {
    const editorCmd = process.env.VISUAL || process.env.EDITOR;
    if (!editorCmd) return;

    const currentText = this.editor.getText();
    const tmpFile = path.join(os.tmpdir(), `pi-extension-editor-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpFile, currentText, "utf8");
      this.tui.stop();
      const [editor, ...editorArgs] = editorCmd.split(" ");
      const result = spawnSync(editor, [...editorArgs, tmpFile], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      if (result.status === 0) {
        this.editor.setText(fs.readFileSync(tmpFile, "utf8").replace(/\n$/, ""));
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
      this.tui.start();
      this.tui.requestRender(true);
    }
  }
}
