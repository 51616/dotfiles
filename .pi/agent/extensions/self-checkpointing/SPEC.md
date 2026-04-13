# Self-checkpointing system (checkpoint + self-ping + compact + resume)

## Goal

When the session context usage reaches a threshold (**65%** by default), pi should shift into a predictable “save game and keep going” mode:

1) **Auto-kick** (extension-driven): inject a directive message that tells the assistant to checkpoint now.
2) **Checkpoint** (assistant-driven): pi writes a detailed, resumable checkpoint note under `/tmp/pi-work/checkpoints/`.
3) **Compact** (extension-driven): trigger compaction to free context.
4) **Self-ping / resume** (extension-driven): inject a follow-up user message so work continues from the checkpoint.

Behavior:
- When the threshold is reached (detected via `ctx.getContextUsage()`), `self-checkpointing` will **auto-kick** a directive message (a `custom_message` with `display=true`) delivered as a **steering** message to interrupt the current run and force the assistant to write a checkpoint note + footer. This makes checkpointing work even in repos that don’t carry `AGENTS.md`.
- This is the only supported behavior.

## Scope / non-goals

In scope:
- Interactive TUI (primary).
- Uses `ctx.getContextUsage()` (estimate) + active model’s `contextWindow`.
- Threshold-based auto-kick from runtime state.
- Checkpoint note uses the existing `checkpointing` skill conventions (location, filename).

Non-goals:
- Perfect token accounting.
- Fully autonomous checkpoint authoring. The assistant writes the checkpoint (that’s the point: it captures intent + plan).

## UX contract

### 1) Assistant behavior when the auto-checkpoint directive appears

When the assistant sees the injected `[autockpt]` directive, it must:

1) Stop continuing the main task immediately.
2) Produce a checkpoint note under `/tmp/pi-work/checkpoints/` using JST naming (`YYYY-MM-DD_HHMM_<slug>.md`).
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
- validate that the checkpoint path is not obviously malformed and that the target exists
- compact with targeted `customInstructions`
- resume work via a self-ping

## Extension responsibilities

(Implementation note: we originally wanted “queue follow-up before compaction”, but pi’s `ctx.compact()` aborts the agent and can drop queued follow-ups. So v1 uses: **compact → then send the resume user message**.)

### Components

1) `self-checkpointing` extension (`.pi/extensions/self-checkpointing/`)
- Owns trigger arming, auto-kick, footer detection, compaction, and resume pings.
- Does **not** inject checkpoint instructions into normal assistant text; it injects a separate steering/custom message when auto-kick fires.
- Watches **assistant `message_end`** and only matches the footer when it is the **last non-whitespace** content of the assistant message.
- Footer matching is newline-robust (accepts both `\n` and `\r\n`).
- Trigger gating (all must pass):
  - assistant message ended (`message_end`)
  - `ctx.getContextUsage().percent >= thresholdPercent` at detection time
    - (We intentionally do not rely on any transcript-visible signal because tool usage can split a single user-visible turn into multiple internal turns.)
  - footer matches the strict shape (instruction block + completion line)
  - checkpoint path validates and exists:
    - reject placeholders like `<...>` and other obviously malformed paths
    - allow relative or absolute paths
    - local mode checks the local filesystem; `pi-ssh` mode checks the remote workspace via SSH
  - checkpoint file freshness check:
    - file mtime must be within `PI_SELF_CHECKPOINT_MAX_CHECKPOINT_AGE_MS` (default 10 minutes)
    - in `pi-ssh` mode, freshness/existence checks use the SSH-aware checkpoint probe instead of local `fs` calls
  - duplicate-footer dedupe does not block it (same path ignored for `PI_SELF_CHECKPOINT_FOOTER_DEDUPE_MS`, default 15s)
  - compaction owner PID lock is held by the current process (the pid that injected the steering directive is the pid that performs compaction+resume)
- Action:
  - call `ctx.compact({ customInstructions })`
  - on compaction complete/error: clear autotest runtime overrides, then queue the resume text through the follow-up user-message path
