# Self-checkpointing system (checkpoint + self-ping + compact + resume)

## Goal

When the session context usage reaches a threshold (**65%** by default), pi should shift into a predictable “save game and keep going” mode:

1) **Signal** (non-invasive): add an explicit checkpoint-required marker to the existing context stamp.
2) **Checkpoint** (assistant-driven): pi writes a detailed, resumable checkpoint note under `work/log/checkpoints/`.
3) **Compact** (extension-driven): trigger compaction to free context.
4) **Self-ping / resume** (extension-driven): inject a follow-up user message so work continues from the checkpoint.

Behavior:
- When the threshold is reached (detected via `ctx.getContextUsage()` and/or a stamped tool result), `self-checkpointing` will **auto-kick** a directive message (a `custom_message` with `display=true`) delivered as a **steering** message to interrupt the current run and force the assistant to write a checkpoint note + footer. This makes checkpointing work even in repos that don’t carry `AGENTS.md`.
- This is the only supported behavior (no stamp-only fallback).

## Scope / non-goals

In scope:
- Interactive TUI (primary).
- Uses `ctx.getContextUsage()` (estimate) + active model’s `contextWindow`.
- The stamp appears:
  - at end of user messages (excluding `/...` inputs)
  - at end of each tool result
- Checkpoint note uses the existing `checkpointing` skill conventions (location, filename).

Non-goals:
- Perfect token accounting.
- Fully autonomous checkpoint authoring. The assistant writes the checkpoint (that’s the point: it captures intent + plan).

## UX contract

### 1) Context stamp format (hard requirement)

The stamp must include raw tokens + percent + left:

```
[pi ctx] used=88435 (32.5%) left=183565 window=272000
```

Rules:
- `left = max(0, window - used)`
- If `tokens` is unknown (`tokens === null`):

```
[pi ctx] used=? (?) left=? window=272000
```

### 2) Checkpoint-required marker in the stamp

When `percent >= thresholdPercent` (default 65.0), append this exact suffix to the stamp line (unless suppressed; see below):

```
__PI_CHECKPOINT_NOW__
```

So the full line becomes:

```
[pi ctx] used=176000 (64.7%) left=96300 window=272000 __PI_CHECKPOINT_NOW__
```

This marker is the *single* trigger that the **assistant** must obey.

### Marker suppression (anti-loop / race)

To avoid spamming `__PI_CHECKPOINT_NOW__` on subsequent messages while a compaction is already spinning up, the orchestrator sets:

- `PI_SELF_CHECKPOINT_MARKER_SUPPRESS=1`

While this is set, `context-stamp` emits nothing (no `[pi ctx]` line and no `__PI_CHECKPOINT_NOW__`).

### 3) Assistant behavior when marker is present

When the assistant sees a stamp containing `__PI_CHECKPOINT_NOW__`, it must:

1) Stop continuing the main task immediately.
2) Produce a checkpoint note under `work/log/checkpoints/` using JST naming (`YYYY-MM-DD_HHMM_<slug>.md`).
3) Make the checkpoint “reconstructable”:
   - current objective/spec
   - current implementation status
   - decisions + rationale
   - open questions / risks
   - artifact pointers (paths, commands, run ids, commits)
   - next steps + verification commands
4) End its assistant message with:

- a **compaction instruction block** (free-form text; focus the compaction summary on current work, milestones, and goals)
- then a final **completion line** containing the checkpoint path

Example footer shape (**must be raw text, not inside a fenced code block**):

```text
__pi_compact_instructions_begin__
<instructions for what the compaction summary should preserve/emphasize>
__pi_compact_instructions_end__
__pi_autocheckpoint_done__ path=<checkpoint_path>
```

The `self-checkpointing` extension uses this footer to:
- extract compaction instructions
- validate the checkpoint path
- compact with targeted `customInstructions`
- resume work via a self-ping

## Extension responsibilities

(Implementation note: we originally wanted “queue follow-up before compaction”, but pi’s `ctx.compact()` aborts the agent and can drop queued follow-ups. So v1 uses: **compact → then send the resume user message**.)

### Components

1) `context-stamp` extension (`agents/extensions/context-stamp/`)
- Adds the stamp to assistant messages and tool results (not user messages).
- Adds the checkpoint arm marker only when the threshold is met.
- Debug/testing helpers:
  - `/ctxstamp status`
  - `/ctxstamp threshold <pct>` (sets runtime override)
  - `/ctxstamp threshold reset`

2) `self-checkpointing` extension (`agents/extensions/self-checkpointing/`)
- Does **not** inject checkpoint instructions.
- Watches **assistant `message_end`** and only matches the footer when it is the **last non-whitespace** content of the assistant message.
- Footer matching is newline-robust (accepts both `\n` and `\r\n`).
- Trigger gating (all must pass):
  - assistant message ended (`message_end`)
  - `ctx.getContextUsage().percent >= thresholdPercent` at detection time
    - (We intentionally do **not** rely on “arm marker seen this turn” because tool usage can split a single user-visible turn into multiple internal turns.)
  - footer matches the strict shape (instruction block + completion line)
  - checkpoint path validates and exists:
    - `work/log/checkpoints/*.md`
    - reject placeholders like `<...>`
    - `existsSync(checkpointPath)`
  - checkpoint file freshness check:
    - `statSync(checkpointPath).mtimeMs` must be within `PI_SELF_CHECKPOINT_MAX_CHECKPOINT_AGE_MS` (default 10 minutes)
  - duplicate-footer dedupe does not block it (same path ignored for `PI_SELF_CHECKPOINT_FOOTER_DEDUPE_MS`, default 15s)
  - compaction owner PID lock is held by the current process (the pid that injected the steering directive is the pid that performs compaction+resume)
