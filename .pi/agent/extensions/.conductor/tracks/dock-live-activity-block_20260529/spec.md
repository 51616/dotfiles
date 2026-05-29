# Track Spec: Dock live activity block below Working spinner

Status: approved for implementation on 2026-05-29. Tan approved the design decisions listed in the Decision record section.

## Context

The `activity-block` extension in `~/.pi/agent/extensions/activity-block/` owns pi's bounded live activity summary. The current extension creates a custom transcript message of type `activity-block-turn` from the `before_turn_response` lifecycle event, renders it with `ActivityBlockMessageComponent`, and persists completed snapshots through `activity-block-state` entries.

The extension currently claims transcript ownership in block mode through local pi core seams:

- `ctx.ui.setLiveTranscriptMode({ toolRows, thinking, working })`
- `ctx.ui.setHistoricalTranscriptMode({ toolRows, thinking })`

Those seams are documented in `activity-block/README.md` and the saved patch artifacts under `activity-block/patches/`. They let the extension hide core live tool rows, historical tool rows, and thinking placeholders while leaving the stock `Working...` row visible.

The installed pi interactive layout renders these major containers in this order:

1. chat transcript
2. pending messages
3. status container, which contains the stock `Working...` loader while pi is streaming
4. `aboveEditor` extension widgets
5. editor / user text field
6. `belowEditor` extension widgets
7. footer

Because `ctx.ui.setWidget(key, component, { placement: "aboveEditor" })` renders between the stock `Working...` loader and the editor, the live activity-block can be docked in that location without replacing the editor or forking pi core. The existing `aboveEditor` widget container adds the normal one-line spacer before widgets.

## Goal

During active turns in activity-block mode, show the live activity-block directly below pi's stock `Working...` loader and directly above the user text field. The active block must not also appear as a visible transcript message while it is docked.

When the turn reaches a terminal state, keep the terminal activity-block docked until the next user input. The matching transcript block stays hidden while the terminal dock is retained, then becomes visible at its normal transcript position when the next input clears the dock so session history remains ordered as:

```text
user message
completed activity-block
assistant response / tool-result continuation transcript
```

The completed transcript block remains the canonical audit trail for completed, interrupted, aborted, and errored turns.

## Non-goals

- Do not replace or restyle the stock `Working...` loader.
- Do not patch pi core solely to change the standard spacer before `aboveEditor` widgets unless Tan explicitly rejects the spacer.
- Do not change activity summary content, tool row colors, thinking markdown rendering, token counting, or timer formatting except where docking requires lifecycle changes.
- Do not change the persisted `activity-block-state` schema unless implementation proves a new field is required.
- Do not remove or weaken `/activity-block mode default`, `/activity-block mode block`, or zen mode behavior.
- Do not migrate old session files. Existing sessions should continue to render with the current reconstruction rules.

## Requirements

### Live dock lifecycle

- In activity-block mode, starting a turn must create the normal `activity-block-turn` custom transcript message for durable ordering, but the renderer for the active turn must return no transcript rows while the live dock owns the active visual surface.
- The active turn must also install an `aboveEditor` widget under a stable extension key, for example `activity-block-live-dock`.
- The docked widget must render the same current snapshot as the hidden active transcript message, using `ActivityBlockMessageComponent` or a thin wrapper around it.
- Live dock updates must re-render when thinking, tool start/update/end, token count refreshes, responding state, queued-turn split, or terminal state changes.
- On terminal completion, abort, interruption, or error, the docked widget must stay visible with the terminal snapshot until the next idle user input clears it.
- On the next idle user input, session shutdown, or view-mode switch away from block mode, the docked widget must be cleared.
- After the retained terminal dock is cleared in block mode, the transcript renderer for that turn must become visible so the block remains in history.

### Transcript ownership

- While block mode is active, historical transcript suppression remains enabled so default tool rows and thinking placeholders do not reappear after the active block finalizes.
- Live transcript suppression remains enabled until the active block is finalized on `agent_end`, preserving current behavior across tool-result continuation turns.
- The docked live block must not introduce a second custom transcript message or use `pi.sendMessage()` during assistant streaming.
- The custom transcript message inserted from `before_turn_response` remains the durable placement anchor for the completed block.

### Terminal states

- Completed turns must keep a completed terminal snapshot in the dock until the next input, then clear the dock and leave a completed transcript block.
- Aborted turns must keep an aborted or interrupted terminal snapshot in the dock until the next input, then clear the dock and leave an aborted or interrupted transcript block.
- Error turns, including `agent_end` without `turn_end`, must keep an error terminal snapshot in the dock until the next input, then clear the dock and leave an error transcript block.
- Queued steering boundaries must freeze the previous block immediately, persist it as interrupted, clear or update the dock for the old turn, and then show the new active turn in the dock when its `before_turn_response` creates the next block.
- Empty or instant aborts must remain as historical aborted blocks for audit honesty.

### View modes and commands

