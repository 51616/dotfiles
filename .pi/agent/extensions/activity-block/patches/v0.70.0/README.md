# activity-block pi-core patches (pi-mono v0.70.0)

Target upstream tag:
- `pi-mono` `v0.70.0` (`612be54c`)

Patch files:
- `pi-core-local-extension-seams.patch`
  - adds extension UI seams for suppressing live + historical transcript elements:
    - `ctx.ui.setLiveTranscriptMode(...)`
    - `ctx.ui.setHistoricalTranscriptMode(...)`
  - preserves the normal `before_agent_start` lifecycle for `sendCustomMessage(..., { triggerTurn: true })`
  - extends `before_agent_start` events with:
    - `source: "user" | "customMessage"`
    - `triggerMessage: AgentMessage`
  - adds `before_turn_response` before each assistant response turn and preserves `triggerMessages` for initial, queued steering, tool-result continuation, and custom-message turns
  - preserves the built-in compaction loader on `agent_end` while compaction is already active, so the normal streaming loader teardown does not clear the compaction status row

This version is stored as a combined patch because the v0.68-v0.70 upstream changes touched the same extension type and runner files for TypeBox 1.x, autocomplete stacking, working indicators, and session replacement. Keeping the v0.70.0 rebase as one patch avoids artificial conflicts between local seam patches.

Recommended apply:

```bash
cd ~/research/pi-mono
git checkout v0.70.0
git apply /home/tan/.pi/agent/extensions/activity-block/patches/v0.70.0/pi-core-local-extension-seams.patch
```

Verification used when this stack was created:

```bash
cd /tmp/pi-work/pi-mono-v070-clean
npm ci
npm -w packages/tui run build
npm -w packages/ai run build
npm -w packages/agent run build
npm -w packages/coding-agent run build
```

Operational shortcut:

```bash
PI_CORE_PATCH_VERSION=0.70.0 bash ~/vault/.pi/scripts/pi/reapply-local-patches.sh
```

The shortcut installs the patched tarballs globally and refreshes the extension workspace's local `node_modules/@mariozechner/*` copies from the same tarballs so regression tests exercise the patched runtime surface.
