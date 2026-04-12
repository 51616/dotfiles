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
- defaults to `remote` when a remote backend is active, otherwise `local`
- stages the local skill root to `~/.cache/pi/skill-stage/...` before remote execution
- skips obvious local-only or sensitive paths during staging
- rejects staged payloads above 10 MiB

## Backend contract

`skill-uri` can use an optional backend provider registered on runtime state.

A provider supplies:
- read / write / edit operation builders for non-skill workspace paths
- bash operations for remote command execution
- remote staging context (`remoteHome` + `transport`) for `run_skill_script`

In this vault, `pi-ssh` provides that backend.

## Non-goals

- no pi core changes
- no separate user-facing `skill://local/...` or `skill://remote/...` formats
- no independent skill filesystem discovery that could drift from pi core
