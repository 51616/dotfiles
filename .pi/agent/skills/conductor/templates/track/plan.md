# Track Plan: <track_description>

> Status markers: `[ ]` not started, `[~]` in progress, `[x]` done
>
> Use the approved `spec.md` as the behavior contract. Each implementation step should trace back to accepted behaviors and scenario examples.
>
> Implementation should be non-interactive. Resolve ambiguity during audit/spec/plan drafting, not after coding starts.

## Phase 1: Scope / impact alignment
- [ ] Task: Confirm the approved spec captures the required acceptance criteria, expected behaviors, and scenario examples
- [ ] Task: Identify affected modules / files / boundaries
- [ ] Task: Choose the verification approach for each behavior slice
- [ ] Task: Resolve all remaining ambiguity before implementation starts

## Phase 2: Behavior-driven implementation
- [ ] Task: Identify the next behavior slice from the approved scenarios
- [ ] Task: Write failing tests first when feasible for the current behavior slice
- [ ] Task: Implement the minimum change needed to satisfy the approved behavior
- [ ] Task: Refactor while preserving the approved behavior and keeping tests green
- [ ] Task: Repeat for remaining behavior slices

## Phase 3: Verification
- [ ] Task: Run targeted automated verification for touched behavior slices
- [ ] Task: Run the smallest meaningful repo checks (tests / lint / typecheck / build) for touched areas
- [ ] Task: Perform manual verification for user-visible or operational behavior (if relevant)

## Phase 4: Review
- [ ] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [ ] Task: Review implementation against the approved `plan.md` and note any scope drift
- [ ] Task: Fix straightforward review findings and rerun targeted verification if needed
- [ ] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 5: Completion sync
- [ ] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [ ] Task: Best-effort sync project docs (`project.md`, `tech-stack.md`, `workflow.md`) if the track changed them
- [ ] Task: Mark track complete in `conductor/tracks.md`

## Notes
- 
