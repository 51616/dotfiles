# Activity block

Owns the bounded activity block. It shows live work in an above-editor dock while pi works, then leaves one block per prompt (or steering/follow-up message) in the transcript, on stock pi 1.3.0.

Entrypoint: [[activity-block/index.ts]]. Lifecycle rules: [[activity-block/lib/activity-block-controller.ts]].

## Transcript ownership on pi 1.3

Only public extension API is used; there is no pi core patch. Each surface has one owner.

- Tool rows: [[activity-block/lib/activity-block-tool-rows.ts]] registers a `pi.registerToolRenderer` resolver. In block mode it returns `renderShell: "self"` with empty components, so pi draws zero lines for every tool row, live and on resume. pi picks renderers when a row is created, so a mode switch only affects new rows until the chat is rebuilt.
- Working row: `ctx.ui.setWorkingVisible(false)` in block mode. pi resets it in `resetExtensionUI`, so it is reapplied on every `session_start`.
- Dock: one `aboveEditor` widget installed on `session_start`. It renders nothing when idle and keeps the `TUI` handle used for `requestRender()`.
- Thinking: not hidden. pi's `hideThinkingBlock` setting owns it. Hiding it would leave blank spacer lines that no 1.3.0 extension hook can remove.
- Transcript anchor: a `custom` entry `activity-block-turn` written with `pi.appendEntry` and drawn by `pi.registerEntryRenderer`. It is never sent to the model.

## Run lifecycle

The block follows pi 1.3.0's agent-session events. One user prompt can span several `agent_start`/`agent_end` pairs, so only `agent_settled` is final.

- `agent_start` creates the active block. It is idempotent: retries and compaction continuations reuse the block.
- The first assistant `message_start` of a block writes its anchor. Extension handlers run before pi's UI sees that event, and pi inserts custom entries above a streaming assistant component, so the anchor lands below the trigger message and above the reply.
- A user or displayed custom `message_start` while the block is anchored splits it. The block's last `turn_end` decides the label: `toolUse` means a steer cut the work short (`Interrupted by steering`), anything else means a follow-up after finished work (`Completed`). The run's own trigger never splits, because the block is not yet anchored at that point.
- `turn_end` and `agent_end` are recorded. `agent_settled` finalizes the block and writes the `activity-block-state` snapshot.
- A block that never got an anchor (failure before any assistant message) is dropped instead of persisted.

## Invariants

These constraints keep the block honest and prevent it from becoming another noisy transcript.

- Exactly one surface shows a block at a time: the dock while it runs, the transcript anchor afterwards. While docked, the anchor's renderer returns no rows.
- The tool counts of a block cover only tools that the block itself started. `agent_end.messages` spans the whole agent run, so settling must ignore tool results from blocks that were frozen before a steer.
- Token counts are scoped to the block. The baseline is the context usage at block start, or the first non-zero usage when pi reports none yet (fresh session, or right after compaction). Zero-usage streaming partials never become a baseline.
- Nested codemode tool calls (`parentToolCallId`) are not block tool rows.
- Leaving block mode finalizes a running block (`Switched to default view`) instead of dropping it.
- Sessions written by the pre-1.3.0 patched runtime stored anchors as displayed `custom_message` entries. They render through `registerMessageRenderer`, and the `context` hook filters them out of model requests.
- The rendered block stays width-safe and at most 20 lines tall.

## Change guidance

Use this map to change the right layer.

- Lifecycle, splits, timers, dock visibility, mode switches: [[activity-block/lib/activity-block-controller.ts]].
- Counts, failure labels, thinking excerpts, tool previews, token scoping: [[activity-block/lib/activity-block-state.ts]].
- Layout, truncation, colors, spinner: [[activity-block/lib/activity-block-widget.ts]].
- Resume reconstruction and anchor parsing: [[activity-block/lib/activity-block-history.ts]].
- When pi is upgraded, bump the pinned runtime in the workspace `package.json`. Then run the typecheck test and the harness tests, because pi loads extensions with jiti, which strips types without checking them.

## Verification

These checks prove the lifecycle, reducer, and widget still agree with pi 1.3.0.

- [[tests#Activity block reducer and widget stay honest, bounded, and width-safe]]
- `node --test test/activity-block-*.test.mjs activity-block/test/*.test.mjs`. `test/helpers/activity-block-harness.mjs` replays pi 1.3.0's event order.
- `activity-block/test/typecheck.test.mjs` runs `tsc` against the pinned pi types.
