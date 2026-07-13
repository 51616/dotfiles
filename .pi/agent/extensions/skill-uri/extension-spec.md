# skill-uri extension spec

## Goal

Provide one canonical skill resource interface for pi sessions without modifying pi core.

## Owned behavior

### Prompt rewriting

- parse the discovered `<available_skills>` block from the system prompt
- register each skill by name
- detect duplicate names and keep the last entry
- rewrite surviving skill `<location>` values to `skill://<skill-name>/SKILL.md`
- inject guidance telling the agent how to use `skill://...` safely

### read / write / edit

- accept canonical `skill://<skill-name>/...` paths
- resolve them against the registered local skill root
- reject traversal outside the skill root
- reject symlink escapes from within the skill root
- preserve local skill behavior by wrapping `createReadTool`, `createWriteTool`, and `createEditTool`
- route only non-skill workspace paths through an active `PiSshSession`
- adapt high-level remote results in `lib/remote-workspace-tools.ts` so text notices, image resizing/attachment, success text, diff details, and per-file mutation queues remain consistent with pi; queued mutations are abort-aware and recheck the signal before dispatch
- issue one high-level session call for each remote read, write, or edit instead of composing low-level access/read/write operations

### run_skill_script

- requires `script` to be a full `skill://<skill-id>/relative/path` URI
- allows any file under the skill root, not only `scripts/`
- no longer accepts an explicit `target`; execution follows the active `pi-ssh` session automatically when one is present
- uses local execution by default, and stages the local skill root to `~/.cache/pi/skill-stage/...` before execution when an active `pi-ssh` session exists
- reuses a cached remote stage only after both the stage marker and the requested staged script path probe successfully
- skips obvious local-only or sensitive paths during staging
- rejects staged payloads above 10 MiB

## SSH session contract

`skill-uri` can consume one active SSH session published on runtime state. Its extension instance registers a unique workspace-router token and removes that token on session shutdown; stale instance cleanup cannot remove a newer registration. `pi-ssh` requires a current registration before starting remote mode, so both extensions are a single deployment unit for SSH workspace tools.

That session supplies:
- high-level `readWorkspaceFile()`, `writeWorkspaceFile()`, and `editWorkspaceFile()` calls for non-skill workspace paths
- exact worker-backed `readFile()` and `writeFile()` calls for staged skill bytes
- bash operations for remote command execution
- remote staging context (`remoteHome` + `transport`) for `run_skill_script`
- exact exec capture, text execution, repo/stat helpers, and deterministic path mapping for SSH-aware consumers

Remote read ranges and pi truncation are applied by the worker before bytes cross SSH. Remote write payloads are raw UTF-8. Remote edits send replacement blocks and receive bounded diff metadata. Worker lifecycle, Python 3.9+ requirements, limits, and logger privacy are owned by pi-ssh rather than duplicated here.

In this vault, `pi-ssh/lib/pi-ssh-session-runtime.ts` provides that contract.

When debugging, `PI_SKILL_URI_DEBUG=1` emits stage decision logs and should usually be paired with `PI_SSH_DEBUG=1` so the remote file probes behind each cache-hit or cache-miss are visible too.

## Non-goals

- no pi core changes
- no separate user-facing `skill://local/...` or `skill://remote/...` formats
- no independent skill filesystem discovery that could drift from pi core
