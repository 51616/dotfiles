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
- preserve the built-in tool UX by wrapping `createReadTool`, `createWriteTool`, and `createEditTool`

### run_skill_script

- requires `script` to be a full `skill://<skill-id>/relative/path` URI
- allows any file under the skill root, not only `scripts/`
- no longer accepts an explicit `target`; execution follows the active `pi-ssh` session automatically when one is present
- uses local execution by default, and stages the local skill root to `~/.cache/pi/skill-stage/...` before execution when an active `pi-ssh` session exists
- reuses a cached remote stage only after both the stage marker and the requested staged script path probe successfully
- skips obvious local-only or sensitive paths during staging
- rejects staged payloads above 10 MiB

## SSH session contract

`skill-uri` can consume one active SSH session published on runtime state.

That session supplies:
- read / write / edit operation builders for non-skill workspace paths
- bash operations for remote command execution
- remote staging context (`remoteHome` + `transport`) for `run_skill_script`
- exact one-shot exec capture and path-mapping helpers for future SSH-aware consumers

In this vault, `pi-ssh/lib/pi-ssh-session-runtime.ts` provides that contract.

When debugging, `PI_SKILL_URI_DEBUG=1` emits stage decision logs and should usually be paired with `PI_SSH_DEBUG=1` so the remote file probes behind each cache-hit or cache-miss are visible too.

## Non-goals

- no pi core changes
- no separate user-facing `skill://local/...` or `skill://remote/...` formats
- no independent skill filesystem discovery that could drift from pi core