- Action:
  - call `ctx.compact({ customInstructions })`
  - on compaction complete/error: clear autotest runtime overrides, then `pi.sendUserMessage(resumeText)`

3) Discord relay
- Live Discord bridge tooling is retired (headless-only Discord execution; no `discord-bridge` extension).

### Self-ping message content

The injected follow-up user message should:
- reference checkpoint path explicitly
- instruct: resume from the checkpoint plan

Example:

```
We just auto-checkpointed and compacted context. Resume using checkpoint: <path>.
Continue from the Next steps section in that checkpoint.
```

## Triggering & gating details

Default threshold:
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT=65`

Runtime override (in-process, for testing):
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME=<pct>`

Notes:
- Both extensions read the same threshold sources, so the stamp marker and the orchestrator gating stay consistent.
- Loop risk is reduced primarily by not stamping user messages and suppressing markers only while compaction is in flight.

## Configuration

Environment variables (defaults in parentheses):
- `PI_CONTEXT_STAMP_ENABLE` (`1`)
- `PI_SELF_CHECKPOINT_ENABLE` (`1`)
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT` (`65`)
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME` (unset)
- `PI_SELF_CHECKPOINT_DEBUG` (`0`) — when `1`, keep a live debug widget updated
- `PI_SELF_CHECKPOINT_MAX_CHECKPOINT_AGE_MS` (`600000`) — reject stale checkpoint paths
- `PI_SELF_CHECKPOINT_FOOTER_DEDUPE_MS` (`15000`) — ignore duplicate footer for the same checkpoint path within this window
- `PI_SELF_CHECKPOINT_AUTO_KICK_MAX_AGE_MS` (`120000`) — auto-kick watchdog timeout for “writing checkpoint…” state
- `PI_SELF_CHECKPOINT_AUTO_KICK_MIN_INTERVAL_MS` (`10000`) — min interval between auto-kick attempts
- `PI_SELF_CHECKPOINT_AUTOTEST_MAX_AGE_MS` (`300000`) — autotest cleanup failsafe
- `PI_SELF_CHECKPOINT_AUTOTEST_MAX_TURNS` (`12`) — autotest cleanup failsafe
- `PI_SELF_CHECKPOINT_STATE_DIR` (unset) — override the state directory (default: `~/.pi/agent/state/pi-self-checkpointing`)
- `PI_SELF_CHECKPOINT_PENDING_RESUME_PATH` (unset) — override the pending resume file path (useful for tests). If unset, defaults to `<STATE_DIR>/pending-resume.<sessionHash>.json`.
- `PI_SELF_CHECKPOINT_COMPACTION_LOCK_PATH` (unset) — override the compaction owner lock file path. If unset, defaults to `<STATE_DIR>/compaction.<sessionHash>.lock.json`.
- `PI_SELF_CHECKPOINT_COMPACTION_LOCK_MAX_AGE_MS` (`600000`) — if PID liveness can’t be checked, treat an older lock as stale

(Compat / legacy):
- `PI_AUTOCHECKPOINT_THRESHOLD_PERCENT` — used as a fallback threshold source by `context-stamp`.

Debug command (`/autockpt`):
- `/autockpt` or `/autockpt status`
- `/autockpt log`
- `/autockpt clear`
- `/autockpt debug on|off`
- `/autockpt threshold <pct>` / `/autockpt threshold reset`
- `/autockpt test [<pct>]`
- `/autockpt help`

## Autotest harness (one-shot)

Purpose: enable hands-off E2E testing without needing to type extension commands.

- Flag file: `work/.autockpt_autotest_once`
  - On `session_start` (usually after `/reload`), if this file exists:
    - read its contents as `<pct>` (defaults to `1`)
    - delete the file
    - enable debug
    - set `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME=<pct>`
    - send a user message containing the E2E test instructions
- Cleanup:
  - on compaction complete/error, runtime override is cleared back to default
  - if compaction never triggers, a `turn_end` timeout failsafe clears the runtime override

## Failure handling

- On `session_start`, the extension sweeps its state dir (`~/.pi/agent/state/pi-self-checkpointing/` by default) and deletes **stale compaction lock files** (dead PID, or an unreadable/partial JSON file older than a few seconds). This prevents “no-session:<pid>” lock artifacts from accumulating across restarts/workers.

- If `ctx.getContextUsage()` returns `tokens=null` (often right after compaction):
  - no stamp is emitted
  - no checkpoint marker
- If the assistant forgets to emit the footer (or emits a malformed footer):
  - the orchestrator does not compact (safe default)
  - it clears the in-flight “writing checkpoint…” state at the next assistant `message_end` (or via watchdog timeout) and releases the compaction owner lock, so status doesn’t get stuck
  - it may retry auto-kick up to the attempt limit (default: 3)
  - debug mode logs “footer not matched” if it looks like the assistant tried
- If a pending resume record exists but the referenced checkpoint file no longer exists:
  - clear the pending record (prevents confusing self-pings from stale state)

## Observability

- Status bar entries:
  - `ctxstamp: on/off`
  - `autockpt: idle|armed|compacting|compaction failed (...)`
- Debug widget (when enabled): recent event log + current settings.

## Acceptance tests

### Manual test (interactive)

1) Force threshold low:
   - `/ctxstamp threshold 1`
2) Run a tool:
   - confirm the tool output ends with the stamp and includes the checkpoint-required marker.
3) Write a checkpoint note and end with the footer block.
4) Verify compaction+resume occurred by checking the session JSONL:
   - new `{"type":"compaction", ...}` line appended
   - injected resume user message referencing the checkpoint path

### One-shot autotest

1) Create the flag file:
   - `printf '1\n' > work/.autockpt_autotest_once`
2) Run built-in `/reload`.
3) Verify a new compaction + injected resume user message were appended to the active session JSONL.
