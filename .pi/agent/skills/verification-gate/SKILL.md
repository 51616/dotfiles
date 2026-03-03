---
name: verification-gate
description: Run a practical pre-handoff verification gate (quick/full) with language-aware commands, regression-test checks, and a clear PASS/FAIL report.
---

# Verification Gate

Use this skill before handoff, before commit/PR, and after refactors.

## When to use

Use when:
- feature implementation is complete
- bug fix is complete
- major refactor touched multiple files
- Tan asks for “verify”, “is this ready”, “pre-PR check”, or “gate check”

Skip or reduce scope when:
- tiny typo/docs-only edits (run quick gate)

## Modes

- **quick**: changed-area checks only (fast confidence)
- **full**: full project checks + integration/smoke coverage

Default to **quick during implementation**, then **full before final handoff**.

## Step 0: Detect stack and available commands

Read project config first and prefer repo-native scripts:
- JS/TS: `package.json` scripts
- Python: `pyproject.toml`, `requirements*.txt`, `tox.ini`, `noxfile.py`
- Rust: `Cargo.toml`
- Go: `go.mod`

Prefer existing project commands over inventing new ones.

## Step 1: Run verification pipeline

### A) Compile/type/lint (fast quality gate)

Run what exists for the repo, for example:
- JS/TS: `npm test`, `npm run lint`, `npm run typecheck`, `pnpm ...`, `yarn ...`
- Python: `pytest`, `ruff check`, `mypy/pyright`
- Rust: `cargo test`, `cargo clippy`, `cargo fmt --check`
- Go: `go test ./...`, `go vet ./...`

### B) Tests

- Run targeted tests for changed modules first.
- Run full test suite in **full** mode.
- For bug fixes, verify a regression test exists (or explain why not feasible).

### C) Security and safety checks (when available)

Run repo-native security checks if configured (`npm audit`, `pip-audit`, `bandit`, etc.).
If none exist, do lightweight scan for obvious mistakes in changed files:
- hardcoded tokens/secrets
- debug leftovers
- unsafe shell/exec usage

### D) Diff sanity review

Review changed files for:
- accidental unrelated edits
- missing error handling/validation at boundaries
- missing logs/observability for new failure paths
- mismatch between behavior and tests/docs

## Step 2: Produce a strict result

Output this shape:

```text
VERIFICATION GATE: PASS|FAIL
Mode: quick|full

Checks run:
- <command>: PASS|FAIL
- <command>: PASS|FAIL
...

Regression tests:
- Required: yes|no
- Added: yes|no
- Notes: <short>

Risks / follow-ups:
1) ...
2) ...

Ready for handoff: YES|NO
```

If any critical check fails, gate is **FAIL**.

## Operational rules

- Do not claim checks you didn’t run.
- Quote exact failing command and error snippet.
- If a command is unavailable, state why and pick the nearest equivalent.
- Keep the gate deterministic: same commands, same order, explicit outcomes.