- Debug/testing helpers:
  - `/autockpt status`
  - `/autockpt threshold <pct>` (sets runtime override)
  - `/autockpt threshold reset`
  - `/autockpt test [<pct>]`

2) Discord relay
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
- One extension owns both the threshold gating and the orchestration lifecycle, so there is one canonical trigger path.
- Loop risk is reduced primarily by the in-process checkpoint-cycle state and compaction owner lock.

## Configuration

Environment variables (defaults in parentheses):
- `PI_SELF_CHECKPOINT_ENABLE` (`1`)
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT` (`65`)
- `PI_SELF_CHECKPOINT_THRESHOLD_PERCENT_RUNTIME` (unset)
- `PI_SELF_CHECKPOINT_DEBUG` (`0`) — when `1`, keep a live debug widget updated
- `PI_SELF_CHECKPOINT_MAX_CHECKPOINT_AGE_MS` (`600000`) — reject stale checkpoint paths
- `PI_SELF_CHECKPOINT_FOOTER_DEDUPE_MS` (`15000`) — ignore duplicate footer for the same checkpoint path within this window
- `PI_SELF_CHECKPOINT_AUTO_KICK_MAX_AGE_MS` (`120000`) — auto-kick watchdog timeout for “writing checkpoint…” state
- `PI_SELF_CHECKPOINT_AUTO_KICK_MIN_TOOL_CALLS` (`10`) — min number of tool calls between auto-kick reminder attempts
- `PI_SELF_CHECKPOINT_AUTOTEST_MAX_AGE_MS` (`300000`) — autotest cleanup failsafe
- `PI_SELF_CHECKPOINT_AUTOTEST_MAX_TURNS` (`12`) — autotest cleanup failsafe
- `PI_SELF_CHECKPOINT_STATE_DIR` (unset) — override the state directory (default: `~/.pi/agent/state/pi-self-checkpointing`)
- `PI_SELF_CHECKPOINT_PENDING_RESUME_PATH` (unset) — override the pending resume file path (useful for tests). If unset, defaults to `<STATE_DIR>/pending-resume.<sessionHash>.json`.
- `PI_SELF_CHECKPOINT_COMPACTION_LOCK_PATH` (unset) — override the compaction owner lock file path. If unset, defaults to `<STATE_DIR>/compaction.<sessionHash>.lock.json`.
- `PI_SELF_CHECKPOINT_COMPACTION_LOCK_MAX_AGE_MS` (`600000`) — if PID liveness can’t be checked, treat an older lock as stale

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
  - do not arm auto-checkpointing from that usage sample
- If the assistant forgets to emit the footer (or emits a malformed footer):
  - the orchestrator does not compact (safe default)
  - it clears the in-flight “writing checkpoint…” state at the next assistant `message_end` (or via watchdog timeout) and releases the compaction owner lock, so status doesn’t get stuck
  - it may retry auto-kick up to the attempt limit (default: 3)
  - debug mode logs “footer not matched” if it looks like the assistant tried
- If a pending resume record exists but the referenced checkpoint file no longer exists:
  - clear the pending record (prevents confusing self-pings from stale state)
  - in `pi-ssh` mode, use the SSH-aware checkpoint probe so remote-only checkpoints are not cleared incorrectly

## Observability

- Status bar entry:
  - `autockpt: idle|armed|compacting|compaction failed (...)`
- Debug widget (when enabled): recent event log + current settings.

## Acceptance tests

### Manual test (interactive)

1) Force threshold low:
   - `/autockpt threshold 1`
2) Run a tool or continue work until the threshold logic trips.
3) Confirm the auto-checkpoint directive appears.
4) Write a checkpoint note and end with the footer block. The footer may reference a relative or absolute path as long as the target exists.
5) Verify compaction+resume occurred by checking the session JSONL:
   - new `{"type":"compaction", ...}` line appended
   - injected resume user message referencing the checkpoint path

### One-shot autotest

1) Create the flag file:
   - `printf '1\n' > work/.autockpt_autotest_once`
2) Run built-in `/reload`.
3) Verify a new compaction + injected resume user message were appended to the active session JSONL.
