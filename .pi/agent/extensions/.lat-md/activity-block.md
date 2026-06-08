# Activity block

Owns the bounded activity block that renders live work as a docked `aboveEditor` widget below the stock `Working...` row, then preserves terminal blocks as transcript history between each user turn and its assistant response.

Entrypoint: [[activity-block/index.ts]].

## Responsibilities

These are the behaviors the extension must keep stable when the live summary UX changes.

- reduce live assistant/tool events into one current summary surface, keep `Cooking` as the fallback running label when no thinking header is available, and use the latest thinking header as the bottom-left footer label whenever the block is still thinking, including during tool-active phases
- keep tool history in three block-local views that cycle `latest -> recent (5 latest) -> all` on every toggle, even when the turn has few or zero tool calls; pad undersized tool-history views with neutral grey placeholder rows so the chosen size stays visible, keep rows newest-first, show a dim inline per-tool elapsed timer suffix on each tool row, and keep the full-history panel tool-only by hiding the separate thinking panel unless the dedicated thinking toggle is explicitly expanded
- keep thinking text behind the dedicated block-local toggle instead of auto-expanding it alongside the tool history; thoughts stay in their own bounded thinking area rather than being mixed into the tool timeline, and the full tool-history view should not inject a fallback `No recent tool details` row when there are no tool rows to show
- stop spinner animation once the final assistant response is streaming; `Responding` stays static while other live running-state labels animate suffix dots from 0 to 3
- render block content with white as the default text color while preserving pink borders, compact-tool-view-style tool colors for `read`/`write`/`edit`/`bash`, and readable search rows for `fffind`/`ffgrep`
- keep the footer/detail line bottom-aligned even in expanded tool view, with a spacer row after the expanded tool list: the latest status/thinking header sits bottom-left, while lowercase tool-call count text with inline failure suffixes (`X tool calls (Y failed)`), a block-scoped token-count bucket from usage/context estimates (subtract the context baseline captured when the block starts), and the elapsed timer are grouped on the bottom-right
- render thinking excerpts as markdown instead of plain text, using the latest thinking header as the bottom-left footer label during reasoning-only phases, avoiding duplicate live thinking headers in compact mode, and showing the full current thinking text above the tool-call history list in the thinking-expanded view
- support block-local `ctrl+alt+t` expansion for the currently shown thinking excerpt only, without expanding hidden historical transcript rows or stealing the built-in global toggles
- let `Esc` abort the active turn without interfering when no turn is active
- keep the rendered block width-safe and height-bounded to 20 total lines so narrow terminals do not crash rendering or let the block sprawl
- keep a stable local per-session turn identity in message details/state so repeated similar turns stay distinguishable without showing a visible `Turn #X` line inside the block
- own the block-local tool-history view toggle (`latest -> recent -> all`), including command/shortcut affordances and line budgeting
- support a global zen mode from `/activity-block zen [on|off]` or `ctrl+alt+z` that hides activity blocks entirely while the mode is enabled so the stock pi working spinner stays visible during the run; activating it should toast a message that includes `Zen mode`
- support a runtime transcript view mode from `/activity-block mode block|default`; `block` claims live and historical transcript ownership, while `default` clears transcript suppression and hides activity-block messages so pi core renders its normal tool-call transcript without restarting the session
- request the Phase 2 transcript-mode seams when available so inline tool rows, replayed tool rows, the separate working spinner row, and thinking placeholders are absorbed into the block
- install the live block as the `activity-block-live-dock` `aboveEditor` widget while a turn is active when `ctx.ui.setWidget` is available, hide the matching active transcript message to prevent duplicate UI, and clear the dock immediately on completion/abort/error so the transcript block becomes visible as history; contexts without `setWidget` stay in documented transcript-only mode rather than hiding the block
- treat `agent_end` without matching `tool_execution_end` or terminal tool-result events as a terminal failure for still-running tool rows, so websocket/provider errors do not leave command timers counting forever
- keep historical transcript suppression active across completed turns so the block remains the canonical transcript surface after the assistant finishes
- reconstruct historical activity-block snapshots from resumed session transcript entries when the saved `activity-block-state` entry is missing or has stale empty tool rows, so `/resume` can still show prior tool calls inside the block
- keep the saved core patch notes in `activity-block/README.md` and `activity-block/patches/` aligned with the extension’s real dependency on pi core changes

## Invariants

These constraints keep the block honest and prevent it from becoming another noisy transcript.

