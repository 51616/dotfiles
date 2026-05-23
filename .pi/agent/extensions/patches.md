# Local pi patch map

This file is the operator note for future pi after a fresh pi upgrade or reinstall. It lists the local patches that matter, which ones are already baked into the local extension sources, and which ones must be reapplied to package repos or pi core.

## Patch classes

There are three different kinds of local patch state here.

1. **pi core patch stack**
   - target: upstream `pi-mono`
   - why: `activity-block` depends on transcript-control and turn-lifecycle seams that are still not upstream in the exact form this vault expects

2. **extension/package repo patch**
   - target: a separately installed package repo under `~/.pi/agent/git/...`
   - why: `pi-fff` must cooperate with `tui-broker` without taking editor ownership back

3. **extension source compatibility edits already baked into local extensions**
   - target: files under `~/.pi/agent/extensions/`
   - why: a few local extensions had stale lifecycle hooks that drifted from newer pi API surfaces
   - these are not normally something you reapply after a new pi binary install; they should already live in the local extension source tree

## What to reapply after a new pi install

### 1) activity-block core patch stack

Current default target:
- `earendil-works/pi-mono v0.75.5`

Source of truth:
- `~/.pi/agent/extensions/activity-block/patches/v0.75.5/README.md`
- `~/.pi/agent/extensions/activity-block/patches/v0.75.5/pi-core-local-extension-seams.patch`

Apply order:
1. `pi-core-local-extension-seams.patch`

Older saved stacks (`v0.67.6` and earlier) still use the three-patch split:
1. `pi-core-live-transcript-mode.patch`
2. `pi-core-custom-message-turn-lifecycle.patch`
3. `pi-core-before-turn-response-lifecycle.patch`

Operational shortcut:
- `bash ~/vault/.pi/scripts/pi/reapply-local-patches.sh`
- default core version in that script should track the current live pi install

What this restores:
- `ctx.ui.setLiveTranscriptMode(...)`
- `ctx.ui.setHistoricalTranscriptMode(...)`
- `before_agent_start` metadata for `triggerTurn` custom messages
- extension event `before_turn_response`
- queued-turn trigger preservation needed by `activity-block`

### 2) pi-fff broker interop patch

This is the important **extension-only / package-side** patch for the `pi-fff` + `tui-broker` pair.

Current active package target:
- `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@ff-labs/pi-fff` (`npm:@ff-labs/pi-fff`, currently `0.8.1`)

Legacy package repo target:
- `~/.pi/agent/git/github.com/SamuelLHuber/pi-fff` (`0.2.4`; kept because old installs may still use it)

Source of truth:
- `~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py`
- `~/vault/.pi/scripts/pi/patches/ff-labs-pi-fff-broker-interop-v0.8.1.patch`
- `~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py`
- `~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.md`
- `~/vault/.pi/scripts/pi/patches/pi-fff-broker-interop-v0.2.4.patch`

Safe check:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py check
python3 ~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py check
```

Actual apply:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py apply
python3 ~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py apply
```

What this restores:
- `tui-broker` remains the canonical editor owner
- current `@ff-labs/pi-fff` contributes through `ctx.ui.addAutocompleteProvider(...)` instead of replacing the editor
- legacy `pi-fff` contributes only an autocomplete wrapper through broker hooks when broker is active
- the context-usage meter and broker-owned editor border stay visible

### 3) tui-broker status

`tui-broker` does **not** currently have a separate patch file to apply after reinstall.

The broker side of the contract lives in the extension source under:
- `~/.pi/agent/extensions/tui-broker/`

The interop patch is on `pi-fff`, not on `tui-broker`.

Relevant verification lives in:
- `~/.pi/agent/extensions/test/ff-labs-pi-fff-broker-interop.test.mjs`
- `~/.pi/agent/extensions/tui-broker/test/*.test.mjs`
- `~/.pi/agent/git/github.com/SamuelLHuber/pi-fff/test/*.test.mjs`

## Compatibility edits that should already stay in local extension source

These are not package-reinstall patches. They are local extension source edits that should already be present in the extension workspace.

### goal
- path: `~/.pi/agent/extensions/goal/index.ts`
- state to preserve: no stale `session_switch` hook
- reason: `session_start` already covers the relevant restore paths on current pi versions

### pi-diff-review-turn-tracker
- path: `~/.pi/agent/extensions/pi-diff-review-turn-tracker/index.ts`
- state to preserve: no stale `session_switch` hook
- reason: `session_start` already covers the relevant reset paths on current pi versions

### pi-ssh
- path: `~/.pi/agent/extensions/pi-ssh/index.ts`
- local behavior to preserve: first persistent-shell marker prints on a fresh line so the first remote bash command does not hang behind the login prompt
- this is extension-local and should remain in the extension source tree; it is not part of the `activity-block` core stack

## One command when you just want the known stack back

```bash
bash ~/vault/.pi/scripts/pi/reapply-local-patches.sh
```

That script is the broad repair entrypoint and should cover:
- the baked extension compatibility checks
- the `pi-fff` broker interop patch
- the `activity-block` core patch stack and reinstall
- the extension workspace local `node_modules/@mariozechner/*` refresh from the same patched tarballs, so tests import the patched runtime surface

## After patching

- start a fresh `pi` process if pi core was reinstalled
- run `/reload` after extension-side changes so the current session reloads extension code and docs
- if something looks wrong, check this file first before guessing