- `/activity-block mode block` must enable transcript ownership and live docking for future active turns.
- `/activity-block mode default` must clear the live dock, clear transcript suppression, and hide activity-block transcript messages so pi core shows its default tool-call transcript.
- Zen mode must continue to hide activity-block surfaces while keeping the underlying state/persistence rules intact. Zen mode hides the docked live block and hides transcript activity-block messages while zen mode is enabled.
- Existing shortcuts for tool history view, thinking expansion, and zen mode must keep working.

### Layout and rendering

- The docked live block must render in the `aboveEditor` widget slot, below the stock `Working...` loader and above the editor.
- The docked block must stay width-safe for every line returned by `render(width)`.
- The docked block must be height-bounded and must reuse the existing 20-line maximum used by historical activity-block messages.
- The docked block should not steal focus from the editor.
- The docked block should not block typing unless pi itself is already handling input according to normal active-turn behavior.

### Persistence and resume

- Completed, interrupted, aborted, and errored snapshots must still be persisted through the existing `activity-block-state` path.
- `/resume` reconstruction from `activity-block-turn` messages, assistant tool calls, and tool results must keep working.
- Resumed sessions should show historical blocks in the transcript. They should not recreate stale live dock widgets.

### Compatibility and failure behavior

- If `ctx.ui.setWidget` is unavailable, the extension should fail clearly during development or document reduced behavior. Silent fallback to duplicate transcript-plus-dock behavior is not acceptable.
- If local pi core transcript-mode seams are unavailable, the extension's existing reduced behavior warning remains relevant; docking does not remove that dependency.

## Acceptance criteria

- A normal active turn in block mode shows one visible live activity-block below `Working...` and above the editor, with no duplicate visible active block in the transcript.
- When a normal turn finishes, the completed terminal block remains docked and the transcript duplicate stays hidden until the next input clears the dock.
- When a turn is aborted after meaningful activity, the aborted/interrupted terminal block remains docked and the transcript duplicate stays hidden until the next input clears the dock.
- When a turn is aborted before the first assistant/tool update, behavior follows the approved empty-abort policy and is covered by a test or explicit manual verification.
- When a bare `agent_end` error occurs without `turn_end`, the error terminal block remains docked until the next input clears the dock.
- Queued steering preserves current boundary behavior: the old block is finalized as interrupted, the next block receives a new turn identity, and the dock shows only the current active turn.
- `/activity-block mode default` clears the dock and restores default pi transcript rendering without restarting the session.
- `/activity-block mode block` re-enables live docking for later turns without erasing state already captured while default mode was active.
- Zen mode hides the dock according to the approved zen policy and does not lose persisted state.
- Docket widget rendering remains width-safe and bounded on narrow terminal widths.
- Targeted activity-block tests pass.

## Expected behaviors

- **Active reasoning-only turn:** The stock `Working...` row remains visible. The activity-block appears under it and shows the latest thinking header/status. The transcript does not show a second live block for the same turn.
- **Active tool turn:** Tool start/update/end events update the docked block. Tool rows remain suppressed in the core transcript while block mode owns the surface.
- **Final answer streaming:** The docked block follows existing activity-block behavior: it stops its own spinner when the assistant response is streaming and shows `Responding` statically.
- **Normal completion:** The terminal completed block remains docked after the active turn finalizes. The final block becomes visible in transcript history after the next input clears the dock.
- **Abort/interruption:** The terminal label freezes, elapsed time freezes, and the aborted/interrupted block remains docked until the next input clears the dock and reveals the transcript history block.
- **Queued steering:** The old block stops being live and becomes historical before the steering turn's block is created. The dock never shows two blocks.
- **Session resume:** Historical blocks render from persisted or reconstructed state. No live dock appears until a new active turn starts.
- **Default transcript view:** Activity-block surfaces clear and pi's default transcript rendering is visible.
- **Zen mode:** Activity-block visual surfaces hide while state continues to update/persist according to the approved policy.

## Scenario examples

### Scenario: normal turn with no tools

A user submits a simple prompt. Pi starts working. The UI shows `Working...`, then one docked activity-block, then the editor. The transcript anchor for `activity-block-turn` exists but renders no visible rows while active. When pi finishes, the completed terminal block remains docked. On the next input, the dock disappears and the completed activity-block is visible below the user message.

### Scenario: active turn with tool calls

A user asks pi to inspect files. Pi starts a `read` or `bash` tool. The docked block updates with tool counts and latest tool summary. Core live tool rows remain suppressed. When the run finishes, the final block remains docked until the next input clears the dock and reveals the transcript history block.

### Scenario: abort after activity

A user presses the normal interrupt key after the block has received thinking or tool activity. The active run terminates. The terminal dock remains visible with the approved abort copy, frozen timer, and counts. On the next input, the dock clears and the transcript shows the same terminal activity-block.

### Scenario: abort before first update

A user interrupts immediately after the turn starts. A minimal aborted block remains docked until the next input, then remains in transcript history. The dock never remains stale after that next input.

### Scenario: queued steering while a turn is active

