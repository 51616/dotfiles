import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TUI } from "@mariozechner/pi-tui";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || "nvim";
}

export function openExternalEditorPath({
  tui,
  filePath,
  line,
  lineTargeted,
}: {
  tui: TUI;
  filePath: string;
  line?: number | null;
  lineTargeted: boolean;
}): { status: number | null } {
  const editorCmd = resolveEditorCommand();

  try {
    tui.stop();
    if (process.platform === "win32") {
      const args = [lineTargeted && line ? `+${line}` : undefined, filePath].filter(Boolean) as string[];
      const result = spawnSync(editorCmd, args, { stdio: "inherit", shell: true });
      return { status: result.status };
    }

    const command = [
      editorCmd,
      lineTargeted && line ? `+${line}` : undefined,
      shellEscape(filePath),
    ].filter(Boolean).join(" ");
    const result = spawnSync("/bin/sh", ["-lc", command], { stdio: "inherit" });
    return { status: result.status };
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

export function openExternalEditor({
  tui,
  repoRoot,
  relativePath,
  line,
  lineTargeted,
}: {
  tui: TUI;
  repoRoot: string;
  relativePath: string;
  line?: number | null;
  lineTargeted: boolean;
}): { status: number | null } {
  return openExternalEditorPath({
    tui,
    filePath: path.resolve(repoRoot, relativePath),
    line,
    lineTargeted,
  });
}
