# activity-block on pi 1.3.0 public extension API — progress log

Started 2026-10-20. Owner: pi. Status: in progress.

## Goal

Rebuild `~/.pi/agent/extensions/activity-block` so it works on stock pi `@earendil-works/pi-coding-agent@1.3.0`
without the custom pi-core patch stack (`activity-block/patches/v*`) that only existed up to pi v0.80.6.

Agreed scope (chat with Tan, 2026-10-20):
- Thinking stays visible in the transcript (pi's own `hideThinkingBlock` setting decides collapsed/expanded).
  The block keeps its own in-block thinking panel. ("option 3")
- Mid-run steering/follow-up messages split the block without aborting the agent ("option 1").
- Keep a renderer for legacy `custom_message` anchors so old sessions still show their blocks.
- Remove patch artifacts, the patch-contract test, and the core-rebuild step of
  `~/vault/.pi/scripts/pi/reapply-local-patches.sh` (that step would downgrade pi to 0.80.6).

## Findings (verified by reading pi 1.3.0 dist source)

- Installed pi: `@earendil-works/pi-coding-agent@1.3.0` (installed 2026-10-20 12:53 +0900).
  The patched seams `setLiveTranscriptMode`, `setHistoricalTranscriptMode`, `before_turn_response` do not exist.
  Unknown `pi.on(...)` event names are accepted silently, so the old extension loaded but never created a block.
  Evidence: session started 04:11Z on 1.3.0 has 0 `activity-block-*` entries; the 02:02Z session (patched 0.80.6) has 220.
- The extension test workspace (`~/.pi/agent/extensions/node_modules`) contains patched `@earendil-works/*@0.80.6`
  and `@mariozechner/*@0.70.0`. Tests therefore never exercised the live 1.3.0 runtime.
- `goal/index.ts` also registers the patched `before_turn_response` event (line ~1099). Out of scope here; reported to Tan.
- Steering in 1.3.0 never aborts: queued messages are injected inside the same agent loop after the current
  assistant turn and its tools finish (`pi-agent-core/dist/agent-loop.js` `runLoop`).
- One user prompt can produce several `agent_start`/`agent_end` pairs (retry, auto-compaction continuation,
  `agent_before_settle` continuation, queued follow-ups). `agent_settled` is the only "fully done" signal.
- `pi.appendEntry()` custom entries are drawn immediately via `entry_appended` and inserted above the streaming
  assistant component when one exists (`interactive-mode.js` `addCustomEntryToChat`). They are not sent to the model.
- Custom messages flushed at `turn_end` (`_appendCustomMessage`) are emitted only to UI listeners, not to extensions.
  So any custom `message_start` an extension sees mid-run is a steered/follow-up trigger.
- `ToolExecutionComponent` with `renderShell: "self"` and empty call/result components renders `[]` (no spacer).
  Image blocks in tool results are still drawn.
- HTML export: empty renderers produce empty HTML, which the export template treats as "not rendered" and falls back
  to its default tool view.

- Test-runtime switch to 1.3.0 (scratch copy at `~/tmp/pi-work/ext13`, deps aliased
  `@mariozechner/pi-coding-agent -> npm:@earendil-works/pi-coding-agent@1.3.0`): 550 tests, 6 fail.
  Pre-existing on the old runtime too: `goal contributes through tui-broker` (stub lacks `modelRegistry.hasConfiguredAuth`),
  `agent package cache @ff-labs/pi-fff ...` (pi-fff imports `@earendil-works/pi-tui`, not resolvable from the agent npm cache).
  New with 1.3.0 (all test-harness coupling to pi internals, not product bugs):
  - `test/command-palette.test.mjs`: pi-tui 1.3.0 no longer exports class `TUI` (now `TuiMainScreen` / `TuiAltScreen`).
  - `test/ff-labs-pi-fff-broker-interop.test.mjs`: requires `@mariozechner/jiti`; 1.3.0 depends on plain `jiti`.
  - `test/pi-interactive-compaction-spinner.test.mjs` (2 tests): drives `InteractiveMode.handleEvent` with a
    hand-built object; 1.3.0 added `this.programStatus`. These tests guarded an old core behavior.
- Pi 1.3.0 ships a faux model provider (`@earendil-works/pi-ai` `fauxProvider`/`createFauxCore`) and
  `pi.registerProvider(provider)`, so an E2E harness extension can script model responses in a real TUI.

## Design (1.3.0 lifecycle)

| Need | Public 1.3.0 seam | Notes |
|---|---|---|
| Start a block | `agent_start` (idempotent `ensureActiveBlock`) | Fires inside `_startRun` only after `_prepareRun` succeeded, so a failed prepare cannot leave a dangling dock. Retries/continuations fire it again; the existing block is reused. |
| Anchor block in transcript | first assistant `message_start` -> `pi.appendEntry("activity-block-turn", {turnId, turnDisplayId})` | Extension handlers run before the UI sees `message_start`, so the entry renders after the trigger/steer message and above the streaming reply. Custom entries are never sent to the model. |
| Split on steering/follow-up | user (or displayed custom) `message_start` while the active block is anchored | Unanchored blocks have no content yet, so the run's own trigger message never splits. No ignore flags needed. |
| Finish a block | `agent_settled` | Only signal that the whole run (retries, compaction continuation, queued follow-ups) is done. `agent_end` is stored as the pending terminal event. |
| Persist final state | `pi.appendEntry("activity-block-state", {turnId, snapshot})` | No entry renderer is registered for it, so it draws nothing. |
| Hide tool rows (live + replay) | `pi.registerToolRenderer` -> `renderShell: "self"` + empty components in block mode | Chosen per row at row creation. |
| Hide working row | `ctx.ui.setWorkingVisible(false)` in block mode | Re-applied on every `session_start` (pi resets it in `resetExtensionUI`). |
| Live dock | one permanent `aboveEditor` widget per session, renders `[]` when idle | Height-neutral when idle (pi adds the same 1-line spacer for an empty widget area). Gives a stable `TUI` handle for `requestRender()`, replacing the old `setStatus(key, undefined)` render-forcing side effect. |
| Legacy sessions | `registerMessageRenderer("activity-block-turn")` + `context` filter | Old anchors are `custom_message` entries that are part of model context. |

## Plan / checklist

- [x] P1 Test runtime: workspace `package.json` now pins `@earendil-works/pi-coding-agent@1.3.0` + `pi-tui@1.3.0`,
      with `@mariozechner/*` as npm aliases (54 source files still import that scope; pi's loader aliases both).
      Dropped unused `cli-highlight`; declared `jiti` + `strip-ansi` as devDependencies (tests used them only
      transitively). Fixed 4 tests coupled to old internals (TUI class, jiti scope, InteractiveMode fields, fake pi/ctx gaps).
- [x] P2 Rewrote activity-block: `index.ts` (wiring), `lib/activity-block-controller.ts` (lifecycle),
      `lib/activity-block-tool-rows.ts` (tool-row hiding), `lib/activity-block-commands.ts` (parsers).
- [x] P3 History reads `custom` anchors and legacy `custom_message` anchors through one parser.
- [x] P4 Shared harness `test/helpers/activity-block-harness.mjs` replays pi 1.3.0 event order; 23 lifecycle
      tests in `test/activity-block-index.test.mjs`; view-mode/dock/trigger tests ported. Removed the patch-contract
      test and the before_turn_response steering test (superseded by harness steering tests).
      Full suite: 568 tests, 567 pass, 0 fail, 1 pre-existing skip (was 564 / 2 fail).
- [ ] P5 Remove patch artifacts + patch-contract test; update README, `.lat-md/activity-block.md`, `patches.md`.
- [ ] P6 Remove core-rebuild step from `~/vault/.pi/scripts/pi/reapply-local-patches.sh` (+ its .md).
- [ ] P7 End-to-end: run real pi 1.3.0 in tmux with a faux/cheap model, verify dock, hidden rows, steering split, resume.
- [ ] P8 Full regression run + final report.

## E2E (stock pi 1.3.0 in tmux, faux scripted model)

Harness: `~/tmp/pi-work/e2e/` (`faux-e2e.ts` extension registers provider `faux-e2e/scripted`; `e2e.py` driver).
Isolated with `PI_CODING_AGENT_DIR=~/tmp/pi-work/e2e/agent`, `--no-extensions` + explicit `-e` for
tui-broker, custom-spinner, activity-block, faux-e2e.

- Tool loop (thinking + read + bash + text): live dock above editor with scanner, tool rows, thinking header,
  counts/tokens/timer; pi tool rows hidden; pi working row hidden; on settle the dock clears and the transcript
  block (COMPLETED!) sits between prompt and thinking/reply. Session order: user -> anchor -> assistant... -> state.
- Steering during a 6s bash tool: pi shows its own "Steering: ..." queue line; block 3 freezes as
  "Interrupted by steering" right when the steer message is injected; block 4 anchors under the steer message.
  **Bug found**: block 4 showed "1 tool calls" — `finishRun` adopted the pre-steer tool result from
  `agent_end.messages` (which spans the whole agent run). Fixed in `applyTerminalToolResults` (only settle tools the
  block itself started) + regression test `a post-steer block does not adopt tool results ...`.
- Follow-up (Alt+Enter) during a slow tool: split worked, but the finished first block was labeled
  "Interrupted by steering". **Fixed**: controller records the block's last `turn_end`; if it ended with a
  non-`toolUse` assistant message the loop was done, so the block finishes as Completed. Test added.
- Error before output (`fail`): block shows "Error: scripted provider failure", pi shows its own error line.
  The anchor exists here because pi emits an assistant `message_start` for the error message (expected).
- Resume of a 10-block session (`--session <file>`): every block replays in place with correct labels/counts;
  no pi tool rows; 2 legacy-free anchors render via the entry renderer.
- `/activity-block mode default`: pi's own tool rows, outputs, and working spinner return; no block created.
  `mode block` restores. Zen on hides the dock and transcript block; zen off reveals the finished block in place.
- `/reload`: dock, working-row hiding, and blocks keep working (session_start re-installs; pi stderr empty).
- `/compact` (keepRecentTokens=300 in the isolated settings): chat rebuild keeps kept blocks, no tool rows leak.
  **Bug found**: first block after compaction showed the whole-context token count (2K). pi reports
  `getContextUsage().tokens = null` until the first post-compaction reply, so no baseline was set and the usage
  path reported raw totals. **Fixed** in `syncLatestTokenCount`: without a baseline, the first non-zero usage
  becomes the baseline (zero-usage streaming partials are skipped, matching pi's own rule). Verified: 84 tokens
  ("< 1K") after compaction. Tests added.
- Full real config (`agent-full`: symlinks to the real extensions/npm/git/skills/themes/prompts, copied settings
  with the faux model, no auth; instance manager disabled + self-checkpointing state redirected so no shared state
  is touched): all 16 extensions + pi-fff + claude-code load, pi stderr empty. Tool loop, `fffind` (pi-fff tool,
  summarized as `fffind "alpha" in repo`), steering split, and Esc abort all render correctly next to tui-broker,
  quota-footer, goal, self-checkpointing, startup-screen.
  - Esc during a tool: the block shows `Error: This operation was aborted` with the tool marked failed. That is
    what pi persisted (`stopReason: error`), because the faux provider raises on abort instead of returning
    `aborted`. Real providers report `aborted` -> block shows "Aborted". Not an activity-block issue.
  - First block of a fresh session shows ~15K tokens: the first block has no baseline (no usage yet, pi estimates
    from scratch), and that estimate includes the system prompt + tool schemas of the full extension set. Same
    behavior as before the port (old code also used `getContextUsage` at block start). Later blocks are scoped.

## Assumptions (to report)

(filled in as they are made)

## Log

- 2026-10-20: baseline extension suite (before this track, after removing fast/diff-review): 333 tests, 332 pass,
  1 pre-existing failure (`@ff-labs/pi-fff contributes autocomplete without replacing tui-broker editor`).
