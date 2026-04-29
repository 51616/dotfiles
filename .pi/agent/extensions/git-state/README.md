# git-state

Shows the current local Git working-tree state in the user editor top-right border through `tui-broker`.

Label format:

```text
git 3f +120 -8
```

- `3f` is the number of changed files reported by `git status --porcelain=v1 --untracked-files=all`.
- `+120 -8` are tracked line additions/deletions from `git diff --numstat HEAD --`.
- Untracked files count toward `f`, but their full line counts are intentionally not computed because doing so can be expensive in large generated trees.
- Numbers are ANSI-colored: files are cyan when dirty, additions are green, deletions are red, and clean zero counts are green.

The extension does not own TUI surfaces directly. It registers a `tui-broker` editor top-right status provider and asks the broker to refresh when polling detects a changed snapshot.
