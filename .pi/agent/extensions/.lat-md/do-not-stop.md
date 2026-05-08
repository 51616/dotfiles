# Do not stop

This extension owns the `/do-not-stop` goal-continuation workflow for a single pi session. It replaces the old repeat-toggle loop with explicit goal state, audit-owned completion, budget-limited stopping, and a visible editor/status cue.

## Responsibilities

`do-not-stop/index.ts` owns the extension wiring for goal state, scheduling gates, UI refresh, and follow-up delivery.

It handles slash commands, session start/shutdown restore, previous-user-message capture, immediate first scheduling when an explicit goal is created from idle, idle `agent_end` scheduling for later audited continuations, and `pi.sendUserMessage(..., { deliverAs: "followUp" })` delivery.

The helper modules under `do-not-stop/lib/` own the contracts that must stay testable without live model calls:

- `do-not-stop.ts` defines command parsing, public goal/audit types, usage text, status summaries, and badge labels.
- `do-not-stop-state.ts` defines goal creation, replacement, budget, completion, and scheduling-gate transitions.
- `do-not-stop-runtime.ts` stores per-session goal snapshots and reconstructs state from `pi.appendEntry("do-not-stop-goal-state", ...)` custom session entries.
- `do-not-stop-audit.ts` validates strict audit JSON and only allows high-confidence `complete` to stop continuation.
- `do-not-stop-audit-target.ts` resolves local-vs-`pi-ssh` audit context, syncs the current session file to the remote host when SSH is active, and rewrites audit source hints to the remote cwd/session snapshot.
- `do-not-stop-audit-runner.ts` invokes external `pi -p` audits with the current model, medium thinking, a one-hour total cap, and an explicit `--session <path>` for every attempt. In `pi-ssh` sessions it also passes `--ssh <remote>:<remoteCwd>` and `--ssh-port <port>` so the audit agent sees the same remote workspace.
- `do-not-stop-continuation.ts` builds anchored and fallback continuation messages.
- `do-not-stop-session.ts` extracts previous user goals and builds the audit prompt from session/checkpoint/conductor hints.

## Invariants

Absence of a goal is represented by `null`, not by a status. Valid statuses are only `active`, `budget_limited`, and `complete`.

An active goal may schedule a continuation only when pi is idle, there are no queued messages, no dispatch is already scheduled, and the turn budget is not exhausted. Creating or replacing an explicit goal while idle schedules the first starter turn immediately without an external audit, because no goal progress exists yet to inspect; later continuations are audited. Creating a goal while a turn is running waits for the normal idle gate. Ordinary user input records the possible previous-message goal but does not arm a continuation cycle.

Goal creation rejects known vague, non-verifiable objectives such as `goal`, `task`, `work`, `continue`, `do it`, `finish`, `stuff`, and `things`. The extension reports a concrete-objective example instead of arming an audit loop that cannot honestly complete. Restoring an already-persisted vague goal clears it and writes a null goal entry.

Completion is runtime-owned and comes only from an external audit result with `decision: "complete"`, `confidence: "high"`, at least one evidence item, and at least one source path. The active agent does not receive a self-completion tool, and audit failures/timeouts never mark completion.

When `pi-ssh` is active, the audit must be SSH-aware: before running the audit, the current local session JSONL is copied to `~/.cache/pi/do-not-stop/session-snapshots/<session-id>.jsonl` on the remote host; the audit prompt points at that remote snapshot and remote cwd; and the `pi -p` audit process is launched with the same remote host, port, and remote cwd. This prevents the audit from inspecting the local placeholder checkout while the active agent is editing a remote workspace.

Budget exhaustion is separate from completion. When `turnBudget !== null` and `turnsUsed >= turnBudget`, the runtime marks `budget_limited`, persists the state, refreshes UI, and stops scheduling.

Old toggle/repeat commands and snapshots are hard-cut legacy state. `on`, `off`, `toggle`, and `repeats` return guidance instead of becoming goals or aliases; stale snapshots may be detected and ignored, but they must never restore an active goal or dispatch a continuation.

## Failure and recovery

If audit cannot produce trusted completion, the extension uses the fallback continuation template and leaves the goal active.

That covers audit failures, timeouts, non-zero exits, and invalid JSON after retrying within the cap. This keeps progress moving without letting a failed audit claim completion.

Audit retries must use the same explicit audit session path through `--session`; never use `-c` or `--continue`, because concurrent pi instances make “most recent session” unsafe.

If follow-up dispatch throws, the extension does not increment `turnsUsed`; the user sees a warning when UI is available.

If session-tree state is missing, the runtime falls back to the per-session in-memory snapshot. If both are missing, no goal is restored.

## UI contract

The editor badge/border reflects active goal-chasing state, not repeat state.

When a goal exists, the user editor border is red and the top-border text indicator is the bold label `─ GOAL CHASING!` with no leading whitespace. Detailed state remains available through status text and `/do-not-stop status`.

Completed and budget-limited goals remain visible until `/do-not-stop clear` removes the goal.

## Change guidance

Keep command parsing, state transitions, audit parsing, audit subprocess construction, and continuation message construction in focused helper modules.

Those helpers should stay covered by focused tests. Do not reintroduce toggle/repeat semantics, pause/resume states, or self-assessed completion.

When changing audit behavior, preserve the explicit-session retry invariant, the SSH target/session-snapshot invariant, and update `test/do-not-stop-audit-runner.test.mjs`, `test/do-not-stop-audit-target.test.mjs`, and the external audit contract here.

## Verification

Run the targeted suite after changing this extension:

```bash
cd /home/tan/.pi/agent/extensions && node --test test/do-not-stop*.test.mjs
```

Run the lat-md check after editing this lattice:

```bash
bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all
```
