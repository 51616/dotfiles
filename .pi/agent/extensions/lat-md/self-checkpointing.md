# Self-checkpointing

This extension owns the automatic checkpoint → compact → resume loop that keeps long sessions moving when context pressure gets high.

## Responsibilities

It watches context usage, auto-kicks the checkpoint directive when needed, detects checkpoint footers, runs compaction, and sends the resume self-ping that restarts the session flow.

It also owns the optional autotest and debug helpers that support checkpointing diagnosis without changing the main runtime contract.

## Invariants

There should be one checkpoint cycle per session state at a time.

Threshold-based arming, auto-kick state, pending compaction state, and footer dedupe should stay aligned so one threshold crossing does not trigger duplicate compactions or duplicate resume pings.

Footer detection should be explicit and deduplicated within the configured window instead of guessing from loosely similar output.

Compaction and resume should be driven by the extension's stored session state so stale locks, stale pending resumes, or abandoned autotest state can be detected and cleaned up.

## Failure and recovery

If auto-kick, footer handling, or pending resume state goes stale, recovery should prefer explicit stale-state cleanup and clear debug/status output rather than silent fallback.

Compaction lock state must age out or be cleaned up so one interrupted cycle does not block future checkpointing forever.

If checkpointing is disabled by env, the extension should exit cleanly without leaving partial status or background behavior behind.

## Change guidance

If you change threshold, footer, or resume behavior, keep the auto-kick trigger, compaction trigger, and self-ping flow consistent as one lifecycle rather than separate features.

If you change shared compaction semantics, inspect the manager and session-coordination docs in [[pi-instance-manager]].

The implementation is split across `lib/self-checkpointing-*.ts` and the shared autockpt helpers under `../lib/autockpt/**`; changes that touch both should preserve one canonical cycle.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.

For this pass we are keeping verification light and not adding test-spec wiring yet.
