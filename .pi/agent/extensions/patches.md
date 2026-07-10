# Local pi patch map

This file is the operator note for future pi after a fresh pi upgrade or reinstall. It lists the local patches that matter, which ones are already baked into the local extension sources, and which ones must be reapplied to package repos or pi core.

## Patch classes

There are four different kinds of local patch state here.

1. **pi core patch stack**
   - target: upstream `pi-mono`
   - why: `activity-block` depends on transcript-control and turn-lifecycle seams that are still not upstream in the exact form this vault expects

2. **extension/package repo patch**
   - target: a separately installed package repo under `~/.pi/agent/git/...`
   - why: `pi-fff` must cooperate with `tui-broker` without taking editor ownership back

3. **runtime package/dependency patches**
   - target: installed `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` package copies used by pi
   - why: runtime retry/timeout behavior must fail cleanly instead of hanging or silently changing transports

4. **extension source compatibility edits already baked into local extensions**
   - target: files under `~/.pi/agent/extensions/`
   - why: a few local extensions had stale lifecycle hooks that drifted from newer pi API surfaces
   - these are not normally something you reapply after a new pi binary install; they should already live in the local extension source tree

## What to reapply after a new pi install

### 1) activity-block core patch stack

Current default target:
- `earendil-works/pi-mono v0.80.6`

Source of truth:
- `~/.pi/agent/extensions/activity-block/patches/v0.80.6/README.md`
- `~/.pi/agent/extensions/activity-block/patches/v0.80.6/pi-core-local-extension-seams.patch`

Apply order:
1. `pi-core-local-extension-seams.patch`

Older saved stacks before `v0.70.0` still use the three-patch split:
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

Current active package targets:
- `$(npm root -g)/@ff-labs/pi-fff` (`npm:@ff-labs/pi-fff`, currently `0.8.1` on the global install)
- `~/.pi/agent/npm/node_modules/@ff-labs/pi-fff` when pi has installed the package into its agent package cache (currently `0.8.4` on this machine)

Legacy package repo target:
- `~/.pi/agent/git/github.com/SamuelLHuber/pi-fff` (`0.2.4`; kept because old installs may still use it)

Source of truth:
- `~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py`
- `~/vault/.pi/scripts/pi/patches/ff-labs-pi-fff-broker-interop-v0.8.4.patch`
- `~/vault/.pi/scripts/pi/patches/ff-labs-pi-fff-broker-interop-v0.8.1.patch`
- `~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py`
- `~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.md`
- `~/vault/.pi/scripts/pi/patches/pi-fff-broker-interop-v0.2.4.patch`

Safe check:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py check
if [ -d ~/.pi/agent/npm/node_modules/@ff-labs/pi-fff ]; then
  python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py check --package-root ~/.pi/agent/npm/node_modules/@ff-labs/pi-fff
fi
python3 ~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py check
```

Actual apply:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py apply
if [ -d ~/.pi/agent/npm/node_modules/@ff-labs/pi-fff ]; then
  python3 ~/vault/.pi/scripts/pi/reapply-ff-labs-pi-fff-broker-patch.py apply --package-root ~/.pi/agent/npm/node_modules/@ff-labs/pi-fff
fi
python3 ~/vault/.pi/scripts/pi/reapply-pi-fff-broker-patch.py apply
```

What this restores:
- `tui-broker` remains the canonical editor owner
- every discovered current `@ff-labs/pi-fff` package root contributes through `ctx.ui.addAutocompleteProvider(...)` instead of replacing the editor
- legacy `pi-fff` contributes only an autocomplete wrapper through broker hooks when broker is active
- the context-usage meter and broker-owned editor border stay visible

### 3) pi-ai strict WebSocket transport patch

This is the runtime dependency patch that keeps explicit Codex WebSocket modes strict.

Current active package targets:
- `$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`
- `~/.pi/agent/extensions/node_modules/@earendil-works/pi-ai` when local extension tests import pi runtime packages

