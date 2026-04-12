# pi core patch note (v0.65.2): custom-message triggerTurn lifecycle

Patch file:
- `patches/v0.65.2/pi-core-custom-message-turn-lifecycle.patch`

Target upstream tag:
- `pi-mono` `v0.65.2` (`573eb91c78c91c2f12b4bdb2ab94ae4ddbd35f6b`)

## Why this patch exists

`before_agent_start` runs for normal user-triggered turns (`AgentSession.prompt(...)`).

But in upstream v0.65.2:
- `AgentSession.sendCustomMessage(..., { triggerTurn: true })` called `agent.prompt(appMessage)` directly
- that bypassed `ExtensionRunner.emitBeforeAgentStart(...)`

So extension-triggered turns could skip per-turn extension behavior.

For `activity-block`, this matters because (some versions of) the extension relies on `before_agent_start` to set up the per-turn transcript ownership/insertion, and custom-message turns are used by other extensions (e.g. auto-checkpointing) to trigger turns.

## What this patch changes

1) It extends the `before_agent_start` event contract with:
- `source: "user" | "customMessage"`
- `triggerMessage: AgentMessage`

2) It updates `AgentSession.sendCustomMessage(..., { triggerTurn: true })` to:
- normalize the triggering custom message content into `(text, images)`
- call `emitBeforeAgentStart(text, images, baseSystemPrompt, { source: "customMessage", triggerMessage })`
- apply any extension systemPrompt modifications consistently
- append any extension-injected messages to the turn
- then start the turn via `agent.prompt(messages)`

This restores the invariant: **every turn-triggering message path runs `before_agent_start`.**

## Files touched (v0.65.2)

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/test/suite/agent-session-model-extension.test.ts`

## Verification

From `~/research/pi-mono/packages/coding-agent` (after applying both v0.65.2 patches):

```bash
npx vitest --run \
  test/suite/agent-session-model-extension.test.ts \
  test/interactive-mode-transcript-modes.test.ts
npm run build
```
