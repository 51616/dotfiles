# activity-block

Shows the agent's live work (thinking header, tool calls, counts, tokens, timer) in one bounded panel above the
editor while pi works, then leaves a compact block in the transcript between each prompt and its reply.

It runs on **stock pi** (`@earendil-works/pi-coding-agent` 1.3.0) using only the public extension API.
Earlier versions needed a patched pi core (`setLiveTranscriptMode`, `before_turn_response`, ...); those patches
and the core-rebuild step were removed on 2026-10-20.

## What it does

| Behavior | How (pi 1.3.0 API) |
|---|---|
| Live panel above the editor | One permanent `aboveEditor` widget per session (`ctx.ui.setWidget`). It draws nothing while idle. |
| Hide pi's working row | `ctx.ui.setWorkingVisible(false)` in block mode; the panel has its own scanner. |
| Hide pi's tool rows (live and when a session is reopened) | `pi.registerToolRenderer` returns `renderShell: "self"` with empty components in block mode. |
| Block in the transcript | A `custom` entry `activity-block-turn` written with `pi.appendEntry` on the block's first assistant message, drawn by `pi.registerEntryRenderer`. Custom entries are never sent to the model. |
| Final block state | A `custom` entry `activity-block-state` written when the run settles (no renderer; data only). |
| New block for steering / follow-up messages | A user (or displayed custom) message arriving mid-run freezes the current block and starts a new one. Its anchor is written on the next assistant message, so it sits under that message. |

Thinking is **not** hidden from the transcript. pi's own `hideThinkingBlock` setting decides whether thinking
shows collapsed (`Thinking...`) or expanded. The panel keeps its own thinking header/excerpt.

## Commands and keys

- `/activity-block` or `ctrl+alt+a`: cycle tool history `latest -> recent (5) -> all`. Arguments: `latest`, `recent`, `all`.
- `/activity-block-thinking [expand|collapse]` or `ctrl+alt+t`: show the current thinking text inside the block.
- `/activity-block zen [on|off]` or `ctrl+alt+z`: hide blocks entirely (pi's tool rows stay hidden).
- `/activity-block mode default|block`: `default` gives tool rows and the working row back to pi and stops creating
  blocks. Rows already on screen keep their look until pi rebuilds the chat (resume, reload, compaction).

## Lifecycle (one run)

1. `agent_start`: create the active block (idempotent: retries and compaction continuations reuse it).
2. First assistant `message_start`: write the transcript anchor.
3. `message_update` / `tool_execution_*`: update the block (nested codemode calls are skipped).
4. User or displayed custom `message_start` while the block is anchored: freeze it (`Interrupted by steering`, or
   `Completed` when the previous turn had finished its tool work, as for a follow-up) and start a new block.
5. `agent_end`: remember the terminal event (not final; pi may retry or continue).
6. `agent_settled`: finish the block and write `activity-block-state`.

Sessions written by the old patched runtime stored anchors as `custom_message` entries. They still render through
`pi.registerMessageRenderer`, and the `context` hook keeps them out of model requests.

## Files

- `index.ts`: wiring of pi events, renderers, commands, shortcuts.
- `lib/activity-block-controller.ts`: lifecycle and UI ownership rules.
- `lib/activity-block-tool-rows.ts`: tool-row hiding.
- `lib/activity-block-state.ts`: reducer from pi events to block state.
- `lib/activity-block-widget.ts`: the bounded block component.
- `lib/activity-block-history.ts`: anchor parsing and snapshot reconstruction on resume.
- `lib/activity-block-commands.ts`: argument parsers.

## Verify

```bash
cd ~/.pi/agent/extensions
npx tsc -p activity-block/tsconfig.json            # typecheck against the pinned pi runtime
node --test test/activity-block-*.test.mjs activity-block/test/*.test.mjs
```

`test/helpers/activity-block-harness.mjs` replays pi 1.3.0's event order, so lifecycle tests exercise the same
sequence as the real runtime. The extension workspace pins pi in `package.json`; bump it together with pi.
