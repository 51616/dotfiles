# Project Workflow

## Guiding principles

1. **The plan is the source of truth.** Work is tracked in `conductor/tracks/<track_id>/plan.md`.
2. **Prefer small, reviewable steps.** Keep diffs tight; don’t mix unrelated changes.
3. **TDD by default.** Use red → green → refactor for new features and bug fixes whenever feasible.
4. **Code quality is contractual.** Enforce style/validation/error-handling rules from `conductor/code_styleguides/`.
5. **Non-interactive & CI-aware.** Prefer non-interactive commands; use `CI=true` where watch-mode tools exist.

## Status markers

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Task lifecycle (minimal)

For each task in `plan.md`:

1. Mark task `[~]` before starting.
2. Define behavior + acceptance criteria.
3. Write or update tests first (include regression tests for bug fixes when feasible).
4. Run tests to confirm red state when adding new behavior.
5. Implement the smallest code change to reach green.
6. Refactor while keeping tests green.
7. Run smallest verifying command(s) (unit tests/lint/typecheck for touched areas).
8. Mark task `[x]` when complete. Optionally append a commit SHA.

## Coding style contract (applies to every phase)

- Prefer immutable updates over in-place mutation when practical.
- Use strict contracts at boundaries: types/schemas/validators.
- Validate external input early; fail with explicit errors.
- Keep functions focused and files lean (target <500 LOC per file).
- Use structured logs and actionable error messages for observability.
- Avoid hidden coupling and broad side effects.

### Phase completion (recommended)

At the end of each phase:
- run the project’s automated tests
- run the project verification gate skill/checklist
- write a short manual verification checklist (commands + expected outcomes)
