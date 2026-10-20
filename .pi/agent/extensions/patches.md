# Local pi patch map

This file is the operator note for future pi after a fresh pi upgrade or reinstall.

## Current state (2026-10-20, pi 1.3.0)

There are no local patches to reapply. A stock `npm install -g @earendil-works/pi-coding-agent` is the complete runtime.

- **pi core:** `activity-block` and `goal` run on stock pi through the public extension API (see `activity-block/README.md`). The old `activity-block/patches/` core stack was removed. Do not resurrect an old core rebuild: it would downgrade pi.
- **pi-fff:** pi loads `npm:@ff-labs/pi-fff` (settings `packages`) from `~/.pi/agent/npm/node_modules/@ff-labs/pi-fff`. Since 0.11.0 it contributes autocomplete through `ctx.ui.addAutocompleteProvider(...)` and never replaces the editor, so `tui-broker` stays the editor owner without a package patch. The old broker-interop patches for 0.2.4 / 0.8.x and the legacy `SamuelLHuber/pi-fff` checkout were removed.
- **pi-ai transport:** no strict WebSocket patch. Settings use `"transport": "auto"`, where falling back to SSE after WebSocket retries is upstream behavior. If you ever switch to `"websocket"` or `"websocket-cached"`, note that upstream may still fall back to SSE; port a patch only if that matters.

The vault-side `reapply-local-patches.sh` and its patch artifacts were deleted. Their history is in the vault git log (commits `238bc28`, `dc410ab`) if a patch ever needs to be ported again.

## Tripwires after an upgrade

These tests catch a pi or pi-fff release that breaks the contracts above:

```bash
cd ~/.pi/agent/extensions
node --test test/ff-labs-pi-fff-broker-interop.test.mjs tui-broker/test/*.test.mjs
node --test test/goal*.test.mjs activity-block/test/*.test.mjs
```

If the pi-fff interop test fails, check whether pi-fff started calling `ctx.ui.setEditorComponent(...)` again before writing a new patch.

## Extension-local invariants

These live in the extension source tree and need no reapply step:

- `goal/index.ts`: no stale `session_switch` hook; `session_start` covers restore paths.
- `pi-ssh/index.ts`: the first persistent-shell marker prints on a fresh line so the first remote bash command does not hang behind the login prompt.

## After an upgrade

- Start a fresh `pi` process; running processes keep old code in memory.
- Run `/reload` after extension-side changes.
