# Track Resume: do not stop goal semantics

Track id: `do-not-stop-goal-semanti_20260508`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state

Implementation completed for the scoped `/do-not-stop` goal-semantics track. Targeted tests and entrypoint smoke tests pass; Codex review findings were addressed. Full workspace tests still have unrelated `pi-instance-manager` failures that reproduce independently of this change.

The intended change is to convert `do-not-stop` from repeat-toggle behavior into explicit goal semantics: active goals auto-continue when idle, a configured turn budget can produce `budget_limited`, completion is determined by a separate `pi -p` progress/completion audit, and pause/resume are intentionally unsupported.

## Active phase / task

- Phase: Completion sync
- Task: Final commit, `/reload`, and report.

## Last completed step

- Created conductor track `do-not-stop-goal-semanti_20260508`.
- Audited current `do-not-stop` implementation and existing conductor project docs.
- Drafted `spec.md` with known decisions: no pause/resume, unlimited budget by default, explicit goal creation, and goal-style continuation behavior.
- Revised `spec.md` to make external `pi -p` auditing the canonical continuation/completion mechanism: the audit inspects session progress, self-checkpoints, conductor tracks, and progress notes when available; high-confidence complete audits mark the goal complete; continuation prompts are grounded in remaining work.
- Incorporated Tan decisions: audit uses current model + medium reasoning with a one-hour cap, retries by resuming an explicit audit session when possible, falls back to an unanchored template after cap exhaustion, hard-cuts `repeats`, keeps completed status visible until clear, requires explicit non-UI replacement, and lets blank `/do-not-stop` during a running turn adopt the previous user message as the goal.
- Incorporated Tan decision: audit retries must use an explicit `--session <path|id>` selector and must not use `-c` or `--continue`, because concurrent pi instances make “most recent session” unsafe.
- Drafted `plan.md` with phases for API discovery, helper/data-model refactor, runtime persistence, audit runner, entrypoint integration, tests, lat-md sync, verification, review, and completion sync.
- Implemented the plan in `do-not-stop/index.ts`, new focused helper modules under `do-not-stop/lib/`, rewritten `test/do-not-stop*.test.mjs`, and updated `lat-md/do-not-stop.md` / `lat-md/tests.md`.
- Addressed Codex review findings: high-confidence completion now requires evidence/source paths; audit-session parent dirs are created; scheduling gates are rechecked after audit; stale audit dispatches cannot clear newer locks; legacy `on/off/toggle/repeats` controls return guidance; previous-message adoption is scoped to the current session; audit parsing is strict JSON-only.

## Progress log

- 2026-05-08 JST: Drafted behavior spec for goal-style `do-not-stop`; no code changed.
- 2026-05-08 JST: Added audit retry/resume policy, one-hour audit cap, replacement/repeats/completed-visibility decisions, and blank-command adoption behavior.
- 2026-05-08 JST: Drafted implementation plan. Interrupted by auto-checkpoint before committing the plan.
- 2026-05-08 JST: Implemented goal semantics, rewrote targeted tests, updated lattice docs, and ran verification/review.

## Accepted behaviors currently in scope

Approved spec scope currently includes:

- `/do-not-stop <objective>` creates/replaces an active goal.
- `/do-not-stop clear/status/budget/help` are supported controls.
- `/do-not-stop pause` and `/do-not-stop resume` are unsupported.
- Active goals continue only when idle, no pending messages exist, no dispatch is scheduled, and budget permits.
- `turnBudget = null` means unlimited continuation turns.
- Runtime sets `budget_limited` only when a configured turn budget is exhausted.
- Completion is set only by a high-confidence external `pi -p` audit result, not by the active agent.
- Continuation messages should include original objective, completed items not to repeat, and finer-grained remaining work from conductor/checkpoint/progress artifacts when available.
- Audit failures/timeouts are retried within one hour by resuming audit context when possible; after that, continuation falls back to a predefined unanchored template.
- Completed status remains visible until clear.
- Blank `/do-not-stop` can adopt the previous user message during a running turn.
- Old repeat snapshots must not accidentally auto-arm a new goal.

## Decisions / non-goals

