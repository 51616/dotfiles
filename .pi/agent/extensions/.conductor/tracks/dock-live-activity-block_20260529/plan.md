# Implementation Plan: Dock live activity block below Working spinner

Status: approved for implementation on 2026-05-29.

## Approved design decisions

- [x] Live dock height stays at the existing 20-line cap.
- [x] Keep the standard one-line gap below `Working...`.
- [x] Keep instant aborted blocks in history.
- [x] User aborts say `Aborted`; queued steering keeps `Interrupted by steering`.
- [x] Terminal blocks stay docked until next input.
- [x] Zen mode hides both live and historical activity-block surfaces.
- [x] Default mode clears/restores behavior when processed.

## Phase 1 — Tests-first behavior coverage

- [x] Add/extend `test/activity-block-index.test.mjs` fake UI support for `setWidget` without changing old tests that intentionally omit widget support.
- [x] Add regression coverage for active dock install below the working row via `aboveEditor` widget placement.
- [x] Add regression coverage that active transcript rendering is hidden while the dock owns the active block.
- [x] Add regression coverage that terminal blocks remain docked after `agent_end` and clear only on the next input.
- [x] Add regression coverage for abort/error terminal dock retention and cleanup.
- [x] Add regression coverage for queued steering replacing the old dock with the new active turn.
- [x] Add regression coverage for default mode and zen mode clearing/hiding the dock according to the approved policy.

## Phase 2 — Extension implementation

- [x] Add a live-dock widget key and typed optional widget UI seam in `activity-block/index.ts`.
- [x] Track the currently docked turn independently from `activeTurn` so terminal snapshots can remain docked after completion.
- [x] Install the live dock when an active block starts and hide the corresponding transcript renderer while the dock is visible.
- [x] Keep the dock attached to the persisted terminal snapshot after completion/abort/error until the next user input.
- [x] Clear the retained dock on the next idle input, default mode, session shutdown/reset, and stale lifecycle paths.
- [x] Make zen mode hide the dock without losing the retained dock state, and restore it when zen is disabled before next input.
- [x] Preserve historical/live transcript suppression behavior and queued-turn boundary behavior.

## Phase 3 — Documentation and lattice sync

- [x] Update `.lat-md/activity-block.md` with live-dock ownership, terminal retention, and cleanup rules.
- [x] Update `.lat-md/tests.md` with the new proving coverage.
- [x] Update `activity-block/README.md` if the implementation changes the documented extension-side lifecycle dependency.
- [x] Keep this plan and `resume.md` current with change evidence.

## Phase 4 — Verification and review

- [x] Run targeted activity-block tests:
  - `node --test test/activity-block-index.test.mjs`
  - `node --test test/activity-block-widget.test.mjs`
  - `node --test test/activity-block-state.test.mjs`
  - `node --test test/activity-block-view-mode.test.mjs test/activity-block-thinking-visibility.test.mjs`
- [x] Run local extension activity-block tests under `activity-block/test/` if compatible with the installed runtime.
- [x] Run a broader relevant regression command for activity-block-related tests.
- [x] Run `/reload` after extension code changes.
- [x] Run a review pass against `spec.md`, `plan.md`, touched files, and verification evidence.
- [x] Update `resume.md`, metadata, and `.conductor/tracks.md` for final state.
- [x] Commit pi-owned changes if the extension workspace is git-tracked.

## Change evidence

Implemented and verified so far:

- `activity-block/index.ts` now tracks `dockedTurnId` separately from `activeTurn`, installs `activity-block-live-dock` as an `aboveEditor` widget, hides the matching transcript renderer while the dock is visible, retains terminal snapshots in the dock until the next idle input, clears the dock in default mode/reset paths, and lets zen mode hide/restore the dock without losing retained state.
- `test/activity-block-index.test.mjs` now has optional `setWidget` fake-UI support and covers active dock install, active transcript duplicate hiding, live dock thinking/tool start/update/end lifecycle updates with explicit render invalidation, terminal dock retention for complete/aborted/error runs, queued-steering dock replacement, default-mode dock clearing, and zen dock hiding/restoration.
- `.lat-md/activity-block.md`, `.lat-md/tests.md`, `activity-block/README.md`, and `spec.md` now describe the live dock, retained terminal dock contract, and documented transcript-only reduced mode when `ctx.ui.setWidget` is absent.
- Verification passed:
  - `node --test test/activity-block-index.test.mjs`
  - `node --test test/activity-block-widget.test.mjs test/activity-block-state.test.mjs test/activity-block-view-mode.test.mjs test/activity-block-thinking-visibility.test.mjs`
  - `node --test test/activity-block-*.test.mjs`
  - `node --test activity-block/test/*.test.mjs`
  - `run_skill_script skill://lat-md/scripts/run-lat.sh bash /home/tan/.pi/agent/extensions check all`
- Broad regression command `node --test test/*.test.mjs` was run after final code changes. Activity-block tests passed; 10 unrelated failures remain in pi-instance-manager/runtime contract/interactive compaction tests and are recorded in `resume.md` and `evidence/final-verification.md`.
- Final Codex review reported no blockers and no remaining concrete findings.
- `/reload` was scheduled through `pi_slash` after the current response finishes.
