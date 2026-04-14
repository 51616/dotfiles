# Pi diff review TUI

This extension owns the interactive `/diff-review` overlay for reviewing repo diffs from inside the Pi TUI.

## Responsibilities

It resolves the repo root, chooses the initial review mode, opens the overlay app, and falls back from `t` (last turn) to `a` (`workspace vs HEAD`) when the session has no usable turn bundle.

When `pi-ssh` is active it consumes the shared `pi-ssh` session runtime for remote repo-root lookup, remote workspace-vs-HEAD diffs, remote current-patch inspection, and remote reverse-apply. `/diff-review debug` prints a local-vs-remote backend report instead of opening the overlay.

When the last-turn artifact includes advisory agent metadata, it enriches `t` mode with canonical observed rows, optional reported-only rows that still normalize inside the repo/workspace, and explicit mismatch/provenance state for the UI.

It is the user-facing entrypoint for diff review, while the turn-history data source is owned by [[pi-diff-review-turn-tracker]].

## Invariants

The overlay should only run in interactive TUI sessions.

When last-turn diff data exists, that is the preferred initial mode; when it does not, the fallback to `a` (`workspace vs HEAD`) should be explicit so the user understands what is being reviewed.

Runtime-observed turn rows stay canonical. Reported-only rows are advisory only, must be labeled explicitly, and must never silently become the basis for canonical review counts or file-targeting semantics.

If there is no diff in the chosen mode, the command should fail cleanly with a notification instead of opening an empty overlay.

## Failure and recovery

If repo-root detection fails, surface the error and stop before opening the overlay.

If the turn bundle exists but is empty, prefer an explicit notification and deterministic fallback to `a` rather than guessing another mode silently.

If an advisory reported-only row has no current repo diff, render an explicit inspect-only placeholder instead of fabricating a canonical patch.

## Change guidance

If you change initial mode selection, advisory-row provenance, persisted turn metadata handling, or overlay wiring, inspect [[pi-diff-review-turn-tracker]] because the `t` path depends on the tracker’s output contract.

Keep the command as a thin entrypoint. Heavy diff-review state belongs in the app layer, and the app should keep comment anchors/revalidation and overlay workflows split into their own helpers instead of regrowing a monolith.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.

See [[tests#Diff-review TUI exposes only t-and-a review modes]] and [[tests#Diff-review TUI renders canonical-vs-reported-only file provenance honestly]] for the proving tests. The shared-session SSH path is anchored by `pi-diff-review-tui/test/backend-ssh.test.mjs` and `pi-diff-review-tui/test/entrypoint.test.mjs`.
