# Track Plan: <track_description>

> Status markers: `[ ]` not started, `[~]` in progress, `[x]` done
>
> Use the approved `spec.md` as the behavior contract. Each implementation step should trace back to accepted behaviors and scenario examples.
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

## Evidence (optional, Showboat — milestone-only)

If you want reproducible proof-of-work, keep a Showboat demo doc at:

- `./evidence/showboat.md`

Default (Option A): capture only key checkpoints:
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied
- final verification

## Phase 1: Scope / impact alignment
- [ ] Task: Confirm the approved spec captures the required acceptance criteria, expected behaviors, and scenario examples
- [ ] Task: Identify affected modules / files / boundaries
- [ ] Task: Choose the verification approach for each behavior slice
- [ ] Task: Resolve all remaining ambiguity before implementation starts

## Phase 2: Behavior-driven implementation
- [ ] Task: Identify the next behavior slice from the approved scenarios
- [ ] Task: Write failing tests first when feasible for the current behavior slice
- [ ] Task: Implement the minimum change needed to satisfy the approved behavior
- [ ] Task: Update **Change evidence** (paths + snippets) for this behavior slice
- [ ] Task: Refactor while preserving the approved behavior and keeping tests green
- [ ] Task: Repeat for remaining behavior slices

## Phase 3: Verification
- [ ] Task: Run targeted automated verification for touched behavior slices
- [ ] Task: Run the smallest meaningful repo checks (tests / lint / typecheck / build) for touched areas
- [ ] Task: Perform manual verification for user-visible or operational behavior (if relevant)
- [ ] Task (optional): If `./evidence/showboat.md` exists, run `uvx showboat verify ./evidence/showboat.md` (or `showboat verify ...`)

## Phase 4: Review
- [ ] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [ ] Task: Review implementation against the approved `plan.md` and note any scope drift
- [ ] Task: Ensure **Change evidence** is sufficient for precise review (paths + snippets map to scenarios)
- [ ] Task: Run `codex-review.sh` with the relevant `spec.md`, `plan.md`, `resume.md`, and Change evidence context
- [ ] Task: Fix straightforward review findings and rerun targeted verification if needed
- [ ] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 5: Completion sync
- [ ] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [ ] Task: Best-effort sync project docs (`project.md`, `tech-stack.md`, `workflow.md`) if the track changed them
- [ ] Task: Mark track complete in `conductor/tracks.md`

## Notes
- 
