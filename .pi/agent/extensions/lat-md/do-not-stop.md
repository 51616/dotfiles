# Do not stop

This extension owns the optional follow-up loop that keeps the agent moving for a bounded number of extra steps after it would otherwise stop.

## Responsibilities

It tracks the enabled state, repeat target, pending repeats, completed repeats, and session snapshots for the do-not-stop workflow.

It also owns the editor border/status affordance so an interactive user can see when the loop is active and how far through the repeat budget it is.

## Invariants

The enabled state and repeat counters should survive session switches through the saved snapshot model instead of drifting between UI state and runtime state.

A follow-up should only dispatch when the gating rules say it should; do not trigger extra prompts just because the last turn ended.

The editor override should appear only while the mode is active and should be removed cleanly when the mode is disabled.

## Failure and recovery

If snapshot state is missing or stale, the extension should fall back to normalized defaults rather than carrying forward invalid counters.

If the session changes, restore the per-session snapshot before trusting the old in-memory state.

## Change guidance

If you change repeat gating or dispatch behavior, keep the saved snapshot contract and the UI status/border cues aligned as one workflow.

Changes here affect autonomous continuation behavior directly, so prefer explicit state transitions over hidden heuristics.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.
