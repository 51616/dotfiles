# Tests

This file links the proving tests that anchor extension behavior which is easy to regress and expensive to rediscover from code.

## Activity block reducer and widget stay honest, bounded, and width-safe

Owned by:
- `.pi/extensions/test/activity-block-index.test.mjs` (lifecycle on the pi 1.3.0 event order, via `test/helpers/activity-block-harness.mjs`)
- `.pi/extensions/test/activity-block-state.test.mjs`
- `.pi/extensions/test/activity-block-widget.test.mjs`
- `.pi/extensions/activity-block/test/typecheck.test.mjs`

What this proves:
- one permanent `aboveEditor` dock per session, height-neutral when idle; block mode hides pi's working row and every tool row (empty self-shell renderers), default mode gives both back
- each run anchors exactly one block below its trigger message and above the reply; retries and compaction continuations reuse it; the block finalizes only on `agent_settled`
- a mid-run steer freezes the block as `Interrupted by steering`; a follow-up after finished work freezes it as `Completed`; the next block anchors under the steering/follow-up message
- the run's own trigger, hidden custom messages, and tool results never split a block; displayed custom triggers do
- a post-steer block never adopts tool results from the earlier block that `agent_end.messages` still carries
- failures before any assistant output leave no orphan anchor or snapshot; error/abort/dangling-tool terminal states persist with the right label
- nested codemode tool calls are not counted
- resume restores snapshots for current `custom` anchors and legacy `custom_message` anchors, reconstructs missing tool rows from the transcript, continues the turn counter, and keeps legacy anchors out of model context
- token counts stay block-scoped, including the first block of a session and the first block after compaction (no whole-context counts)
- timers stop on finish and shutdown; zen mode hides dock and transcript blocks and restores them
- the widget keeps tool colors, markdown thinking, the scanner spinner (static while `Responding`), right-aligned timers, 1K token buckets, the 20-line bound, and width safety
- activity-block typechecks against the workspace's pinned pi runtime

## Goal continuation is explicit, audited, and budget-safe

Owned by:
- `.pi/extensions/test/goal.test.mjs`
- `.pi/extensions/test/goal-follow-up.test.mjs`
- `.pi/extensions/test/goal-runtime.test.mjs`
- `.pi/extensions/test/goal-audit-runner.test.mjs`
- `.pi/extensions/test/goal-audit-target.test.mjs`
- `.pi/extensions/tui-broker/test/interop.test.mjs`

What this proves:
- `/goal <objective>` creates an explicit active goal with unlimited budget by default, and starts the first non-audited starter continuation when issued from idle, instead of enabling a repeat toggle
- vague non-verifiable objectives like `goal` are rejected with concrete-objective guidance, do not arm a goal, and are cleared if restored from old persisted state
- when `tui-broker` owns the editor, an active `/goal` goal makes the user editor red and renders the bold `─ ⟐ PURSUING GOAL` top-border indicator without leading whitespace
- blank `/goal` during a running turn can adopt the previous user message without injecting an immediate continuation
- ordinary user input does not arm a repeat cycle
- `pause`, `resume`, and old `repeats` controls are rejected with actionable guidance toward `clear` or `budget`
- active goals continue only after idle scheduling gates pass, auto-checkpoint pending-resume/session-compaction blockers are clear, and `turnsUsed` increments only after follow-up dispatch succeeds
- configured turn budgets transition to `budget_limited` instead of pretending the goal is complete
- high-confidence external audit completion marks `complete` and suppresses follow-up dispatch only when concrete evidence and source paths are present
- audit failures/timeouts and low-confidence results fall back to continuation and never mark completion
- audit subprocess construction creates the explicit audit-session parent directory, uses `pi -p`, the current model, medium thinking, and explicit `--session <path>` retries without `-c` or `--continue`
- `pi-ssh` audit context syncs the current session JSONL to the remote host, points audit prompts at the remote session snapshot and remote cwd, and adds matching `--ssh <remote>:<remoteCwd>` / `--ssh-port <port>` flags to the external audit process
- session custom entries reconstruct goal state, clear/null entries remove it, and legacy repeat snapshots never restore an active goal

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

## Remote FFF forwarding searches the SSH filesystem and cleans up workers

Owned by:
- `remote-fff-forward/test/entrypoint.test.mjs`
- `remote-fff-forward/test/query-format.test.mjs`
- `remote-fff-forward/test/remote-worker-local.test.mjs`
- `remote-fff-forward/test/worker-client.test.mjs`
- `remote-fff-forward/test/live-smoke.mjs` for live SSH smoke runs

What this proves:
- extension registration stays inert without SSH state, registers immediately when `--ssh` is set, can register on `session_start` when SSH state appears later, and re-registers on SSH session start so it wins tool override order
- query normalization accepts both local mapped paths and remote absolute paths under the active workspace, while rejecting out-of-workspace absolute constraints
- formatted `fffind` and `ffgrep` output preserves the local `pi-fff` scan contract that agents rely on
- cursor tokens are stateless, so pagination does not depend on an in-memory local cache or one specific remote worker process
- the stdio worker runs native FFF find/grep, reuses one process for multiple requests, rejects malformed worker output, and kills the SSH child on abort
- live SSH smoke against `gcp_slurm_sakana_eu` verifies remote find/grep results, normal `manager.dispose()` cleanup, and remote worker exit after the local client is killed with `SIGKILL`

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
- durable pending-resume state restores the shared checkpoint-cycle blocker on session start and after `session_compact`, so `/goal` cannot win a post-compaction race before the resume prompt is consumed
- compaction callbacks still show/clear UI state and preserve the queued resume path after compaction completes or throws
