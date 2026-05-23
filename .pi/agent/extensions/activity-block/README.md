# activity-block

This extension depends on **pi core changes** before you use it for the intended transcript UX.

Saved patch artifacts are **versioned by upstream pi-mono tag**.

For **pi-mono v0.67.6** (current default for the live install):
- `patches/v0.67.6/pi-core-live-transcript-mode.patch`
- `patches/v0.67.6/pi-core-custom-message-turn-lifecycle.patch`
- `patches/v0.67.6/pi-core-before-turn-response-lifecycle.patch`
- `patches/v0.67.6/README.md`

For **pi-mono v0.67.2**:
- `patches/v0.67.2/pi-core-live-transcript-mode.patch`
- `patches/v0.67.2/pi-core-custom-message-turn-lifecycle.patch`
- `patches/v0.67.2/pi-core-before-turn-response-lifecycle.patch`
- `patches/v0.67.2/README.md`

For **pi-mono v0.66.1**:
- `patches/v0.66.1/pi-core-live-transcript-mode.patch`
- `patches/v0.66.1/pi-core-custom-message-turn-lifecycle.patch`
- `patches/v0.66.1/pi-core-before-turn-response-lifecycle.patch`
- `patches/v0.66.1/README.md`

For **pi-mono v0.65.2**:
- `patches/v0.65.2/pi-core-live-transcript-mode.patch`
- `patches/v0.65.2/pi-core-custom-message-turn-lifecycle.patch`
- `patches/v0.65.2/pi-core-before-turn-response-lifecycle.patch`

For **pi-mono v0.65.0**:
- `patches/v0.65.0/pi-core-live-transcript-mode.patch`
- `patches/v0.65.0/pi-core-custom-message-turn-lifecycle.patch`
- `patches/v0.65.0/pi-core-before-turn-response-lifecycle.patch`

Legacy/older patch artifacts (kept for reference; may not apply to v0.65.0):
- `patches/pi-core-live-transcript-mode.patch`
- `patches/pi-core-custom-message-turn-lifecycle.patch`

Important: the current extension again relies on `before_turn_response` for per-turn block creation, especially queued steering/follow-up/custom-message turns that must freeze the current block and start a fresh one under the queued trigger message. The saved `v0.67.6`, `v0.67.2`, `v0.66.1`, `v0.65.2`, and `v0.65.0` patch sets all include that lifecycle patch.

Patch notes:
- `patches/pi-core-custom-message-turn-lifecycle.md`

## Why this patch is required

The extension now relies on two core interactive-mode seams:
- `ctx.ui.setLiveTranscriptMode({ toolRows, thinking, working })`
- `ctx.ui.setHistoricalTranscriptMode({ toolRows, thinking })`

Without those seams in pi core, the extension cannot cleanly control transcript ownership for:
- live tool rows
- replayed tool rows on `/resume` and `pi --session <id>`
- the separate working spinner row
- live thinking placeholders
- replayed thinking placeholders

That means the activity block may still load, but the intended behavior is **not supported** until the patch is applied to pi core.

## Patch target

Apply the changes to the canonical `pi-mono` repo.

Current dependency surfaces for full activity-block behavior:
- `packages/agent/src/{types.ts,agent.ts,agent-loop.ts}`
- `packages/agent/test/agent.test.ts`
- `packages/coding-agent/src/core/extensions/{index.ts,runner.ts,types.ts}`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/src/modes/interactive/{interactive-mode.ts}`
- `packages/coding-agent/src/modes/interactive/components/{assistant-message.ts,tool-execution.ts}`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/test/{agent-session-custom-message-turn.test.ts,interactive-mode-live-transcript.test.ts,tool-execution-component.test.ts}`
- `packages/coding-agent/docs/{extensions.md,tui.md}`
- `packages/coding-agent/examples/extensions/{README.md,live-transcript-mode.ts}`

The saved patch files in this directory cover three required concerns for the full current extension behavior:
- transcript-mode seams
- the custom-message trigger fix so queued custom turns preserve the same trigger metadata/lifecycle
- `before_turn_response` queued-turn boundaries so steering/follow-up/custom-message turns can spawn fresh blocks without extra tool-continuation blocks

The saved `v0.67.6`, `v0.67.2`, `v0.66.1`, `v0.65.2`, and `v0.65.0` patch sets include that full stack today.

Behavior covered by the total patch:
- suppress live tool rows and live thinking placeholders while the block owns active-turn UX, while still allowing the stock working spinner row to remain visible
- suppress replayed tool rows and replayed thinking placeholders on session resume so the block remains the canonical transcript surface
- keep hidden-tool state stable across later tool updates
- let extensions suppress hidden-thinking labels entirely when they provide their own summary surface

