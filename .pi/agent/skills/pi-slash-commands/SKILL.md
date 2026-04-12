---
name: pi-slash-commands
description: Let pi run the same commands that pi-discord-bot exposes (/new /resume /model /session /compact /reload) plus pi’s tool-oriented `/tree` flow from natural language, preferring the in-session `pi_slash` extension tool.
---

# pi-slash-commands

Use this skill when Tan asks (in natural language) for pi to run pi-discord-bot parity commands.

## Command coverage (exact, no extras)

Only these **7 commands** are in scope:

- `/new`
- `/resume [thread_id]`
- `/model [provider/model_id] [effort]`
- `/session`
- `/tree [entry_id] [--summary]`
- `/compact [instructions]`
- `/reload`

If Tan asks for anything outside this set, say it is out of scope for this skill and propose the closest supported command.

## Primary mechanism (interactive session)

Prefer the in-session extension tool **`pi_slash`** (it can control the currently running interactive pi session).

- Help command inside pi: `/pi-slash-commands`
- Tool ops:
  - `model.set`
  - `thinking.set`
  - `slash.run`

## Safety / confirmation rules (must follow)

Before executing, pi must ask for confirmation if the user request implies:

- `/compact`
- `/new`
- `/resume`

## Quick natural-language examples

- “switch to 5.3 codex medium” → `/model openai-codex/gpt-5.3-codex medium`
- “switch model to gpt-5.2 high reasoning” → `/model openai-codex/gpt-5.2 high`
- “what model is active?” / “show session” → `/session`
- “show me the session tree” → `/tree`
- “jump to tree node <entry_id>” → `/tree <entry_id>`
- “compact now” → `/compact` (confirmation required)
- “start fresh” → `/new` (confirmation required)
- “resume this thread <id>” → `/resume <thread_id>` (confirmation required)
- “reload extensions” → `/reload`

## Natural language → action mapping (discord-parity)

### /model

User: “switch model to gpt-5.2” / “use gpt-5.3-codex with high reasoning”

- If user supplies only `modelId`, resolve provider by searching `pi --list-models` (via bash) and pick the unique match; otherwise ask.
- Then call `pi_slash` with `op: model.set`.
- If user specifies effort/reasoning level, pass `thinkingLevel`.

### /session

User: “show session” / “what session am I on”

- Call `pi_slash` with `op: slash.run`, `command: "/session"`.

### /tree

User: “show me the tree” / “jump to node <entry_id>”

- Call `pi_slash` with `op: slash.run`, `command: "/tree"` to get a text tree snapshot the assistant can inspect.
- Call `pi_slash` with `op: slash.run`, `command: "/tree <entry_id>"` to jump directly to a specific node.
- Add `--summary` only when the user explicitly wants a branch summary before switching.
- Tool-driven `/tree` is intentionally non-interactive: no picker UI, no custom-prompt editor.

### /compact

User: “compact the session” / “compress context”

- Ask for confirmation.
- Then `pi_slash` `slash.run` with `command: "/compact"` (and include instructions if provided).

### /new

User: “start a new session”

- Ask for confirmation.
- Then `pi_slash` `slash.run` with `command: "/new"`.

### /resume

User: “resume last” / “resume <thread_id>”

- Ask for confirmation.
- Then `pi_slash` `slash.run` with `command: "/resume"` or `"/resume <thread_id>"`.

### /reload

User: “reload extensions” / “reload resources”

- `pi_slash` `slash.run` with `command: "/reload"`.

## Headless fallback (scripts)

If `pi_slash` is unavailable, use these wrappers (they mirror the Discord command set where possible):

- `/new`      → `bash agents/scripts/pi-slash-commands/discord-new.sh --force`
- `/resume`   → `bash agents/scripts/pi-slash-commands/discord-resume.sh <sessionPath> --force`
- `/model`    → `bash agents/scripts/pi-slash-commands/discord-model.sh <provider> <modelId> [thinkingLevel]`
- `/session`  → `bash agents/scripts/pi-slash-commands/discord-session.sh`
- `/compact`  → `bash agents/scripts/pi-slash-commands/discord-compact.sh --force [instructions...]`
- `/reload`   → `bash agents/scripts/pi-slash-commands/discord-reload.sh`
- `/tree`     → no safe headless parity wrapper yet; require the in-session `pi_slash` tool

Warning: RPC fallback operates on session files and may not affect an already-running interactive pi TUI session the way the extension tool does.
