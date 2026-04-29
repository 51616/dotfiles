# Git state

This extension owns the live Git working-tree meter shown in the user editor top-right border.

## Git state editor meter

The canonical entrypoint is [[git-state/index.ts]]. It registers a `tui-broker` editor top-right status provider instead of owning editor or footer surfaces directly.

The dirty label is ` <branch> <files> +<additions> -<deletions>`, and the all-zero clean label is ` <branch> CLEAN!`. The branch segment is normal foreground text, while counts keep their colored status accents. The branch name comes from `git branch --show-current`, with detached HEADs shown as `detached@<short-hash>`. File count comes from `git status --porcelain=v1 --untracked-files=all`, so untracked files are included in the file count. Line additions and deletions come from `git diff --numstat HEAD --`, with a no-`HEAD` fallback to `git diff --numstat --`; untracked file line counts are intentionally not computed because that can be expensive in large generated trees.

The extension polls the active session cwd every three seconds and also refreshes around agent/tool lifecycle events. It updates the broker only when the snapshot signature changes, which keeps redraws cheap and avoids direct TUI ownership.
