# Project Workflow

## Guiding principles

1. **The plan is the source of truth.** Work is tracked in `conductor/tracks/<track_id>/plan.md`.
2. **The approved spec is the behavior contract.** `spec.md` defines the acceptance criteria, expected behaviors, and scenarios that implementation must satisfy.
3. **Behavior first, tests second, code third.** Tests should prove the approved behaviors rather than just exercise code paths.
4. **Prefer small, reviewable slices.** Keep diffs tight; don’t mix unrelated changes.
5. **Tests first when feasible.** Use red → green → refactor for new features and bug fixes whenever practical.
6. **Review before completion.** A track is not done when code merely passes checks; it must also survive a review against the approved spec, plan, and verification evidence.
7. **Keep the repo honest.** Update `resume.md` during work and sync project docs at track completion if reality changed.
8. **Implementation is non-interactive.** Resolve ambiguity before coding. If the plan is unclear, go back to planning instead of asking mid-implementation.
9. **Non-interactive & CI-aware.** Prefer non-interactive commands; use `CI=true` where watch-mode tools exist.

## Status markers

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Task lifecycle (core loop)

For each task in `plan.md`:

1. Read `resume.md` first when resuming a track.
2. Map the task back to the approved acceptance criteria, expected behaviors, and scenarios in `spec.md`.
3. Confirm the task is fully specified. If it is not, stop and move back to planning before implementation begins.
4. Mark the task `[~]` before starting.
5. Decide how the behavior will be proven:
   - default to tests first when feasible
   - if tests-first is not feasible, record why and define another verification method before coding
6. Write or update tests from the approved scenarios when feasible.
7. Run the smallest command needed to confirm the new behavior is not yet satisfied (red phase) when adding/changing behavior.
8. Implement the smallest code change needed to satisfy the approved behavior.
9. Refactor while preserving the approved behavior and keeping verification green.
10. Run the smallest meaningful verification command(s) for the touched area.
11. Mark the task `[x]` when complete.
12. Update `resume.md` whenever you pause, finish a meaningful slice, hit a blocker, or change the expected next step.

## Verification expectations

Before marking a behavior-delivery task complete, verify:

- [ ] The implemented behavior matches the approved acceptance criteria and scenarios
- [ ] Automated verification for the touched area passes
- [ ] Lint/typecheck/build checks for touched areas pass when relevant
- [ ] User-visible or operational behavior has a manual verification note when relevant
- [ ] Errors are actionable and boundaries stay explicit
- [ ] Docs are queued for sync if the track changed project reality

## Coding style contract (applies to every phase)

- Prefer immutable updates over in-place mutation when practical.
- Use strict contracts at boundaries: types/schemas/validators.
- Validate external input early; fail with explicit errors.
- Keep functions focused and files lean (target <500 LOC per file).
- Use structured logs and actionable error messages for observability.
- Avoid hidden coupling and broad side effects.

## Phase completion (recommended)

At the end of each phase:
- run the project’s automated checks for the touched area
- refresh `resume.md` so another session can continue cleanly
- note any behavior or scope drift that needs a spec/plan update before continuing

## Review gate

After implementation is complete and before marking the track done:
- review the result against the approved `spec.md` behaviors, scenarios, and acceptance criteria
- review the result against `plan.md` to catch scope drift or missing work
- confirm the tests and verification steps actually prove the approved behavior
- check for obvious correctness, maintainability, safety, and observability issues
- fix straightforward review findings immediately and rerun targeted verification
- record the review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

If the review fails because the approved plan/spec is no longer sufficient or implementation exposed a contradiction, stop completion and move back to planning rather than improvising.

## Track completion

Before marking a track complete:
- ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- best-effort sync `project.md`, `tech-stack.md`, and `workflow.md` if the completed track materially changed them
- run the project verification gate / final repo checks as appropriate
- update `conductor/tracks.md` from `[~]` to `[x]`
