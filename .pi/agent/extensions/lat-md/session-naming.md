# Session naming

Owns the two-stage automatic session-title flow for fresh unnamed sessions.

Entrypoint: [[session-naming/index.ts]].

## Responsibilities

These are the behaviors the extension must keep stable when the auto-title flow changes.

- detect only fresh unnamed sessions as eligible; leave named or history-bearing sessions alone
- set one provisional title from the first non-extension user input by redacting obvious secret-like strings, collapsing whitespace, and truncating to a 30-character visible budget with the ellipsis inside the budget
- after the first full agent response finishes, request one semantic session title from `gpt-5.3-codex-spark`
- build that semantic prompt from the first-turn user/assistant exchange only; do not forward raw tool-result payloads or assistant tool-call arguments just for naming
- keep the semantic naming transcript bounded and redact obvious secret-like strings before the model call
- prefer `openai-codex` for the semantic naming model and fall back to `openai`
- respect manual rename or manual clear actions by refusing to overwrite a session name that drifted away from the provisional title, including a new `session_info` entry that keeps the same visible title
- persist enough branch-local state that `/reload`, `/resume`, `/switch`, `/fork`, `/tree`, and compaction do not rerun the two naming stages unexpectedly
- carry a fingerprint of the original first input so stage 2 can prove it still belongs to that first turn
- fail closed if stage 1 completed but the extension later sees a new user input, committed assistant history, or missing provisional title before stage 2 can safely use the original first-turn conversation
- keep failures quiet and sticky: if semantic naming fails, keep the best existing title and do not auto-retry

## Invariants

These rules keep the title flow predictable across reloads, resumes, and manual intervention.

- auto-naming is one-shot per eligible branch: `idle -> pending-semantic -> done|failed|manual-override`
- stage 1 never runs for extension-injected input, existing named sessions, or sessions that already have meaningful history
- both the provisional title and the semantic naming transcript apply lightweight secret redaction before any persisted title/model call is produced
- stage 2 only runs after `agent_end`, never from partial assistant streaming events
- the semantic name replaces only the provisional name created by this extension; any drift from that provisional value is treated as a manual override
- persisted custom entries are the source of truth for replay/reload state; in-memory state must rehydrate from the current branch on `session_start`, `session_switch`, `session_fork`, `session_tree`, and `session_compact`
- `session_before_switch`, `session_before_fork`, `session_before_tree`, and `session_before_compact` must cancel stale in-flight stage-2 work before the runtime changes branches or transcript shape
- a `pending-semantic` state may survive reload while only the original first user message is committed, but it must fail closed once a later user input arrives or committed assistant history (`assistant`, `compaction`, `branch_summary`, or `custom_message`) proves the original `agent_end` opportunity was missed
- pending stage-2 work must keep the provisional `session_info` entry id so a later manual rename to the same visible text still blocks semantic overwrite
- stage 2 validates the original first-input fingerprint before renaming so a stale pending state cannot rename from an unrelated turn
- if the session name is missing while a `pending-semantic` provisional title exists, treat that as a `failed` state (`missing-session-name-on-hydrate`) so delayed semantic naming cannot overwrite it
- if the provisional title or its tracked provisional `session_info` entry id is missing during hydration, treat that as a failure state instead of guessing whether persistence broke
- the semantic naming prompt may still contain sensitive free-form user text, so the extension must only send bounded user/assistant text and apply lightweight secret redaction before the naming model call
- semantic model/auth failures do not clear the provisional name and do not schedule retries

## Change guidance

Use this map to avoid fixing only the rendered title while leaving lifecycle or persistence behavior stale.

- change `session-naming/lib/session-naming.ts` when truncation, normalization, provider preference, persisted state parsing, or title-prompt shaping needs to change
- change `session-naming/index.ts` when the event lifecycle, manual-override precedence, or model-call timing is wrong
- if duplicate renames appear after reload/tree navigation, inspect branch hydration and `session_info` drift first before changing the naming stages
- if the semantic naming provider changes, update both the helper selection logic and the tests that assert provider preference

## Verification

These checks prove the helper logic, extension event flow, and folder-based entrypoint contract still agree.

- `node --test .pi/extensions/test/session-naming-lib.test.mjs .pi/extensions/test/session-naming-index.test.mjs .pi/extensions/test/entrypoints-folder-based.test.mjs`
