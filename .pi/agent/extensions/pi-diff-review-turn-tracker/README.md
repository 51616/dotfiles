# pi-diff-review-turn-tracker

Always-loaded helper for `/diff-review` phase 14.

It watches the current agent turn, captures first-touch baselines for agent-touched repo paths, and writes a reviewable patch at turn end under:

- `<repoRoot>/.pi/diff-review/turns/latest.patch`
- `<repoRoot>/.pi/diff-review/turns/latest.json`
- `<repoRoot>/.pi/diff-review/turns/sessions/<sessionId>/...`

What counts as agent-touched in v1:

- every `edit(path=...)`
- every `write(path=...)`
- snooped `bash` file ops with explicit paths: `rm`, `mv`, `git rm`, `git mv`
- `ast-grep` rewrite commands after a dry-run preflight discovers affected files

Important limits:

- generic `bash` calls are **not** attributed by diffing the whole working tree
- large / binary / unreadable files are recorded as omitted stubs instead of full content
- the diff is written once at `agent_end`, so it reflects the net effect of the whole turn
