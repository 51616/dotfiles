# activity-block pi-core patches (pi-mono v0.67.2)

Target upstream tag:
- `pi-mono` `v0.67.2` (`5a3e70238958b13092124a25abe9ae72235eb8ac`)

Patch files:
- `pi-core-live-transcript-mode.patch`
  - adds extension UI seams for suppressing live + historical transcript elements
  - updates interactive mode + assistant message component to respect those modes
- `pi-core-custom-message-turn-lifecycle.patch`
  - ensures `sendCustomMessage(..., { triggerTurn: true })` runs `before_agent_start` like normal prompts
  - extends `before_agent_start` event with:
    - `source: "user" | "customMessage"`
    - `triggerMessage: AgentMessage`
- `pi-core-before-turn-response-lifecycle.patch`
  - adds a low-level pre-response turn hook in `packages/agent`
  - wires that into `packages/coding-agent` as extension event `before_turn_response`
  - preserves `triggerMessages` for initial turns, queued steering turns, tool-result continuations, and triggerTurn custom-message turns

The transcript-mode and custom-message patches are unchanged from the saved `v0.66.1` stack. The `before_turn_response` patch was rebased for `v0.67.2` so it applies cleanly after those first two patches.

Recommended apply order:

```bash
cd ~/research/pi-mono
git checkout v0.67.2

git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-live-transcript-mode.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-custom-message-turn-lifecycle.patch
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.67.2/pi-core-before-turn-response-lifecycle.patch
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
```
