# Tests

This file links the proving tests that anchor extension behavior which is easy to regress and expensive to rediscover from code.

## Activity block reducer and widget stay honest, bounded, and width-safe

Owned by:
- `.pi/extensions/test/activity-block-state.test.mjs`
- `.pi/extensions/test/activity-block-widget.test.mjs`
- `.pi/extensions/test/activity-block-index.test.mjs`

What this proves:
- reasoning-only runs keep the latest useful thinking excerpt and terminal state
- text streaming marks the block as responding so the spinner can stop cleanly
- tool totals/active/completed/failed counts stay honest across sequential and parallel tool execution
- aborted runs do not leak a stale running state
- the widget prefers the latest active tool when tools are running, reuses compact-tool-view-style colors for `read`/`write`/`edit`/`bash`, applies tool-state background highlighting to the live tool row, renders thinking as markdown, subsumes both tool-active and thinking-only live work under `Cooking`, and drops the spinner while responding
- `Esc` aborts only when the extension has an active turn
- historical transcript suppression stays active after `turn_end`, so finished turns do not suddenly replay default tool rows
- live transcript suppression stays active across tool-result continuation boundaries and is released only when the active block is finalized on `agent_end`
- `before_turn_response` with non-empty trigger messages creates one fresh activity block for each initial, queued steering/follow-up, and triggerTurn custom-message turn, instead of looking like a fresh outer turn
- queued steering freezes the current block immediately, persists it as `Interrupted by steering`, and starts the next block under the steering message
- bare `agent_end` failures still finalize the active block with the correct terminal state
- resumed sessions continue the persisted local turn counter instead of resetting block turn identity/numbering to `1`
- compact mode keeps only the header/first line of the latest thinking text below the status row without an extra previous-activity row or duplicate live thinking block, and keeps the last three tool actions sticky while newer thinking updates arrive, with the newest action first
- thinking expansion opens the full current thinking text up to 15 rendered lines, without reopening a tool detail pane
- blank spacer rows stay under the status row and between the thinking/tool sections and the footer so the block reads cleanly
- live running-state labels animate their dot suffix from 0 to 3 dots instead of using a fixed ellipsis, except `Responding`, which stays static
- timers start at `0s`, avoid sub-second precision, and freeze after completion
- the footer/detail line keeps the timer right-aligned, formats the left side as `<X> tool calls (<Y> failed) · <tokens>`, adds `<N> compactions` when `N > 1`, buckets tokens in 1K increments with `< 1K tokens` below the first bucket, and keeps context-based token counts scoped to the active block instead of the whole session
- narrow terminals stay width-safe and the widget remains height-bounded


## Do-not-stop goal continuation is explicit, audited, and budget-safe

Owned by:
- `.pi/extensions/test/do-not-stop.test.mjs`
- `.pi/extensions/test/do-not-stop-follow-up.test.mjs`
- `.pi/extensions/test/do-not-stop-runtime.test.mjs`
- `.pi/extensions/test/do-not-stop-audit-runner.test.mjs`

What this proves:
- `/do-not-stop <objective>` creates an explicit active goal with unlimited budget by default, and starts the first audited continuation when issued from idle, instead of enabling a repeat toggle
- blank `/do-not-stop` during a running turn can adopt the previous user message without injecting an immediate continuation
- ordinary user input does not arm a repeat cycle
- `pause`, `resume`, and old `repeats` controls are rejected with actionable guidance toward `clear` or `budget`
- active goals continue only after idle scheduling gates pass and `turnsUsed` increments only after follow-up dispatch succeeds
- configured turn budgets transition to `budget_limited` instead of pretending the goal is complete
- high-confidence external audit completion marks `complete` and suppresses follow-up dispatch only when concrete evidence and source paths are present
- audit failures/timeouts and low-confidence results fall back to continuation and never mark completion
- audit subprocess construction creates the explicit audit-session parent directory, uses `pi -p`, the current model, medium thinking, and explicit `--session <path>` retries without `-c` or `--continue`
- session custom entries reconstruct goal state, clear/null entries remove it, and legacy repeat snapshots never restore an active goal

## Diff-review tracker artifacts include canonical observed paths and advisory agent reports

Owned by:
- `.pi/extensions/pi-diff-review-turn-tracker/test/artifacts.test.mjs`
- `.pi/extensions/pi-diff-review-turn-tracker/test/ssh-turn-tracker.test.mjs`
- `.pi/extensions/pi-diff-review-turn-tracker/test/workspace-tree.test.mjs`

What this proves:
- `latest.json` and `latest-reviewable.json` include `observed_changed_paths`
- advisory `agent_change_report` is validated before persistence
- exact mismatch arrays are recomputed by runtime code instead of trusting model output
- empty later turns do not clobber the latest reviewable artifact
- empty/no-observed-diff turns discard invalid non-empty advisory reports
- artifact publication waits until the advisory step finishes for the current turn
- the SSH path uses the shared `pi-ssh` session runtime, isolates the per-turn delta without remote file crawling, and starts capture in the background so model startup is not blocked
- pre-existing dirty workspace state is excluded because the tracker diffs start-vs-end workspace trees instead of diffing against `HEAD`

## Diff-review tracker workspace-tree capture stays SSH-safe and dirty-state-safe

Owned by:
- `.pi/extensions/pi-diff-review-turn-tracker/test/workspace-tree.test.mjs`
- `.pi/extensions/pi-diff-review-turn-tracker/test/ssh-turn-tracker.test.mjs`

