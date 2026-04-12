# do-not-stop patch note (v0.65.0): drop stale session_switch hook

Patch file:
- `patches/v0.65.0/drop-session-switch-hook.patch`

Target:
- local/global `do-not-stop` extension source (`index.ts`)
- intended for use with `pi-mono v0.65.0+`

## Why this patch exists

`do-not-stop` registered a `session_switch` event handler.

In `pi-mono v0.65.0`, that event is not part of the public extension API surface. The extension still restores the same state on `session_start`, which is emitted for:
- startup
- reload
- new
- resume
- fork

So the `session_switch` hook is redundant and makes the extension less compatible with `v0.65.0` type surfaces.

## What this patch changes

- removes the stale `session_switch` registration
- keeps restore logic on `session_start`
- adds a short comment documenting why this is safe

## Behavioral impact

None intended.

State restore still happens on the events that matter in `v0.65.0+`.

## Apply

From the extension root:

```bash
cd ~/.pi/agent/extensions/do-not-stop
git apply patches/v0.65.0/drop-session-switch-hook.patch
```

## Verification

Smoke check after loading under `pi-mono v0.65.0+`:

- extension loads without stale-hook drift
- `/do-not-stop status` still works
- state restores after `/new`, `/resume`, and `/reload`
