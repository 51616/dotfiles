# Self-checkpointing

This extension owns the automatic checkpoint → compact → resume loop that keeps long sessions moving when context pressure gets high.

## Responsibilities

It watches context usage, auto-kicks the checkpoint directive when needed, detects checkpoint footers, runs compaction, and sends the resume self-ping that restarts the session flow.

It also owns the optional autotest and debug helpers that support checkpointing diagnosis without changing the main runtime contract.

## Invariants

There should be one checkpoint cycle per session state at a time.

Threshold-based arming, auto-kick state, pending compaction state, and footer dedupe should stay aligned so one threshold crossing does not trigger duplicate compactions or duplicate resume pings.

Footer detection should be explicit and deduplicated within the configured window instead of guessing from loosely similar output.

Checkpoint footer paths should fail closed only for obviously malformed values. Relative and absolute paths are both acceptable if the target exists, because `pi-ssh` and other environments may surface remote workspace paths that are not under the local vault's old `work/log/checkpoints/` prefix.

Compaction and resume should be driven by the extension's stored session state so stale locks, stale pending resumes, or abandoned autotest state can be detected and cleaned up.

## Failure and recovery

If auto-kick, footer handling, or pending resume state goes stale, recovery should prefer explicit stale-state cleanup and clear debug/status output rather than silent fallback.

In `pi-ssh` mode, footer validation and pending-resume checks must use the SSH-aware checkpoint probe instead of local `fs` checks, otherwise a valid remote checkpoint can suppress compaction or resume.

Compaction lock state must age out or be cleaned up so one interrupted cycle does not block future checkpointing forever.

If checkpointing is disabled by env, the extension should exit cleanly without leaving partial status or background behavior behind.

## Change guidance

If you change threshold, footer, or resume behavior, keep the auto-kick trigger, compaction trigger, and self-ping flow consistent as one lifecycle rather than separate features.

If you change shared compaction semantics, inspect the manager and session-coordination docs in [[pi-instance-manager]].

The implementation is split across `lib/self-checkpointing-*.ts` and the shared autockpt helpers under `../lib/autockpt/**`; changes that touch both should preserve one canonical cycle.

The proving tests for footer-path parsing, footer-to-compaction handoff, and SSH-backed pending resume live in [[tests#Self-checkpointing footer parsing and SSH-backed resume stay aligned]].

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.

Run these checks after changing footer parsing, checkpoint probing, or resume behavior.

- `node --test .pi/extensions/test/autockpt-footer-guards.test.mjs`
- `node --test .pi/extensions/self-checkpointing/test/footer-handler.test.mjs .pi/extensions/self-checkpointing/test/pending-resume.test.mjs .pi/extensions/self-checkpointing/test/checkpoint-probe.test.mjs .pi/extensions/self-checkpointing/test/compaction-ui.test.mjs`
- `bash lat-local.sh .pi/extensions check`
