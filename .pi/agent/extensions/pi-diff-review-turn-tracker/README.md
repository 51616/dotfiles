# pi-diff-review-turn-tracker

Always-loaded helper for `/diff-review` phase 14.

It watches the current agent turn, captures first-touch baselines for agent-touched repo paths, and writes turn artifacts under the first writable location in this order:

- `/tmp/pi/sessions/--<repoRoot>--/diff-review/turns/`
- `~/.pi/agent/sessions/--<repoRoot>--/diff-review/turns/`
- `<repoRoot>/.pi/diff-review/turns/`

Files written there:

- `latest.patch` / `latest.json`: the literal most recent turn for that repo/session, even when it had no agent-touched paths
- `latest-reviewable.patch` / `latest-reviewable.json`: the most recent non-empty agent-touched diff, so review flows are not clobbered by later bash-only or no-touch turns

Per-session details are also written under:

- `.../turns/sessions/<sessionId>/...`

What counts as agent-touched in v1:

- every `edit(path=...)`
- every `write(path=...)`
- snooped `bash` file ops with explicit paths: `rm`, `mv`, `git rm`, `git mv`
- `ast-grep` rewrite commands after a dry-run preflight discovers affected files

Important limits:

- generic `bash` calls are **not** attributed by diffing the whole working tree
- large / binary / unreadable files are recorded as omitted stubs instead of full content
- the diff is written once at `agent_end`, so it reflects the net effect of the whole turn
