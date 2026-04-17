# pi-diff-review-turn-tracker

Always-loaded helper for `/diff-review` phase 14.

It watches the current agent turn, captures a synthetic git workspace tree at `agent_start`, captures another at `agent_end`, and diffs those two trees to isolate the net repo delta for that turn.

When `pi-ssh` is active, the tracker reads the active `PiSshSession` from `pi-ssh/lib/pi-ssh-session-runtime.ts`, maps the local cwd onto the remote repo through that shared session contract, and captures remote workspace trees without crawling remote files path-by-path.

Artifacts land under the first writable location in this order:

- `/tmp/pi/sessions/--<scopeKey>--/diff-review/turns/`
- `~/.pi/agent/sessions/--<scopeKey>--/diff-review/turns/`
- `<repoRoot>/.pi/diff-review/turns/` (local backend only)

For local turns, `scopeKey === repoRoot`. For SSH turns, `scopeKey` is `ssh:<remote>[:port]:<repoRoot>`, so artifacts stay partitioned by remote target and the repo-local fallback is disabled.

Files written there:

- `latest.patch` / `latest.json`: the literal most recent turn for that repo/session, even when it had no observed repo changes
- `latest-reviewable.patch` / `latest-reviewable.json`: the most recent non-empty repo snapshot diff, so review flows are not clobbered by later no-change turns

Key metadata fields in `*.json` include:

- `touched_paths`: the canonical changed-path set for the per-turn workspace delta
- `observed_changed_paths`: currently mirrors `touched_paths`
- optional `agent_change_report`: an advisory external summary with exact mismatch arrays (`missing_from_observed`, `missing_from_agent_report`)

Per-session details are also written under:

- `.../turns/sessions/<sessionId>/...`

Workspace-tree behavior in the current version:

- the tracker does not watch individual `edit`, `write`, or `bash` tool calls
- the turn artifact reflects the net repo diff between the start-of-turn workspace tree and the end-of-turn workspace tree
- pre-existing dirty state is excluded automatically because the diff is between those two captured workspace trees, not against `HEAD`
- ignored files stay excluded because the synthetic tree is built with `git add -A` into a temporary index
- the diff is written once at `agent_end`
- the external summarizer is fail-open and advisory only; canonical diff metadata is still usable when summarization fails
- empty/no-observed-diff turns still run the summarizer, but any non-empty reported file list is rejected before persistence

The external summarizer currently runs via `codex exec` from a temp working directory and checks tracked repo cleanliness before and after the run. If that guardrail fails, the report is dropped and only the canonical artifact is kept.
