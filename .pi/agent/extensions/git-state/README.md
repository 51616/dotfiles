# git-state

Shows the current local Git working-tree state in the user editor top-right border through `tui-broker`.

Dirty label format:

```text
 main 3 +120 -8
```

Clean label format:

```text
 main CLEAN!
```

- ` main` is the current branch using the common Powerline branch glyph. Detached HEADs are shown as `detached@<short-hash>`.
- `3` is the number of changed files reported by `git status --porcelain=v1 --untracked-files=all`, using the common Nerd Font diff/changed-file glyph.
- `+120 -8` are tracked line additions/deletions from `git diff --numstat HEAD --`.
- Untracked files count toward ``, but their full line counts are intentionally not computed because doing so can be expensive in large generated trees.
- Numbers are ANSI-colored: files are cyan when dirty, additions are green, deletions are red, and `CLEAN!` is green.

The extension does not own TUI surfaces directly. It registers a `tui-broker` editor top-right status provider and asks the broker to refresh when polling detects a changed snapshot.
