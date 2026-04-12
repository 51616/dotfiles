# activity-block note (v0.65.0): missing before_turn_response / queued-turn lifecycle patch

Status:
- **Resolved for the current extension implementation**
- Existing saved v0.65.0 patches in this directory are all still necessary
- The missing lifecycle patch now exists as:
  - `pi-core-before-turn-response-lifecycle.patch`

Existing saved v0.65.0 patches:
- `pi-core-live-transcript-mode.patch`
- `pi-core-custom-message-turn-lifecycle.patch`

Patch class covered by the new patch:
- turn-response lifecycle support for the current `activity-block` design built around `before_turn_response`
- queued steering/follow-up/custom-message turn boundaries that preserve one canonical active block per real turn

## Why this note exists

This note remains as historical context for why the third `v0.65.0` patch was added separately instead of being folded into the older patch artifacts.

The current `activity-block` extension creates and rolls blocks in `before_turn_response`:

- a new block starts only when `event.triggerMessages.length > 0`
- tool-result continuations reuse the current block when `triggerMessages` is empty
- queued steering/follow-up/custom-message turns must finalize the current block and start the next one at the right boundary

The saved v0.65.0 patch set only covers:

1. transcript suppression seams
2. older custom-message `triggerTurn: true` routing through `before_agent_start`

That was enough for older `before_agent_start`-centered variants of the extension. It was not enough for the current `before_turn_response`-centered lifecycle.

## Observable risk on plain upstream v0.65.0 before the new patch

Even if the two saved v0.65.0 patches are applied, the current extension can still drift on queued turns:

- steering/follow-up turns may not get a fresh block at the correct boundary
- the current block may remain open too long across queued turn transitions
- interrupted-turn persistence can happen too late or against the wrong turn boundary
- transcript ownership can be inconsistent across active-turn vs continuation-turn paths

In short: before the new patch, the block UI could load, but the current per-turn contract was not fully backed by upstream v0.65.0.

## Current extension-side contract that core must support

The current extension expects all of the following to hold:

1. `before_turn_response` fires before each model response turn, not just the initial user-triggered path
2. queued steering and follow-up messages create distinct turn boundaries
3. `event.triggerMessages` is populated for real new turns and empty for tool-result continuations
4. a custom-message-triggered turn and a user-triggered turn share the same boundary semantics
5. the extension can persist/interrupt the previous block before the next real turn begins

Without that, this logic in `activity-block/index.ts` is not reliable enough:

- `prepareTurn(..., event.triggerMessages.length > 0)`
- `markQueuedTurnBoundary()`
- `consumeQueuedTurnBoundary(...)`
- `primeQueuedTurn(...)`

## Likely patch surface

Based on the local extension README and current architecture expectations, the missing patch likely needs coordinated changes across:

- `packages/agent/src/{types.ts,agent.ts,agent-loop.ts}`
- `packages/agent/test/agent.test.ts`
- `packages/coding-agent/src/core/extensions/{index.ts,runner.ts,types.ts}`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/test/*` covering queued turn boundaries and transcript ownership

The likely shape is:

- formalize a pre-response extension hook for every actual response turn
- preserve queued-message boundary metadata through the agent loop
- make continuations distinguishable from new queued turns with one canonical signal
- keep the event contract stable enough that extensions can own transcript state per turn

## Relationship to the existing v0.65.0 patches

Keep these concerns separate:

### Already covered by saved v0.65.0 patches
- transcript suppression UI seams
- `triggerTurn` custom messages entering `before_agent_start`

### Not yet covered by a saved patch
- `before_turn_response` support for the current extension
- queued steering/follow-up lifecycle semantics
- per-turn interruption/finalization guarantees for the current block model

## Recommendation for future patching

When regenerating a full v0.65.0 patch set for the current extension, do not fold this silently into the older patch notes.

Keep three separate artifacts:

1. transcript mode seams
2. custom-message `before_agent_start` routing
3. `before_turn_response` / queued-turn lifecycle support

That separation matters because only the third item is still missing for the current extension behavior.

## Verification target for the completed patch set

A correct full patch should make all of these true in a real interactive session:

- initial prompt starts one activity block
- a queued steering message interrupts and persists the current block immediately
- the next model response starts a fresh block under the steering message
- tool-result continuations do not create extra blocks
- follow-up/custom-message-triggered turns get exactly one block each
- resumed history does not re-surface hidden transcript rows while the extension owns transcript rendering