A user submits steering input while pi is already working. When the steering user message starts processing, the old docked block finalizes as interrupted. The next turn receives a fresh activity-block identity and becomes the only docked block after its `before_turn_response` event.

### Scenario: default view mode

A user runs `/activity-block mode default`. The activity-block dock is cleared. Activity-block transcript messages hide. Live/historical transcript suppression is cleared so pi core renders its normal tool rows and thinking behavior.

### Scenario: zen mode during active turn

A user enables zen mode. Activity-block visual surfaces hide according to the approved zen policy. The stock `Working...` row remains visible. State continues to persist so disabling zen can show the latest/historical block state without data loss.

### Scenario: narrow terminal

The terminal width is narrow enough to force compact rendering. The docked block returns no line wider than the render width, remains bounded, and does not crash the TUI.

## Evidence plan (scenario → proof)

- Normal turn with no tools:
  - Add/update `test/activity-block-index.test.mjs` to assert `ctx.ui.setWidget` receives an `aboveEditor` live dock while active, active transcript renderer returns no rows, the terminal block remains docked after `agent_end`, and `setWidget(key, undefined)` clears the dock on the next input.
- Active turn with tool calls:
  - Add/update `test/activity-block-index.test.mjs` to drive thinking plus tool start/update/end events and assert the dock renders those updates while live transcript suppression stays active.
  - Existing widget tests continue to prove activity summary rendering.
- Abort after activity:
  - Add/update `test/activity-block-index.test.mjs` or state tests to assert terminal aborted/interrupted state remains docked after `agent_end` and dock cleanup occurs on next input.
- Abort before first update:
  - Add a focused test proving the approved minimal aborted block policy, or cover it through the same terminal abort path if no distinct lifecycle is needed.
- Queued steering:
  - Extend the existing queued steering test in `test/activity-block-index.test.mjs` to assert old dock cleanup/update and one current dock after the new turn starts.
- Default view mode:
  - Extend `test/activity-block-view-mode.test.mjs` or `test/activity-block-index.test.mjs` to assert mode default clears the dock and transcript modes.
- Zen mode:
  - Extend zen coverage in `test/activity-block-index.test.mjs` to assert the dock visibility policy.
- Narrow terminal:
  - Reuse/extend `test/activity-block-widget.test.mjs` for width safety. If a live-dock-specific height cap is added, add a dock-specific render test.
- Lattice sync:
  - Update `.lat-md/activity-block.md` and `.lat-md/tests.md` after implementation to describe live docking and new proving tests.

## Constraints / assumptions

- The implementation target is `~/.pi/agent/extensions/activity-block/`.
- The live pi runtime exposes `ctx.ui.setWidget` and the transcript-mode seams currently used by activity-block.
- The docked activity-block can be implemented extension-side using the existing `aboveEditor` widget placement.
- The stock one-line spacer before `aboveEditor` widgets is acceptable unless Tan explicitly chooses a tighter core layout change.
- Every aborted block is retained as transcript history, including instant aborts.
- The live dock reuses the existing 20-line activity-block cap.

## Risks

- **Duplicate UI risk:** If the active transcript renderer is not hidden while the dock is visible, users will see the same activity-block twice.
- **Stale widget risk:** If dock cleanup misses abort, error, queued steering, session switch, or shutdown, an old block can remain above the editor after the run ends.
- **Transcript rebuild risk:** Clearing historical transcript suppression at the wrong time can make default tool rows reappear after a completed turn.
- **Height risk:** The existing 20-line block may consume too much terminal space when docked above the editor.
- **Spacer risk:** The default `aboveEditor` spacer may make the dock feel less tightly attached to `Working...` than Tan expects.
- **Mode interaction risk:** Zen/default mode interactions can accidentally hide state permanently or restore duplicate surfaces if not tested explicitly.

## Decision record

Resolved on 2026-05-29 before implementation:

- Live dock height stays the same as the historical activity-block height: 20 rendered lines maximum.
- The standard one-line gap between `Working...` and `aboveEditor` widgets is acceptable.
- Aborts before the first thinking/tool/assistant update still leave a minimal aborted transcript block.
- User abort terminal copy should say `Aborted`; queued steering interruptions keep `Interrupted by steering`.
- Terminal blocks stay docked after completion/abort/error until the next user input, then the dock clears and the transcript block becomes visible.
- Zen mode hides both live dock and historical activity-block transcript surfaces while enabled.
- `/activity-block mode default` clears/restores behavior when the command is processed.

## Additional implementation assumptions

- The live install exposes `ctx.ui.setWidget`; unit tests may omit that method to exercise the extension's pre-dock transcript-rendering path. When `setWidget` is absent, the extension deliberately leaves transcript blocks visible instead of hiding them, producing a documented reduced transcript-only mode rather than an invisible block.
- Keeping the terminal block docked until next input means the matching transcript block remains hidden during that retained-dock period to avoid duplicate UI.
- If an automated follow-up starts without a normal idle user input, the new active turn replaces the retained terminal dock and the previous block becomes visible in transcript history.
