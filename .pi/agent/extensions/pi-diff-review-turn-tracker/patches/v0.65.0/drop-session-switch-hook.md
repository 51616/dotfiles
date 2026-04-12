# pi-diff-review-turn-tracker patch note (v0.65.0): drop stale session_switch hook

Patch file:
- `patches/v0.65.0/drop-session-switch-hook.patch`

Target:
- local/global `pi-diff-review-turn-tracker` extension source (`index.ts`)
- intended for use with `pi-mono v0.65.0+`

## Why this patch exists

`pi-diff-review-turn-tracker` registered a `session_switch` event handler only to call `reset()`.

In `pi-mono v0.65.0`, `session_switch` is not part of the public extension API surface. The extension already resets on `session_start`, which is emitted for:
- startup
- reload
- new
- resume
- fork

So the stale hook is redundant and just creates avoidable compatibility drift.

## What this patch changes

- removes the stale `session_switch` registration
- keeps the reset on `session_start`
- adds a short comment documenting why this is safe

## Behavioral impact

None intended.

Turn-tracker state still resets on the lifecycle boundaries that matter in `v0.65.0+`.

## Apply

From the extension root:

```bash
cd ~/.pi/agent/extensions/pi-diff-review-turn-tracker
git apply patches/v0.65.0/drop-session-switch-hook.patch
```

## Verification

Smoke check after loading under `pi-mono v0.65.0+`:

- extension loads without stale-hook drift
- diff review tracking still starts from new input
- state resets after `/new`, `/resume`, and `/reload`
