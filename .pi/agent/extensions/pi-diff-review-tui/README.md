# pi-diff-review-tui

SSH-friendly pi-native `/diff-review` overlay.

The main layout now keeps a persistent **Comments** panel under **Files** in the left column. It is read-only context: when **Files** is active it shows current-review session comment stats, when **Diff** is active it shows metadata for the current file, and when the diff cursor is sitting on an inline comment marker it previews that comment instead. The existing popup workflows stay in place for adding/editing comments and for the comments list / cursor-peek views.

The diff pane uses pi-style `cli-highlight` syntax highlighting for code rows, wraps long diff lines instead of truncating them with `…`, and uses full-line green/red background tint for added/removed lines. Delta-style homolog pairing now drives inline token emphasis, so structurally similar removed/added rows get explicit bold + brighter local red/green chips while ambiguous rewrites still fall back to plain row tint only. Selected changed lines keep the diff hue by switching to a lighter mixed tint instead of dropping back to the plain selection background.

This extension is loaded automatically by the vault `./pi` wrapper because it lives under `.pi/extensions/`.

When `pi-ssh` is active, `/diff-review` now uses the shared `pi-ssh` session runtime instead of its own SSH flag parser/helper process. Repo-root lookup, remote workspace diffs, remote patch inspection, and remote reverse-apply all go through the active `PiSshSession`.

`/diff-review` now resolves SSH repo identity through the shared `resolveActivePiSshRepoIdentity(localCwd)` helper in `pi-ssh`. That keeps repo-root resolution on one canonical codepath, reuses the session-level repo-root cache warmed at SSH startup, and fails closed when an active SSH session cannot prove its remote repo identity.

`/diff-review` now opens the overlay immediately with a loading state instead of blocking on initial bundle resolution. In SSH mode the remote `workspace vs HEAD` bundle is fetched through the persistent remote shell as one batched command so the pre-overlay path does less round-trip work.

In SSH mode, `e` / `g` stage the selected remote file into a local diff-review temp directory, open that local staged copy in your editor, and then sync it back to the remote checkout only if the remote file still matches the pre-edit baseline. The final writeback now happens as one remote compare-and-write step instead of a separate re-read plus write. If the remote file drifted while you were editing, diff-review fails closed, keeps the staged local file, and tells you where it is. If an older recovery copy already exists for the same file/session, diff-review allocates a fresh stage path instead of overwriting it. Binary-looking files and symlink/hardlink targets are refused in this flow.

Use a blocking editor command here (`nvim`, `vim`, `hx`, `code --wait`, etc.). If `$EDITOR` returns immediately, diff-review will inspect the staged file before your edits are finished.

The hot remote git/text path now uses the shared `PiSshSession.execText()` helper, which is backed by `pi-ssh`'s persistent shell session. Exact-byte file reads/writes still use the safer one-shot transfer path.

When `.pi/extensions/pi-diff-review-turn-tracker/` has a current-session artifact, `/diff-review` opens in `t` mode by default and shows the most recent reviewable repo snapshot patch for this session before falling back explicitly to `a` (`workspace vs HEAD`).

When the tracker metadata also carries an advisory `agent_change_report`, `t` mode keeps runtime-observed rows canonical and may append repo-contained reported-only rows. Those reported-only rows are labeled explicitly, stay inspect-only in v1, and may show one of three states: a deferred current-repo lookup, a derived current repo diff loaded on demand for the selected file, or an explicit no-current-diff advisory placeholder.

## Keybindings

These are intentionally lowercase-only for terminal reliability; uppercase-vs-lowercase distinctions were flaky in real use.

- `j/k`, `↑/↓`: move
- `enter`: files → focus diff, diff → line comment
- `tab`: switch files/diff focus
- `→`: files → diff focus
- `←`: diff → files focus
- `t` / `a`: switch review mode (`t` = last turn, `a` = workspace vs HEAD across all current repo changes, including untracked files)
- `c`: line comment at cursor
- `h`: auto-range comment (uses the nearest contiguous changed block, not the whole git hunk)
- `space`: toggle the current contiguous changed block accepted/rejected (`✓` accepted by default, `×` rejected)
- `x`: start/finish an explicit range selection for a range comment
- `f`: file comment
- `o`: overall comment
- `m`: comments list (`t` toggles current/all review modes inside the overlay)
- `v`: peek comments covering the current cursor location
- `n` / `b`: next / previous comment in the current review mode
- `.` / `,`: next / previous comment in the current file
- `w` / `z`: next file with comments / next file with stale comments
- `[` / `]`: previous / next contiguous changed chunk
- `e`: edit at cursor in `$VISUAL` / `$EDITOR` / `nvim` (SSH mode stages locally first, then writes back to remote with a remote compare-and-write baseline check; use a blocking editor like `code --wait`)
- `g`: edit file (same SSH staging behavior)
- `r`: reload current review mode
- `/diff-review debug` or `/diff-review --debug`: print a local-vs-remote backend report to stderr instead of opening the overlay
- `?`: help
- `s`: submit
- `q` or `esc`: cancel (`esc` clears an active range selection before quitting)

## Submit behavior

Submit writes a full-fidelity Markdown review file to the first writable location in this order.

The directory naming follows pi's session convention (`~/.pi/agent/sessions/--<cwd>--/`). For local reviews the safe-path is computed from the local repo root. For SSH reviews it is computed from the SSH scope key (`ssh:<remote>[:port]:<repoRoot>`), so different remotes do not collide.

- `/tmp/pi/sessions/--<scopeKey>--/diff-review/reviews/sessions/<sessionId>/<timestamp>_<mode>.md`
- `~/.pi/agent/sessions/--<scopeKey>--/diff-review/reviews/sessions/<sessionId>/<timestamp>_<mode>.md`
- `<repoRoot>/.pi/diff-review/reviews/sessions/<sessionId>/<timestamp>_<mode>.md` (local backend only)

If `/tmp` is not writable, the UI warns when it falls back to `~/.pi/agent/sessions/...` or the repo-local `.pi` directory. SSH-backed reviews do not use the repo-local fallback path.

After saving the full file, the extension replaces pi's editor content with a compact prompt that points the agent at the saved review file for the full snippets/context.

Saved reviews use PR-style `a:` / `b:` anchors, actionable `edit_path` / `apply_to` fields on the `b/` side, deterministic file/range ordering, and search handles (`hunk_header`, `search`) so the next agent can act on local feedback without guessing.

Changed blocks are accepted by default. If you press `space` on changed diff lines, `/diff-review` marks that contiguous changed block as rejected and `s` will try to revert only those rejected blocks from the working tree via `git apply -R --check`, with `git apply -R -3 --check` as the fallback. If both checks fail, nothing is mutated and the UI shows the git diagnostics plus recovery steps.

Manual edits within or near a rejected block can make reverse-apply fail because `git apply -R` is context-sensitive. The intended recovery path is: `r` reload the current review mode, reselect the rejected blocks, then submit again.

When the review source is `t`, the saved markdown and compact prompt also record that the review came from the last turn's repo snapshot patch, along with the touched paths, canonical `observed_changed_paths`, and agent-report mismatch counts (and repo keys when the artifact is a combined multi-repo workspace patch).
