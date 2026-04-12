# pi-diff-review-turn-tracker

Always-loaded helper for `/diff-review` phase 14.

It watches the current agent turn, captures first-touch baselines for agent-touched repo paths, and writes turn artifacts under the first writable location in this order:

- `/tmp/pi/sessions/--<repoRoot>--/diff-review/turns/`
- `~/.pi/agent/sessions/--<repoRoot>--/diff-review/turns/`
- `<repoRoot>/.pi/diff-review/turns/`

Files written there:

- `latest.patch` / `latest.json`: the literal most recent turn for that repo/session, even when it had no agent-touched paths
- `latest-reviewable.patch` / `latest-reviewable.json`: the most recent non-empty agent-touched diff, so review flows are not clobbered by later bash-only or no-touch turns

Key metadata fields in `*.json` now include:

- `touched_paths`: paths the agent likely touched during the turn
- `observed_changed_paths`: the canonical changed-path set derived from the persisted diff identity, including omitted/binary stub identities
- optional `agent_change_report`: an advisory external summary with exact mismatch arrays (`missing_from_observed`, `missing_from_agent_report`)

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
- the external summarizer is fail-open and advisory only; canonical diff metadata is still usable when summarization fails
- empty/no-observed-diff turns still run the summarizer, but any non-empty reported file list is rejected before persistence

The external summarizer currently runs via `codex exec` from a temp working directory and checks tracked repo cleanliness before and after the run. If that guardrail fails, the report is dropped and only the canonical artifact is kept.
