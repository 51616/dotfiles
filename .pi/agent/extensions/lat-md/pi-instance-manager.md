# Pi instance manager

This extension is the session-side coordination client for local session state, including queueing, turn locks, compaction lifecycle, session resync, and Discord service status.

## Responsibilities

It translates manager-service state into one canonical session workflow inside the TUI.

That includes queue submission, lock ownership, compaction begin/end hooks, footer status, session resync, and a small amount of auto-heal orchestration when the manager is unavailable.

## Invariants

Coordination is session-id-scoped, even when the TUI session starts outside the vault root.

Queueing, lock acquisition, compaction lifecycle, and remote queue visibility should flow through the manager protocol or state derived from it; do not introduce a second authority for the same session state.

Manager unavailability should stay visible in footer/status output and retry scheduling rather than silently bypassing coordination.

Session resync should reconcile to current durable session state after compaction, resume, or external writes instead of preserving stale local guesses.

## Failure and recovery

When manager RPC calls fail, the extension should leave an explicit degraded-state signal and attempt bounded recovery, not pretend the manager answered successfully.

Compaction cleanup must clear active compaction state and re-pump queued input so a finished compact does not leave the session stuck.

If session files move or change, refresh the tracked session file and re-sync from current state before trusting old local metadata.

## Change guidance

If you change queue, lock, or compaction behavior, inspect [[pi-slash]] and the manager-service docs in [`../../scripts/lat-md/instance-manager-service.md`](../../scripts/lat-md/instance-manager-service.md).

If you change footer or badge semantics, inspect the status/footer tests and the Discord-service badge logic under `lib/pi-instance-manager-discord-service.ts`.

Focused tests live under `.pi/extensions/test/pi-instance-manager-*.test.mjs`, with especially useful coverage in `pi-instance-manager-compaction-lifecycle.test.mjs`, `pi-instance-manager-out-of-vault.test.mjs`, `pi-instance-manager-refresh-sync.test.mjs`, and `pi-instance-manager-footer.test.mjs`.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.

For focused behavior checks, `node --test .pi/extensions/test/pi-instance-manager-compaction-lifecycle.test.mjs .pi/extensions/test/pi-instance-manager-out-of-vault.test.mjs` covers the compaction contract and the out-of-vault session-id coordination path.