- Durable decision: no pause/resume status or commands.
- Durable decision: budget is unlimited by default when not set.
- Durable decision: do not infer goals automatically from ordinary user prompts.
- Durable decision: no pi core changes; implement inside `~/.pi/agent/extensions/`.
- Durable decision: continuation/completion should be checked by a separate `pi -p` process before dispatch when possible.
- Durable decision: audit uses current model, medium reasoning, and a one-hour total timeout cap.
- Durable decision: audit failures/timeouts should be retried with an explicit `--session <path|id>` audit session when possible; never use `-c` or `--continue`; after the cap, use the fallback continuation template without anchored audit details.
- Durable decision: non-UI replacement should fail unless an explicit replacement flag/command is implemented.
- Durable decision: old `repeats` terminology is hard-cut; use `budget`.
- Durable decision: completed goals remain visible until `/do-not-stop clear`.
- Durable decision: blank `/do-not-stop` during a running turn can create a goal from the previous user message when no goal exists.
- Implemented decision: audit command uses `pi -p --model <provider/id> --thinking medium --session <explicit-audit-session-path> <prompt>` when a model is available; every retry uses the same explicit session path and never uses `-c`/`--continue`.
- Implemented decision: audit session paths are created under `/tmp/pi-work/do-not-stop-audits/` and the parent directory is created before execution.
- Implemented decision: previous-message adoption is scoped to the current session and also checks the current session branch.
- Implemented decision: continuation delivery uses `pi.sendUserMessage(message, { deliverAs: "followUp" })`.
- Implemented decision: checkpoint/conductor/progress sources are passed as audit prompt hints rather than imported directly from self-checkpointing runtime code.

## Deviations from approved spec/plan

- No scope deviations from the approved spec.
- Implementation detail: strict audit parsing now rejects prose-wrapped/fenced JSON to satisfy the fail-closed completion gate.
- Implementation detail: high-confidence completion additionally requires non-empty `evidence` and `sourcePaths`.

## Blockers / risks

- No blockers remain for the scoped track.
- Known unrelated verification noise: `node --test test/*.test.mjs` has seven `pi-instance-manager` failures that reproduce when only those pi-instance-manager files are run. They are outside this track and were not modified.
- Lattice helper mismatch: the shared checker expects `.lat-md/`, while this workspace uses `lat-md/`; manual link/anchor verification passed.

## Latest review outcome

- Status: run three times through `codex-review`
- First review found five issues: completion accepted without evidence, audit-session parent dir missing, post-audit gates not rechecked, legacy toggle commands could become objectives, and conductor docs stale.
- Second review found four issues: conductor docs stale, previous-session blank-goal leakage, non-strict audit parsing, and stale dispatch lock clearing.
- Third review found two remaining issues: same-goal state updates could clear an in-flight dispatch lock, and resume docs still had stale deferred/blocker language.
- All findings were fixed or documented before final verification.

## Setup / prerequisites

- Repo root: `/home/tan/.pi/agent/extensions`
- Existing extension entrypoint: `do-not-stop/index.ts`
- Existing helpers: `do-not-stop/lib/do-not-stop.ts`, `do-not-stop/lib/do-not-stop-runtime.ts`
- Existing tests: `test/do-not-stop*.test.mjs`

## Where to pick up (next steps)

1. Commit the completed implementation/docs.
2. Run `/reload` after commit because live extension code changed.
3. If future work resumes here, start from the final commit and the verification notes below.

## Verification commands

Verification run for this track:

```bash
cd /home/tan/.pi/agent/extensions && node --test test/do-not-stop*.test.mjs test/runtime-extension-inventory.mjs
# pass: 27 tests
```

Additional workspace signal:

```bash
cd /home/tan/.pi/agent/extensions && node --test test/*.test.mjs
# do-not-stop tests pass; full run has 7 unrelated pi-instance-manager failures reproduced by running only those pi-instance-manager files
```

Manual lattice verification:

```bash
cd /home/tan/.pi/agent/extensions && python3 <manual lat-md link/anchor check>
# pass: do-not-stop.md, tests.md, and do-not-stop/index.ts anchor
```

## lat-md drift checks

- Shared helper run: `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Result: failed with `Missing lattice directory: /home/tan/.pi/agent/extensions/.lat-md` because this workspace uses legacy `lat-md/`.
- Manual link/anchor check passed for touched lattice files and the `do-not-stop/index.ts` `@lat:` anchor.
