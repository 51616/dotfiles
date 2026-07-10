# activity-block pi-core patches (pi-mono v0.80.6)

Target upstream tag:
- `earendil-works/pi-mono` `v0.80.6` (`2b3fda9921b5590f285165287bd442a25817f17b`)

Patch files:
- `pi-core-local-extension-seams.patch`
  - ports the v0.78.0 local extension seam stack to pi-mono v0.80.6
  - adds extension UI seams for suppressing live and historical transcript elements:
    - `ctx.ui.setLiveTranscriptMode(...)`
    - `ctx.ui.setHistoricalTranscriptMode(...)`
  - guards live tool-call draft rendering, `tool_execution_start`, and historical tool rows when `toolRows: "hide"` is active
  - preserves the normal `before_agent_start` lifecycle for `sendCustomMessage(..., { triggerTurn: true })`
  - extends `before_agent_start` events with:
    - `source: "user" | "customMessage"`
    - `triggerMessage: AgentMessage`
  - adds `before_turn_response` before each assistant response turn and preserves `triggerMessages` for initial, queued steering, tool-result continuation, and custom-message turns
  - adapts the transcript-mode working-row suppression to v0.80.6's `StatusIndicator` surface instead of the older `loadingAnimation` field
  - preserves v0.80.6's system-prompt override tracking and untyped custom-message content normalization

Recommended apply:

```bash
cd ~/research/pi-mono
git checkout v0.80.6
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.80.6/pi-core-local-extension-seams.patch
```

Operational shortcut:

```bash
PI_CORE_PATCH_VERSION=0.80.6 bash ~/vault/.pi/scripts/pi/reapply-local-patches.sh
```

The shortcut installs the patched `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent` tarballs globally and refreshes the extension workspace's local runtime packages from the same patched tarballs so regression tests can exercise the patched runtime surface.
