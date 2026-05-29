# Final verification evidence

Date: 2026-05-29 JST

## Targeted activity-block verification

Passed:

```text
cd /home/tan/.pi/agent/extensions
node --test test/activity-block-index.test.mjs
node --test test/activity-block-widget.test.mjs test/activity-block-state.test.mjs test/activity-block-view-mode.test.mjs test/activity-block-thinking-visibility.test.mjs
node --test test/activity-block-*.test.mjs
node --test activity-block/test/*.test.mjs
```

Final combined activity-block run result:

```text
node --test test/activity-block-*.test.mjs
# 94 tests passed, 0 failed

node --test activity-block/test/*.test.mjs
# 15 tests passed, 0 failed
```

## Lattice verification

Passed:

```text
run_skill_script skill://lat-md/scripts/run-lat.sh bash /home/tan/.pi/agent/extensions check all
# Scanned 17 markdown files in ./.lat-md
# All checks passed
```

## Review gate

Codex review was run three times during implementation. The final review reported:

```text
No blockers.
No remaining concrete findings from this re-review.
```

## Broad regression sweep

Command run:

```text
cd /home/tan/.pi/agent/extensions
node --test test/*.test.mjs
```

Result:

```text
312 tests total
302 passed
10 failed
```

All activity-block tests passed in the broad run. The 10 failures are outside activity-block and appear unrelated to this change:

- `test/pi-instance-manager-compaction-lifecycle.test.mjs`: missing `setActiveCompactionFencingToken` in the compaction lifecycle test seam.
- `test/pi-instance-manager-out-of-vault.test.mjs`: harness expected an enqueue request that was not produced.
- `test/pi-instance-manager-queue-reissue.test.mjs`: queue reissue expectations mismatch.
- `test/pi-instance-manager-state.test.mjs`: remote queued-turn count expected `2`, actual `0`.
- `test/pi-instance-manager-turn-lock.test.mjs`: turn-lock fencing-token helper mismatch.
- `test/pi-instance-manager-turn-ticket.test.mjs`: missing `buildTuiOwner` helper in the test seam.
- `test/pi-interactive-compaction-spinner.test.mjs`: installed interactive-mode compaction-loader behavior mismatch.
- `test/runtime-extension-contracts.test.mjs`: runtime inventory includes `remote-fff-forward` while the expected matrix omits it.

## Runtime reload

`/reload` was scheduled through `pi_slash` after the current response finishes, because extension runtime code changed.
