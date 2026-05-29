# activity-block pi-core patches (pi-mono v0.77.0)

Target upstream tag:
- `earendil-works/pi-mono` `v0.77.0` (`8322745e`)

Patch files:
- `pi-core-local-extension-seams.patch`
  - is a zero-context, version-pinned diff; apply it with `git apply --unidiff-zero` or the vault helper script
  - adds extension UI seams for suppressing live and historical transcript elements:
    - `ctx.ui.setLiveTranscriptMode(...)`
    - `ctx.ui.setHistoricalTranscriptMode(...)`
  - preserves the normal `before_agent_start` lifecycle for `sendCustomMessage(..., { triggerTurn: true })`
  - extends `before_agent_start` events with:
    - `source: "user" | "customMessage"`
    - `triggerMessage: AgentMessage`
  - adds `before_turn_response` before each assistant response turn and preserves `triggerMessages` for initial, queued steering, tool-result continuation, and custom-message turns
  - preserves the built-in compaction loader on `agent_end` while compaction is already active, so the normal streaming loader teardown does not clear the compaction status row

Recommended apply:

```bash
cd ~/research/pi-mono
git checkout v0.77.0
git apply --unidiff-zero /home/tan/.pi/agent/extensions/activity-block/patches/v0.77.0/pi-core-local-extension-seams.patch
```

Verification used when this stack was created:

```bash
cd /tmp/pi-work/pi-mono-v0770-port
npm ci
npm -w packages/tui run build
npm -w packages/ai run build
npm -w packages/agent run build
npm -w packages/coding-agent run build
```

Operational shortcut:

```bash
PI_CORE_PATCH_VERSION=0.77.0 bash ~/vault/.pi/scripts/pi/reapply-local-patches.sh
```

The shortcut installs the patched `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent` tarballs globally and refreshes the extension workspace's local runtime packages from the same patched tarballs so regression tests can exercise the patched runtime surface.