Current extension-side presentation expectations:
- compact mode shows only the header/first line of the latest thinking text; the thinking body opens only in the block-local thinking-expanded view
- the latest three tool actions stay visible while newer thinking updates arrive, with the most recent action shown first instead of being flushed out by the thinking update
- the block should never show multiple visible thinking bodies at once
- `/activity-block mode default` clears live and historical transcript suppression and hides activity-block messages so pi core's normal tool-call transcript is visible without restarting; `/activity-block mode block` reapplies activity-block transcript ownership for later turns
- `/activity-block zen on` only hides the activity block while keeping block transcript ownership; it is not a replacement for default transcript mode
- resumed sessions reconstruct missing or stale historical block snapshots from assistant `toolCall` messages and matching `toolResult` messages, so previous tool rows remain visible even when `activity-block-state` was not appended before shutdown

Extension-side lifecycle note:
- keep historical transcript suppression enabled for the whole interactive session once the extension claims transcript ownership
- keep live transcript suppression enabled until the current active block is finalized on `agent_end`; tool-result continuation turns reuse the same block across intermediate `turn_end` events
- create the block from `before_turn_response` so each real trigger turn stays ordered as `user -> activity block -> assistant`, including queued steering turns inside an active agent run
- do not inject the block with `pi.sendMessage()` during assistant streaming; that turns the block into a queued custom message instead of a passive transcript artifact
- do not clear historical transcript mode on `agent_end`
- clearing historical transcript mode after a completed turn can trigger interactive-mode history rebuild and make the just-finished turn’s tool rows suddenly reappear

## Apply steps

For the current default saved patch artifacts (**pi-mono v0.67.6**):

```bash
cd ~/research/pi-mono
git checkout v0.67.6
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-live-transcript-mode.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-custom-message-turn-lifecycle.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-before-turn-response-lifecycle.patch
```

For **pi-mono v0.67.2**:

```bash
cd ~/research/pi-mono
git checkout v0.67.2
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-live-transcript-mode.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-custom-message-turn-lifecycle.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-before-turn-response-lifecycle.patch
```

For **pi-mono v0.66.1**:

```bash
cd ~/research/pi-mono
git checkout v0.66.1
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.66.1/pi-core-live-transcript-mode.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.66.1/pi-core-custom-message-turn-lifecycle.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.66.1/pi-core-before-turn-response-lifecycle.patch
```

For a clean **v0.67.6** verification pass after applying the patches:

```bash
cd ~/research/pi-mono
npm ci
npm -w packages/tui run build
npm -w packages/ai run build
npm -w packages/agent test -- test/agent.test.ts
npm -w packages/agent run build
npm -w packages/coding-agent test -- test/suite/agent-session-model-extension.test.ts
npm -w packages/coding-agent run build
npm install -g ./packages/agent ./packages/coding-agent
```

Then start a fresh pi session. `/reload` refreshes extension code, but it does not swap the already-running coding-agent core inside the current session.

## Notes for maintainers

- This patch is the current canonical pi-core dependency for the activity-block extension.
- The extension-side transcript block code lives entirely in this extension directory.
- If upstream pi core changes these files, this patch may need a manual rebase.
- The extension’s transcript ordering fix (`user -> activity block -> assistant`) is extension-side and is **not** part of the core patch.
- The extension currently inserts its block from `before_turn_response`, so each real trigger turn gets one block while tool-result continuation turns reuse the current block.
- The extension must leave historical transcript suppression active across completed turns and keep live suppression active until the active block is finalized on `agent_end`, because tool-result continuations reuse that block.
- The saved `v0.67.6` patch set is the current default. It was regenerated from the repaired local `v0.67.6` branch and split back into the same three canonical artifacts so future reinstalls can reapply it cleanly.
- The saved `v0.67.2` patch set keeps the same underlying change set as `v0.66.1`; the `before_turn_response` patch was rebased so it applies cleanly after the first two patches on `v0.67.2`.
- The saved `v0.66.1` patch set also includes the separate `before_turn_response` lifecycle patch required for queued steering/follow-up/custom-message turn boundaries.
- The same lifecycle patch remains part of the saved `v0.65.2` and `v0.65.0` stacks.
- Patch generation commits (local `pi-mono` regen/rebase work; the same underlying change set carries forward through the saved stacks, with a fresh `v0.67.6` rebase exported as the current default):
  - `36f7ceea` `fix(coding-agent): rebase custom extension hooks onto v0.67.6`
  - `b7653a4b` `feat(coding-agent): add extension transcript modes`
  - `e321d8ec` `fix(coding-agent): run before_agent_start on triggerTurn custom messages`