- each triggered turn, including queued steering/follow-up/custom-message turns, keeps its own completed block attached below the triggering message and above the assistant response; while the same turn is visible in the live dock, the transcript renderer for that turn must return no rows so the user never sees duplicate activity blocks; after the initial trigger user message has been consumed, a later queued steering user `message_start` while a block is active must freeze the current block immediately and prime the next block under that steering message before the next `before_turn_response` inserts its transcript anchor
- tool-result continuation subturns keep using the same active block; the extension only starts a fresh block for a new user-triggered turn boundary, and a queued steering user message should cut that boundary as soon as its transcript message appears
- queued steering user turns are primed as soon as their later user transcript message appears, while the initial trigger user message for the current block is ignored once so normal prompts do not self-split; the custom activity-block transcript message is then attached on the following `before_turn_response`, and empty-trigger continuation turns still reuse the current block
- historical transcript suppression stays enabled for the session, live transcript suppression stays enabled until the current active block is finalized on `agent_end`, and the terminal dock clears as soon as the active block reaches a terminal state
- `agent_end` still finalizes the active block when a run fails before `turn_end` is emitted, marks any still-running tools as failed with `completedAt = endedAt`, and completion/abort/error paths clear the dock immediately so the transcript snapshot becomes visible
- each block retains a stable local per-session turn identity, even though the rendered block no longer shows a visible `Turn #<id>` header line
- resumed sessions continue the persisted turn counter instead of resetting to `Turn #1`
- the block elapsed timer freezes at `endedAt` once a run completes or aborts and formats from `0s` without sub-second precision; every tool row shows its own inline elapsed timer suffix from `startedAt`, including successful and failed historical tool rows, freezes at `completedAt`, and stays hidden until it reaches at least `10s`
- the block keeps current and previous activity summaries in state so live prioritization and future UI changes can reason about recent transitions without rebuilding transcript history
- the reducer persists enough rich data for the latest visible thinking item to support block-local expansion after the turn finishes
- while a turn is active, the block refreshes token counts from `ctx.getContextUsage()` on a short interval and subtracts the block-start baseline so the displayed token bucket reflects the current block instead of the whole session
- live spinner frames stop once assistant `text_*` streaming begins
- `Esc` is consumed only while this extension has an active turn to abort, and even instant aborted turns keep a minimal terminal block for audit history
- tool counts stay honest for sequential and parallel tool execution
- even in expanded mode, the block stays bounded and shows excerpts rather than a full transcript
- if the core transcript-mode seams are unavailable, the block still works as a Phase 1 summary surface but replayed history falls back to default pi rendering
- default transcript view mode intentionally clears historical transcript suppression; switching back to block mode reapplies suppression for future rendering but does not erase core-rendered rows already shown while default mode was active

## Change guidance

Use this map to avoid fixing only the rendered block text while leaving the event contract or suppression path stale.

- Change the reducer/summary logic in `activity-block/lib/activity-block-state.ts` when counts, failure suffixes, tool prioritization, recent thinking excerpts, tool preview payloads, or frozen terminal timing are wrong.
- Change line budgeting, compact/expanded allocation, truncation, markdown rendering, spacing, per-state colors, or tool-history-only rendering in `activity-block/lib/activity-block-widget.ts` when narrow terminals overflow, the block grows too tall, thinking expansion shows the wrong payload, row spacing regresses, or thoughts leak back into the tool list.
- Change `activity-block/index.ts` when the toggle command/shortcut wiring, periodic context-usage refresh, block-spawn timing, live-dock install/clear timing, active transcript hiding, terminal dock clear behavior, zen-mode hiding/toast behavior, run-lifecycle behavior, or `Esc` abort handling is wrong.
- Change `activity-block/lib/activity-block-history.ts` when `/resume` fails to recover tool rows from historical assistant `toolCall` messages and matching `toolResult` messages, or when persisted snapshots need merge/backfill behavior.
- If tool rows suddenly reappear when the assistant finishes, inspect `activity-block/index.ts` turn-finish cleanup first; clearing historical transcript mode on `agent_end` triggers an interactive-mode transcript rebuild.
- If the block stops suppressing live or replayed tool rows, or stops collapsing thinking, inspect the canonical pi core seams in `~/research/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts`.

## Verification

These checks prove the reducer, transcript block line budgeting, lattice wiring, and extension loading path still agree.

- `.pi/extensions/test/activity-block-state.test.mjs`
- `.pi/extensions/test/activity-block-widget.test.mjs`
- `.pi/extensions/test/activity-block-index.test.mjs` proves `Esc` abort handling, `before_turn_response`-driven per-turn block creation for user/custom/queued turns, live dock installation in the `aboveEditor` slot, active transcript duplicate hiding while the dock is visible, immediate terminal dock clearing for complete/aborted/error turns, queued-steering dock replacement, default-mode dock clearing, zen-mode dock hiding/restoration, one-block behavior across tool-result continuation boundaries until `agent_end`, active-block finalization on bare `agent_end` failures, dangling running-tool failure on terminal `agent_end`, resume-safe turn numbering, and that historical transcript suppression stays active after completion
- `.pi/extensions/test/activity-block-state.test.mjs`, `.pi/extensions/test/activity-block-widget.test.mjs`, `.pi/extensions/test/activity-block-view-mode.test.mjs`, `.pi/extensions/test/activity-block-thinking-visibility.test.mjs`, and `.pi/extensions/test/activity-block-index.test.mjs` also prove current/previous activity tracking, markdown-aware thinking rendering, single-block live thinking display, cycling tool-history views (`latest`, `recent`, `all`) with newest-first ordering, placeholder padding for undersized history views, and compact-tool-view-style tool-row background highlighting, block-local thinking expansion, full-history staying tool-only, block-scoped token counting from context baselines, block timers from `0s` without sub-second precision, per-tool timers for running/success/error rows once they reach `10s`, 20-line bounded layouts, row spacing, and width-safe layouts
- `node --test .pi/extensions/test/activity-block-view-mode.test.mjs .pi/extensions/test/activity-block-thinking-visibility.test.mjs`
