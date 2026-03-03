---
name: conductor-scrutinize
description: |
  Use when: Tan asks for an iterative codebase scrutiny loop with explicit per-round artifacts (review → trim → implement) with evidence-gated deletions and verification after each round. Trigger on phrases like: "multi-round cleanup", "review trim implement loop", "do N rounds", "full sweep", "dead code pass", or "continue to round 10".
  Don’t use when: the task is a normal feature/refactor track without repeated scrutiny rounds (use `conductor`), or a tiny one-off cleanup (normal editing flow), or runtime/service triage (use `service-observability` / ops skills).
  Outputs: round-structured artifacts under `conductor/tracks/<track_id>/rounds/` (`review_round_<NN>.md`, `trim_round_<NN>.md`, `implement_round_<NN>.md`), an updated `rounds/progress.md`, updated `plan.md`/`resume.md`, and a final debt ledger + verification summary. Do not resume existing tracks unless explicitly asked.
---

# conductor-scrutinize

Use this when work must happen in repeated **review → trim → implement** rounds with auditable evidence. Do not stop until every round has been verified. Do not resume existing tracks unless explicitly asked.

## Workflow

1) Confirm the scrutiny contract:
- total rounds and scope mode per round (`extensions_full`, `scripts_full`, `both_full`; legacy partial only if explicitly allowed)
- artifact contract (3 docs per round)
- verification matrix per round

2) Scaffold or verify scrutiny files:
- `conductor/tracks/<track_id>/rounds/ARTIFACT_CONTRACT.md`
- `conductor/tracks/<track_id>/rounds/progress.md`
- round folders and artifact docs

3) Run each round with strict discipline:
- **review**: full declared scope scan + candidate list
- **trim**: evidence trace before removals (static refs + runtime/entrypoint reasoning)
- **implement**: minimal behavior-preserving changes + tests

4) After each round:
- run verification commands and capture exact outcomes
- update `rounds/progress.md`, `plan.md`, `resume.md`
- commit/push grouped by intent (code then docs)

5) Final closeout:
- ensure all required artifacts exist
- finalize debt ledger (`removed / refactored`)
- preferably do not defer big changes to the next round, the scope can be bigger than typical sofrware engineering workflow
- mark track metadata/status complete

## Supporting files

- Templates:
  - `templates/review_round.md`
  - `templates/trim_round.md`
  - `templates/implement_round.md`
  - `templates/progress.md`
- Scripts:
  - `scripts/init-rounds.sh`
  - `scripts/verify-artifacts.sh`
- Example:
  - `examples/round-contract-example.md`

## Verification

1. Initialize round skeletons:
- `bash "$PI_VAULT_ROOT/agents/skills/conductor-scrutinize/scripts/init-rounds.sh" --track-dir /path/to/repo/conductor/tracks/<track_id> --rounds 10`

2. Validate artifact completeness:
- `bash "$PI_VAULT_ROOT/agents/skills/conductor-scrutinize/scripts/verify-artifacts.sh" --track-dir /path/to/repo/conductor/tracks/<track_id> --rounds 10`
