# Resume: Dock live activity block below Working spinner

## Current state

Implementation, documentation sync, targeted verification, lattice verification, broad regression sweep, and review are complete. `/reload` was scheduled through `pi_slash` and will run after the current response finishes.

Track artifacts:

- Spec: `.conductor/tracks/dock-live-activity-block_20260529/spec.md`
- Plan: `.conductor/tracks/dock-live-activity-block_20260529/plan.md`
- Evidence: `.conductor/tracks/dock-live-activity-block_20260529/evidence/final-verification.md`
- Resume: `.conductor/tracks/dock-live-activity-block_20260529/resume.md`

## Active phase/task

- Phase: complete.
- Active task: final report to Tan after the pi-owned commit is created.

## Last completed step

Ran final Codex review after fixes. It reported no blockers and no remaining concrete findings.

## Approved decisions

- Live dock height stays at 20 lines.
- Keep the standard gap below `Working...`.
- Keep instant aborted blocks in history.
- User aborts say `Aborted`; queued steering keeps `Interrupted by steering`.
- Terminal blocks stay docked until next input.
- Zen mode hides both live and historical activity-block surfaces.
- Default mode clears/restores behavior when processed.

## Implemented behavior

- Active block installs as `activity-block-live-dock` via `ctx.ui.setWidget(..., { placement: "aboveEditor" })`, putting it below the stock `Working...` row and above the editor in pi's current layout.
- The matching active transcript renderer returns no rows while the dock widget is visible, preventing duplicate blocks.
- `dockedTurnId` is tracked separately from `activeTurn`, so complete/aborted/error snapshots remain docked after `agent_end`.
- The retained terminal dock clears on the next idle `input`, exposing the historical transcript block.
- Queued steering finalizes the old block as `Interrupted by steering`, exposes it in transcript history, and replaces the dock with the next active block.
- `/activity-block mode default` clears the dock and transcript modes when processed.
- Zen mode hides the dock and transcript blocks while preserving retained dock state so zen-off restores the live/terminal dock before the next input.
- Unit-test contexts that omit `setWidget` keep the transcript-rendering path visible. This prevents false hidden blocks in older/fake contexts; the live install is assumed to expose `setWidget`. This reduced transcript-only mode is documented in `activity-block/README.md`, `.lat-md/activity-block.md`, and the spec.
- Widget-enabled regression coverage drives thinking updates and tool start/update/end events through the dock and asserts both rendered changes and explicit refresh triggers.

## Files changed

- `activity-block/index.ts`
- `test/activity-block-index.test.mjs`
- `activity-block/README.md`
- `.lat-md/activity-block.md`
- `.lat-md/tests.md`
- `.conductor/project.md`
- `.conductor/project-guidelines.md`
- `.conductor/tech-stack.md`
- `.conductor/workflow.md`
- `.conductor/tracks.md`
- `.conductor/tracks/dock-live-activity-block_20260529/*`

## Verification completed

Passed:

- `node --test test/activity-block-index.test.mjs`
- `node --test test/activity-block-widget.test.mjs test/activity-block-state.test.mjs test/activity-block-view-mode.test.mjs test/activity-block-thinking-visibility.test.mjs`
- `node --test test/activity-block-*.test.mjs`
- `node --test activity-block/test/*.test.mjs`
- `run_skill_script skill://lat-md/scripts/run-lat.sh bash /home/tan/.pi/agent/extensions check all`

Review:

- Final `codex-review` pass: no blockers, no remaining concrete findings.

Broad regression command run after final code changes:

- `node --test test/*.test.mjs`

Broad regression result:

- 312 total, 302 passed, 10 failed.
- All activity-block tests passed in the broad run.
- The 10 failures are outside activity-block and appear unrelated to this change:
  - `test/pi-instance-manager-compaction-lifecycle.test.mjs`: missing `setActiveCompactionFencingToken` in test/client seam.
  - `test/pi-instance-manager-out-of-vault.test.mjs`: harness expected an enqueue request that was not produced.
  - `test/pi-instance-manager-queue-reissue.test.mjs`: queue reissue expectations mismatch.
  - `test/pi-instance-manager-state.test.mjs`: remote queued-turn count expected `2`, actual `0`.
  - `test/pi-instance-manager-turn-lock.test.mjs`: turn-lock fencing-token helper mismatches.
  - `test/pi-instance-manager-turn-ticket.test.mjs`: missing `buildTuiOwner` in test/client seam.
  - `test/pi-interactive-compaction-spinner.test.mjs`: installed interactive-mode compaction-loader behavior mismatch.
  - `test/runtime-extension-contracts.test.mjs`: runtime inventory includes `remote-fff-forward` while the expected matrix omits it.

## Additional assumptions made

- `ctx.ui.setWidget` exists in the live pi TUI. The implementation avoids hiding transcript blocks when that seam is missing in tests/fake contexts and documents the reduced transcript-only mode.
- "Next input" means the extension `input` event when no active turn is running. If an automated follow-up starts without that idle input, the new active block replaces the retained dock and the previous terminal block becomes transcript-visible.
- Keeping zen state lossless is better than clearing dock state; zen hides surfaces, not state.

## Blockers / risks / deviations

- No activity-block blockers remain.
- The broad suite has unrelated failures listed above; they are not caused by the touched activity-block files based on scope, passing targeted activity-block/regression tests, and final Codex review.

## Next steps for a future session

- If broad-suite cleanliness matters, handle the unrelated pi-instance-manager/runtime-contract failures in a separate track.
- After this response, confirm `/reload` completed and run `/pi-slash-commands` only if validating slash-command behavior is desired.