What this proves:
- the local workspace-tree backend captures the current worktree through a temporary git index instead of reading repo files directly
- ignored files stay excluded because the temporary index respects gitignore rules
- rename/name-status parsing prefers the destination path and stays deduplicated
- the SSH path does not need remote `readFile()` crawling to capture turn state
- the SSH path still records net symlink changes without dereferencing the target contents

## Agent change report validation keeps canonical-vs-advisory boundaries exact

Owned by `.pi/extensions/pi-diff-review-turn-tracker/test/agent-change-report.test.mjs`.

What this proves:
- path normalization rejects out-of-namespace or invalid rows
- empty-turn artifacts refuse non-empty reported file lists
- workspace artifacts require `<repo_key>/...` paths
- bounded summarizer payloads include canonical context without trusting model mismatch arrays

## Diff-review TUI exposes only t-and-a review modes

Owned by:
- `.pi/extensions/pi-diff-review-tui/test/app-input.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/app-shell-render.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/persist.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/git.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/review-session.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/app.test.mjs`

What this proves:
- `/diff-review` exposes only `t` and `a` in input handling, shell chrome, persistence text, and startup fallback behavior
- `t` remains the last-turn mode and `a` remains `workspace vs HEAD`
- the live git-backed loader has one workspace-vs-HEAD path instead of separate staged/unstaged branches
- per-mode state and submit output stay isolated between `t` and `a`

## Diff-review TUI renders canonical-vs-reported-only file provenance honestly

Owned by:
- `.pi/extensions/pi-diff-review-tui/test/file-list.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/comment-panel.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/git.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/backend-ssh.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/ssh-staged-editor.test.mjs`
- `.pi/extensions/pi-diff-review-tui/test/entrypoint.test.mjs`

What this proves:
- `t` mode keeps canonical observed rows visible even when the agent report disagrees
- reported-only rows are labeled explicitly and remain advisory-only
- the metadata/comments panel explains canonical vs reported-only provenance and agent summaries
- workspace-prefixed reported-only files resolve to the correct repo before deriving a current diff
- saved review metadata records both `touched_paths` and `observed_changed_paths`, plus agent-report counts
- the SSH diff-review path resolves its repo identity and workspace bundle from the shared `pi-ssh` session runtime and prefers the persistent text-command helper for remote git/text calls
- SSH edit mode stages remote files locally, refuses binary-looking/symlink/hardlink targets, writes back only when the remote baseline is unchanged through a single remote compare-and-write step, preserves execute bits, preserves the staged file on drift, and allocates a fresh stage path instead of overwriting an older recovery copy
- `/diff-review debug` prints a local-vs-remote backend report without opening the overlay

## Command palette prompt-template execution stays aligned with prompt discovery

Owned by `.pi/extensions/test/command-palette.test.mjs`.

What this proves:
- prompt-template commands stay directly executable from the palette while most extension and skill commands still insert `/<name> ` literally
- prompt-template argument parsing matches pi’s `$1`, `$@`, and `${@:N}` semantics closely enough for reusable local templates
- palette execution expands frontmatter-backed prompt-template files and pastes the resolved body into the editor
- prompt-template insertion prefixes two blank lines only when the captured cursor line is already non-empty

## pi-ssh shared session runtime and prompt-context pickup stay exact

Owned by:
- `pi-ssh/test/session-runtime.test.mjs`
- `pi-ssh/test/remote-context.test.mjs`

What this proves:
- only one active `pi-ssh` session is published at a time
- local workspace paths map onto the remote cwd and remote home consistently
- exact-byte exec capture remains available for consumers that need byte-preserving SSH probes
- text-oriented helpers (`execText()`, `repoRoot()`, `exists()`) can use the persistent shell path for lower latency without forcing consumers to parse PTY output themselves
- `stat()` keeps a stdout-only exact-capture path so JSON consumers do not need to tolerate PTY/stderr noise
- remote exists/stat helpers distinguish present and missing paths without ad-hoc consumer parsing
- remote prompt-context probing checks only `remoteCwd/AGENTS.md` and then `remoteCwd/CLAUDE.md`
- unreadable remote context files stop the probe and surface warnings instead of falling through silently
- decoded remote context is injected into the existing local-style `# Project Context` section without inventing a separate remote-only format
- prompt-context injection is idempotent for the same remote file block

## Self-checkpointing footer parsing and SSH-backed resume stay aligned

Owned by:
- `.pi/extensions/test/autockpt-footer-guards.test.mjs`
- `.pi/extensions/self-checkpointing/test/footer-handler.test.mjs`
- `.pi/extensions/self-checkpointing/test/pending-resume.test.mjs`
- `.pi/extensions/self-checkpointing/test/checkpoint-probe.test.mjs`
- `.pi/extensions/self-checkpointing/test/compaction-ui.test.mjs`

What this proves:
- footer parsing tolerates normal markdown noise while preserving explicit absolute paths instead of forcing them into a specific checkpoint-directory shape
- footer-path validation rejects only obviously malformed values and otherwise relies on existence/freshness checks
- a valid footer path can reach `startCompaction()` even when the assistant emits an absolute remote-workspace path
- SSH-backed checkpoint probing is used for remote existence/freshness checks instead of local-only filesystem assumptions
- pending resume does not clear a valid remote checkpoint just because it is absent from the local filesystem
- compaction callbacks still show/clear UI state and preserve the queued resume path after compaction completes or throws
