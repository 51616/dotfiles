# pi-diff-review-turn-tracker

Always-loaded helper for `/diff-review` phase 14.

It watches the current agent turn, snapshots the current repo at `agent_start`, snapshots it again at `agent_end`, and writes turn artifacts under the first writable location in this order.

When `pi-ssh` is active, the tracker reads the active `PiSshSession` from `pi-ssh/lib/pi-ssh-session-runtime.ts`, maps the local cwd onto the remote repo through that shared session contract, and captures remote repo snapshots without its own SSH helper process.

Artifacts land under the first writable location in this order:

- `/tmp/pi/sessions/--<scopeKey>--/diff-review/turns/`
- `~/.pi/agent/sessions/--<scopeKey>--/diff-review/turns/`
- `<repoRoot>/.pi/diff-review/turns/` (local backend only)

For local turns, `scopeKey === repoRoot`. For SSH turns, `scopeKey` is `ssh:<remote>[:port]:<repoRoot>`, so artifacts stay partitioned by remote target and the repo-local fallback is disabled.

Files written there:

- `latest.patch` / `latest.json`: the literal most recent turn for that repo/session, even when it had no observed repo changes
- `latest-reviewable.patch` / `latest-reviewable.json`: the most recent non-empty repo snapshot diff, so review flows are not clobbered by later no-change turns

Key metadata fields in `*.json` include:

- `touched_paths`: currently mirrors the repo snapshot changed-path set for compatibility with existing consumers
- `observed_changed_paths`: the canonical changed-path set derived from the persisted diff identity, including omitted/binary stub identities
- optional `agent_change_report`: an advisory external summary with exact mismatch arrays (`missing_from_observed`, `missing_from_agent_report`)

Per-session details are also written under:

- `.../turns/sessions/<sessionId>/...`

Snapshot behavior in the current version:

- the tracker does not watch individual `edit`, `write`, or `bash` tool calls
- the turn artifact reflects the net repo diff between the start-of-turn snapshot and the end-of-turn snapshot
- large / binary / unreadable files are recorded as omitted stubs instead of full content
- regular-file content capture is bounded by a per-repo total snapshot budget; when the baseline already consumed that budget, newly-created files in the same turn are persisted as `total_cap_exceeded` omission stubs instead of more content
- symlinks and other non-regular files are treated as `non_file` omissions so the snapshot never follows link targets during turn capture
- the diff is written once at `agent_end`
- the external summarizer is fail-open and advisory only; canonical diff metadata is still usable when summarization fails
- empty/no-observed-diff turns still run the summarizer, but any non-empty reported file list is rejected before persistence

The external summarizer currently runs via `codex exec` from a temp working directory and checks tracked repo cleanliness before and after the run. If that guardrail fails, the report is dropped and only the canonical artifact is kept.
