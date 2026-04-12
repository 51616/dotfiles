# activity-block regression investigation — 2026-04-07

## Summary

Two regressions came from the same extension-side change in `index.ts`:

1. the block was no longer created once per agent run; it was recreated on later assistant turns after tool calls
2. each injected block was sent with `pi.sendMessage(...)`, so the block became a real queued custom message instead of a passive transcript artifact

That combination explains both observed symptoms:

- repeated block spawning after a few tool calls
- self-triggered follow-up turns / infinite loop behavior

## What changed

The current broken implementation had moved block creation away from `before_agent_start` and into this sequence:

- `before_turn_response` updated controller state but intentionally **did not** return the custom message
- `message_start` for `assistant` called `controller.prepareTurn(..., true)` and then injected the block with `pi.sendMessage(...)`

That code path tried to force the block to appear close to the assistant message in the transcript, but it changed the semantics in two bad ways.

## Finding 1: repeated block creation

### Root cause

`message_start` for `assistant` fires for every assistant turn, not only the first visible response for the user prompt.

That includes continuation turns after tool results.

Inside the broken handler, the extension called:

```ts
const prepared = controller.prepareTurn(ctx, Date.now(), true);
```

The hardcoded `true` matters. In `ActivityBlockController.prepareTurn(...)`, `hasTriggerMessages === true` means "finish the current block and start a fresh one" whenever an active turn already exists.

So every later assistant `message_start` looked like a brand-new triggering turn, even when it was only a continuation after tools. The controller therefore persisted the current block and created another one.

### Evidence

- broken extension logic: `activity-block/index.ts`
- block-splitting behavior: `ActivityBlockController.prepareTurn(...)` in the same file
- turn lifecycle note from pi core: continuation turns after tool calls still emit assistant message lifecycle events

## Finding 2: injected blocks became real messages and caused loops

### Root cause

The broken code injected the block with:

```ts
pi.sendMessage(prepared.message, { triggerTurn: false, deliverAs: "steer" })
```

During streaming, `pi.sendMessage()` is **not** a pure UI insert.

In pi core, `sendCustomMessage(...)` does this while streaming:

- `deliverAs: "steer"` -> `agent.steer(appMessage)`
- `deliverAs: "followUp"` -> `agent.followUp(appMessage)`

So the activity block was being queued into the agent as a real custom message inside the turn pipeline.

That means the block itself could become the next trigger message, which then caused more assistant turns and therefore more block injections. That is the loop.

### Evidence

In pi core:

- `dist/core/agent-session.js`
  - streaming `sendCustomMessage(...)` routes to `agent.steer(appMessage)` / `agent.followUp(appMessage)`
  - non-streaming-only immediate insertion is the branch that emits `message_start` + `message_end` directly

So `pi.sendMessage(..., { deliverAs: "steer" })` is a control-plane action, not a harmless transcript placement trick.

## Why `before_agent_start` is the right insertion point

`before_agent_start` already gives the old transcript ordering we want.

For normal prompts and `triggerTurn` custom-message turns, pi core builds the trigger message first, then lets extensions return injected messages from `before_agent_start`, then starts the agent. Interactive mode renders those messages in transcript order, which yields:

```text
user
activity block
assistant
```

That is the stable behavior we want back.

It also keeps the block as part of the same start-of-run message bundle instead of manufacturing a second message later with `sendMessage()`.

## Fix applied

### Extension behavior

The extension now inserts the block from `before_agent_start` again and no longer injects it from `message_start`.

Changes made in `activity-block/index.ts`:

- added a typed `before_agent_start` handler
- returned `{ message: prepared.message }` from that handler
- removed the `before_turn_response` block-injection path
- removed the `message_start` assistant injection path that called `pi.sendMessage(...)`
- removed the related queued-boundary input/message handlers tied to that experiment

### Docs

Updated `activity-block/README.md` so it no longer claims the extension currently depends on `before_turn_response` for block insertion.

## Current behavior after the fix

Expected runtime behavior now:

- one activity block per agent run
- the block stays active across tool-call continuation turns
- the block appears between the triggering message and the assistant response
- no `sendMessage()` self-injection, so no custom-message recursion from block placement

## Assumptions / tradeoffs

- This intentionally restores the older `before_agent_start` placement model.
- The newer `before_turn_response` experiment aimed to give separate block boundaries for queued steering/follow-up turns inside a running agent loop. This fix does **not** keep that experiment active.
- That tradeoff is deliberate because the current goal is correctness and stable transcript ownership, not per-steering-turn block boundaries.

## Files inspected

- `/home/tan/.pi/agent/extensions/activity-block/index.ts`
- `/home/tan/.pi/agent/extensions/activity-block/README.md`
- `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`
- `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