Source of truth:
- `~/vault/.pi/scripts/pi/reapply-pi-ai-strict-websocket-patch.py`
- `~/vault/.pi/scripts/pi/test/openai-codex-strict-websocket.test.mjs`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-strict-websocket-npm-v0.80.6.patch`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-strict-websocket-npm-v0.78.0.patch`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-strict-websocket-npm-v0.77.0.patch`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-strict-websocket-npm-v0.75.5.patch`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-strict-websocket-legacy-v0.75.5.patch`

Safe check:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-pi-ai-strict-websocket-patch.py check
if [ -d ~/.pi/agent/extensions/node_modules/@earendil-works/pi-ai ]; then
  python3 ~/vault/.pi/scripts/pi/reapply-pi-ai-strict-websocket-patch.py check --package-root ~/.pi/agent/extensions/node_modules/@earendil-works/pi-ai
fi
```

Actual apply:
```bash
python3 ~/vault/.pi/scripts/pi/reapply-pi-ai-strict-websocket-patch.py apply
if [ -d ~/.pi/agent/extensions/node_modules/@earendil-works/pi-ai ]; then
  python3 ~/vault/.pi/scripts/pi/reapply-pi-ai-strict-websocket-patch.py apply --package-root ~/.pi/agent/extensions/node_modules/@earendil-works/pi-ai
fi
```

What this restores:
- `transport: "websocket"` and `transport: "websocket-cached"` retry the WebSocket path and then fail without SSE fallback
- `transport: "auto"` may still fall back to SSE after WebSocket retries are exhausted
- strict WebSocket mode ignores stale per-session fallback state created while the session was in `auto`

### 4) saved runtime-resilience diffs for v0.75.5

These patch artifacts capture old live global package edits that were not previously represented by the `activity-block` core stack or the strict WebSocket patch. They remain as historical v0.75.5 reconstruction notes. Upstream v0.80.6 already carries the retry/timeout baseline that mattered here; the current fast path reapplies only the strict WebSocket transport boundary on top of v0.80.6.

Source of truth:
- `~/vault/.pi/scripts/pi/patches/earendil-pi-coding-agent-runtime-resilience-v0.75.5.patch`
- `~/vault/.pi/scripts/pi/patches/earendil-pi-ai-runtime-resilience-base-v0.75.5.patch`

Apply order if you need to reconstruct the exact current global runtime on `0.75.5`:
1. install the `activity-block` patched `@earendil-works/pi-coding-agent` tarball
2. apply `earendil-pi-coding-agent-runtime-resilience-v0.75.5.patch` to `$(npm root -g)/@earendil-works/pi-coding-agent`
3. apply `earendil-pi-ai-runtime-resilience-base-v0.75.5.patch` to a clean registry `@earendil-works/pi-ai@0.75.5` package root
4. apply `earendil-pi-ai-strict-websocket-npm-v0.75.5.patch` to that same `@earendil-works/pi-ai` package root

Do not apply the pi-ai runtime-resilience base patch on top of the legacy strict WebSocket patch without resetting that package copy first. The base patch creates the npm-layout shape that the npm strict WebSocket patch expects.

What this restores:
- provider SDK `maxRetries` defaulting to `0` unless explicitly configured
- terminal quota/usage-limit errors treated as non-retryable
- capped `Retry-After` handling for Codex HTTP retries
- OpenAI Codex WebSocket connect and idle timeout plumbing
- `websocketConnectTimeoutMs` flowing from pi-coding-agent settings into pi-ai

The broad `reapply-local-patches.sh` fast path does not apply these two runtime-resilience diffs. Treat them as historical artifacts for reconstructing the old v0.75.5 runtime, not as current v0.80.6 steps.

### 5) tui-broker status

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
- the `pi-ai` strict WebSocket transport patch
- the extension workspace local runtime package refresh from the same patched tarballs, so tests import the patched runtime surface

It does not yet apply the saved runtime-resilience diffs from section 4.

## After patching

- start a fresh `pi` process if pi core was reinstalled
- run `/reload` after extension-side changes so the current session reloads extension code and docs
- if something looks wrong, check this file first before guessing
