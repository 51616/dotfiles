# pi-diff-review-tui

SSH-friendly pi-native `/diff-review` overlay.

The main layout now keeps a persistent **Comments** panel under **Files** in the left column. It is read-only context: when **Files** is active it shows current-review session comment stats, when **Diff** is active it shows metadata for the current file, and when the diff cursor is sitting on an inline comment marker it previews that comment instead. The existing popup workflows stay in place for adding/editing comments and for the comments list / cursor-peek views.

The diff pane uses pi-style `cli-highlight` syntax highlighting for code rows, wraps long diff lines instead of truncating them with `…`, and uses full-line green/red background tint for added/removed lines. Delta-style homolog pairing now drives inline token emphasis, so structurally similar removed/added rows get explicit bold + brighter local red/green chips while ambiguous rewrites still fall back to plain row tint only. Selected changed lines keep the diff hue by switching to a lighter mixed tint instead of dropping back to the plain selection background.

This extension is loaded automatically by the vault `./pi` wrapper because it lives under `.pi/extensions/`.

This repo also ships `.pi/settings.json` so a globally installed legacy `badlogic/pi-diff-review` package does not steal or suffix `/diff-review` during local verification.

When `.pi/extensions/pi-diff-review-turn-tracker/` has a current-session artifact, `/diff-review` now opens in `t` scope by default and shows the last turn's agent-touched patch before falling back to the git-backed scopes.

## Keybindings

These are intentionally lowercase-only for terminal reliability; uppercase-vs-lowercase distinctions were flaky in real use.

- `j/k`, `↑/↓`: move
- `enter`: files → focus diff, diff → line comment
- `tab`: switch files/diff focus
- `→`: files → diff focus
- `←`: diff → files focus
- `t` / `u` / `i` / `a`: switch diff source or scope (last turn / unstaged / staged / all, with `a` including untracked files too)
- `c`: line comment at cursor
- `h`: auto-range comment (uses the nearest contiguous changed block, not the whole git hunk)
- `x`: start/finish an explicit range selection for a range comment
- `f`: file comment
- `o`: overall comment
- `m`: comments list (`t` toggles current/all scopes inside the overlay)
- `v`: peek comments covering the current cursor location
- `n` / `b`: next / previous comment in the current scope
- `.` / `,`: next / previous comment in the current file
- `w` / `z`: next file with comments / next file with stale comments
- `[` / `]`: previous / next hunk
- `e`: edit at cursor in `$VISUAL` / `$EDITOR` / `nvim`
- `g`: edit file
- `r`: reload current scope
- `?`: help
- `s`: submit
- `q` or `esc`: cancel (`esc` clears an active range selection before quitting)

## Submit behavior

Submit writes a full-fidelity Markdown review file to the first writable location in this order.

The directory naming follows pi's session convention (`~/.pi/agent/sessions/--<cwd>--/`). For a given git repo root, the safe-path is computed from that root.

- `/tmp/pi/sessions/--<repoRoot>--/diff-review/reviews/sessions/<sessionId>/<timestamp>_<scope>.md`
- `~/.pi/agent/sessions/--<repoRoot>--/diff-review/reviews/sessions/<sessionId>/<timestamp>_<scope>.md`
- `<repoRoot>/.pi/diff-review/reviews/sessions/<sessionId>/<timestamp>_<scope>.md`

If `/tmp` is not writable, the UI warns when it falls back to `~/.pi/agent/sessions/...` or the repo-local `.pi` directory.

After saving the full file, the extension replaces pi's editor content with a compact prompt that points the agent at the saved review file for the full snippets/context.

Saved reviews use PR-style `a:` / `b:` anchors, actionable `edit_path` / `apply_to` fields on the `b/` side, deterministic file/range ordering, and search handles (`hunk_header`, `search`) so the next agent can act on local feedback without guessing.

When the review source is `t`, the saved markdown and compact prompt also record that the review came from the last turn's agent-touched patch, along with the touched paths (and repo keys when the artifact is a combined multi-repo workspace patch).
