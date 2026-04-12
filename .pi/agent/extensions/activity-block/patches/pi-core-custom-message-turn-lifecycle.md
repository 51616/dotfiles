# pi core patch note: custom-message turn lifecycle

Patch files:
- Legacy (older pi-mono): `patches/pi-core-custom-message-turn-lifecycle.patch`
- pi-mono v0.65.0: `patches/v0.65.0/pi-core-custom-message-turn-lifecycle.patch`

Canonical regen commits (local):
- v0.65.0: `e321d8ec` `fix(coding-agent): run before_agent_start on triggerTurn custom messages`

Status note:
- this saved patch covers the older custom-message trigger fix only
- the current activity-block extension now starts blocks from `before_turn_response`, so this note is historical context for the saved patch artifact rather than the whole current lifecycle
- the newer steering/follow-up per-turn lifecycle support now also requires local changes in `packages/agent` plus additional `packages/coding-agent` wiring (`before_turn_response` / `beforeTurn`)
- that broader patch set has not yet been regenerated into `patches/`

## Why this patch exists

The main transcript-mode patch makes the activity block own live and replayed transcript rendering, but it does **not** fix one separate lifecycle hole:

- `before_agent_start` ran for normal user-triggered turns
- `sendCustomMessage(..., { triggerTurn: true })` bypassed that hook and called `agent.prompt(...)` directly

That meant extension-triggered turns could skip activity-block insertion entirely.

The concrete broken case for Tan was auto-checkpointing:
- `self-checkpointing` injects the `[autockpt] ...` directive with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`
- that starts a turn without `before_agent_start`
- the activity-block extension creates one per-turn block in `before_agent_start`
- result: no activity block during the auto-checkpoint turn

## What this patch changes

This patch makes custom-message-triggered turns use the same pre-turn extension lifecycle as normal user-triggered turns.

Behavior after patch:
- `before_agent_start` fires for both:
  - normal user turns
  - custom-message turns started with `triggerTurn: true`
- extensions can inject per-turn transcript messages for those custom-triggered turns too
- system-prompt modifications from `before_agent_start` apply consistently to both turn types

For the activity block, this fixes auto-checkpoint turns without coupling `activity-block` directly to `self-checkpointing`.

## Scope

This is intentionally separate from the main transcript rendering patch.

This patch changes turn-start lifecycle only. It does **not** implement transcript suppression, historical replay filtering, or rendering changes.

Touched core surfaces:
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/{index.ts,runner.ts,types.ts}`
- `packages/coding-agent/src/core/index.ts`
- `packages/coding-agent/src/index.ts`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/test/agent-session-custom-message-turn.test.ts`

## Contract change

`before_agent_start` now describes the triggering source explicitly:
- `source: "user" | "customMessage"`
- `triggerMessage: AgentMessage`

The event still includes:
- `prompt`
- `images`
- `systemPrompt`

For custom-message turns, `prompt` is normalized from the triggering custom message content.

## Ordering guarantee restored

For an auto-checkpoint turn, the intended transcript order is now:
1. `custom:pi-self-checkpointing`
2. `custom:activity-block-turn`
3. assistant checkpoint response

That matches the same per-turn ownership rule used for normal turns.

## Apply guidance

Apply this patch **in addition to** the main activity-block transcript-mode patch. Do not replace the main patch with this one.

Recommended order:
1. apply `patches/pi-core-live-transcript-mode.patch`
2. apply `patches/pi-core-custom-message-turn-lifecycle.patch`

## Verification

From `~/research/pi-mono/packages/coding-agent`:

```bash
npx vitest --run \
  test/agent-session-custom-message-turn.test.ts \
  test/interactive-mode-live-transcript.test.ts \
  test/tool-execution-component.test.ts \
  test/interactive-mode-status.test.ts
npm run build
```

If you want runtime proof after installing the updated package:
- trigger auto-checkpointing
- confirm the auto-checkpoint turn now gets an activity block

## Notes

This is the right layer for the fix.

It avoids the bad alternative of teaching `activity-block` to special-case `pi-self-checkpointing` messages, which would couple two unrelated extensions and make turn ordering brittle again.
