# Track Resume: do not stop goal semantics

Track id: `do-not-stop-goal-semanti_20260508`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state

Spec drafted and awaiting Tan approval/revision. No implementation has started. The generated `plan.md` still contains the conductor template and must be replaced only after the spec is approved.

The intended change is to convert `do-not-stop` from repeat-toggle behavior into explicit goal semantics: active goals auto-continue when idle, a configured turn budget can produce `budget_limited`, completion is model-triggered through a restricted tool, and pause/resume are intentionally unsupported.

## Active phase / task

- Phase: Spec approval
- Task: Review `spec.md` open questions and revise the behavior contract before implementation planning.

## Last completed step

- Created conductor track `do-not-stop-goal-semanti_20260508`.
- Audited current `do-not-stop` implementation and existing conductor project docs.
- Drafted `spec.md` with known decisions: no pause/resume, unlimited budget by default, explicit goal creation, completion via restricted tool, and continuation-message design left open.

## Progress log

- 2026-05-08 JST: Drafted behavior spec for goal-style `do-not-stop`; no code changed.

## Accepted behaviors currently in scope

Pending approval. Draft scope currently includes:

- `/do-not-stop <objective>` creates/replaces an active goal.
- `/do-not-stop clear/status/budget/help` are supported controls.
- `/do-not-stop pause` and `/do-not-stop resume` are unsupported.
- Active goals continue only when idle, no pending messages exist, no dispatch is scheduled, and budget permits.
- `turnBudget = null` means unlimited continuation turns.
- Runtime sets `budget_limited` only when a configured turn budget is exhausted.
- Model can only set `complete` through a restricted completion tool.
- Old repeat snapshots must not accidentally auto-arm a new goal.

## Decisions / non-goals

- Durable decision: no pause/resume status or commands.
- Durable decision: budget is unlimited by default when not set.
- Durable decision: do not infer goals automatically from ordinary user prompts.
- Durable decision: no pi core changes; implement inside `~/.pi/agent/extensions/`.
- Deferred decision: exact continuation message and injection mechanism.

## Deviations from approved spec/plan

- None. Spec is not yet approved.

## Blockers / risks

- Tan wants a different continuation-message design; the exact message content/API must be decided before plan approval.
- Need decide whether non-UI replacement requires explicit clear first.
- Need decide whether old `repeats` terminology remains as a deprecated alias.
- Need decide whether completed goals stay visible until cleared.

## Latest review outcome

- Status: not run
- Findings / fixes: no implementation exists yet.

## Setup / prerequisites

- Repo root: `/home/tan/.pi/agent/extensions`
- Existing extension entrypoint: `do-not-stop/index.ts`
- Existing helpers: `do-not-stop/lib/do-not-stop.ts`, `do-not-stop/lib/do-not-stop-runtime.ts`
- Existing tests: `test/do-not-stop*.test.mjs`

## Where to pick up (next steps)

1. Review `conductor/tracks/do-not-stop-goal-semanti_20260508/spec.md` with Tan and resolve the open questions.
2. After spec approval, replace `plan.md` with a concrete implementation plan that names exact touched files and verification commands.
3. Only after plan approval, implement behavior slices with tests mapped to approved scenarios.

## Verification commands

No implementation verification has been run for this track yet. Expected targeted command after implementation begins:

```bash
cd /home/tan/.pi/agent/extensions && node --test test/do-not-stop*.test.mjs
```

## lat-md drift checks

- Last run: not run for this track
- Expected command if implementation touches lattice docs: follow the repo-local `lat-local.sh`/lat-md conventions from `/home/tan/.pi/agent/extensions`.
