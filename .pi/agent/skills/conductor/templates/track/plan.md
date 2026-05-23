# Track Plan: <track_description>

> Status markers: `[ ]` not started, `[~]` in progress, `[x]` done
>
> Use the approved `spec.md` as the behavior contract. Each implementation step should trace back to accepted behaviors and scenario examples.
>
> This must be a concrete implementation plan that a future agent can execute without chat history or current-session context. Prefer exact repo-relative paths, modules, functions, commands, data contracts, ownership boundaries, and verification gates. Avoid vague tasks such as “update code” or “fix tests”; if discovery is required, write an explicit discovery task with the decision it must produce.
>
> Implementation should be non-interactive. Resolve ambiguity during audit/spec/plan drafting, not after coding starts.
>
> Precise review requirement: maintain a running **Change evidence** section in this `plan.md` as you implement.
> - include touched file paths
> - include minimal code snippets/excerpts (with a bit of surrounding context)
> - note which behavior/scenario each snippet satisfies
> - keep it lean: snippets, not whole files

## Change evidence (paths + snippets)

Append entries as you go. Suggested format:

- `path/to/file.ext` — short note (why / which scenario)

```text
<minimal excerpt here>
```

## Evidence (optional, milestone-only)

If you want reproducible proof-of-work, keep concise evidence notes under:

- `./evidence/`

Capture only key checkpoints:
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied
- final verification

## Phase 1: Scope / impact alignment
- [ ] Task: Confirm the approved spec captures the required acceptance criteria, expected behaviors, and scenario examples
- [ ] Task: Identify affected modules / files / boundaries with repo-relative paths and short ownership notes
- [ ] Task: Choose the verification approach for each behavior slice, including exact commands when known
- [ ] Task: Resolve all remaining ambiguity before implementation starts; convert unknown paths/commands into explicit discovery tasks

## Phase 2: Behavior-driven implementation
- [ ] Task: Identify the next behavior slice from the approved scenarios and name the exact files/modules expected to change
- [ ] Task: Write failing tests first when feasible for the current behavior slice (only tests that prove an approved behavior; no testing for its own sake)
- [ ] Task: Link each new/changed test to an approved behavior/scenario (record mapping in Change evidence; when `.lat-md/` exists, prefer `@lat:` refs to a test-spec section per the `lat-md` skill)
- [ ] Task: Implement the minimum change needed to satisfy the approved behavior; name the function/class/entrypoint being changed when known
- [ ] Task (when `.lat-md/` exists): Update the relevant `.lat-md/` sections and add/adjust `@lat:` anchors near touched entrypoints (follow the `lat-md` skill)
- [ ] Task: Update **Change evidence** (paths + snippets) for this behavior slice
- [ ] Task: Refactor while preserving the approved behavior and keeping tests green
- [ ] Task: Repeat for remaining behavior slices

## Phase 3: Verification
- [ ] Task: Run targeted automated verification for touched behavior slices
- [ ] Task: Run the smallest meaningful repo checks (tests / lint / typecheck / build) for touched areas
- [ ] Task (when `.lat-md/` exists): Run `lat check` (use `lat --dir <subproject-root> check` when working in a subtree that has its own `.lat-md/`; follow the `lat-md` skill)
- [ ] Task: Perform manual verification for user-visible or operational behavior (if relevant)
- [ ] Task (optional): If evidence artifacts exist, verify they still match the final commands/results and update stale excerpts.

## Phase 4: Review
- [ ] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [ ] Task: Confirm every new/changed test maps to an approved behavior/scenario (delete or rewrite anything that doesn’t)
- [ ] Task: Review implementation against the approved `plan.md` and note any scope drift
- [ ] Task: Ensure **Change evidence** is sufficient for precise review (paths + snippets map to scenarios)
- [ ] Task: Run `codex-review.sh` with the relevant `spec.md`, `plan.md`, `resume.md`, and Change evidence context
- [ ] Task: Fix straightforward review findings and rerun targeted verification if needed
- [ ] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 5: Completion sync
- [ ] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [ ] Task (when `.lat-md/` exists): Append/update test specs in `.lat-md/tests.md` (or the relevant module’s `.lat-md/tests.md`) and ensure each new/changed test has a corresponding `@lat:` reference (follow the `lat-md` skill)
- [ ] Task: Best-effort sync project docs (`project.md`, `tech-stack.md`, `workflow.md`) if the track changed them
- [ ] Task: Mark track complete in `.conductor/tracks.md`

## Notes
- 
