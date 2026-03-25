import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TUI } from "@mariozechner/pi-tui";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || "nvim";
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
  const editorCmd = resolveEditorCommand();
  const fullPath = path.resolve(repoRoot, relativePath);

  try {
    tui.stop();
    if (process.platform === "win32") {
      const args = [lineTargeted && line ? `+${line}` : undefined, fullPath].filter(Boolean) as string[];
      const result = spawnSync(editorCmd, args, { stdio: "inherit", shell: true });
      return { status: result.status };
    }

    const command = [
      editorCmd,
      lineTargeted && line ? `+${line}` : undefined,
      shellEscape(fullPath),
    ].filter(Boolean).join(" ");
    const result = spawnSync("/bin/sh", ["-lc", command], { stdio: "inherit" });
    return { status: result.status };
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}
