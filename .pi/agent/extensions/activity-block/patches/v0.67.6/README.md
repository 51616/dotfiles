# activity-block pi-core patches (pi-mono v0.67.6)

Target upstream tag:
- `pi-mono` `v0.67.6` (`2a356dca4d949a28d0ede1b9586fadc948bf7f85`)

Patch files:
- `pi-core-live-transcript-mode.patch`
  - adds extension UI seams for suppressing live + historical transcript elements
  - updates interactive mode + assistant message component to respect those modes
  - rebases the assistant-message constructor change needed by `test/streaming-render-debug.ts`
- `pi-core-custom-message-turn-lifecycle.patch`
  - ensures `sendCustomMessage(..., { triggerTurn: true })` runs `before_agent_start` like normal prompts
  - extends `before_agent_start` event with:
    - `source: "user" | "customMessage"`
    - `triggerMessage: AgentMessage`
- `pi-core-before-turn-response-lifecycle.patch`
  - adds a low-level pre-response turn hook in `packages/agent`
  - wires that into `packages/coding-agent` as extension event `before_turn_response`
  - preserves `triggerMessages` for initial turns, queued steering turns, tool-result continuations, and triggerTurn custom-message turns

The `v0.67.6` stack is the current default for the live install. It was regenerated from the local `pi-mono` rebase branch used to repair the custom extension hooks on top of upstream `v0.67.6`, then split back into the canonical three patch artifacts so future reinstalls can reapply them cleanly.

Recommended apply order:

```bash
cd ~/research/pi-mono
git checkout v0.67.6

git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-live-transcript-mode.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-custom-message-turn-lifecycle.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.6/pi-core-before-turn-response-lifecycle.patch
```

Verification (from the upstream repo after applying):

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

Notes:
- these three patch files were verified to apply cleanly in order on a fresh `v0.67.6` checkout
- this saved stack is narrower than the older `v0.67.2` artifact set: it only includes the code and tests still needed to carry the custom seams on current upstream
- `/reload` is not enough after reinstalling patched core; start a fresh pi process
