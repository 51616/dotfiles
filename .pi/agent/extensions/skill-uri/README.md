# skill-uri

`skill-uri` makes `skill://<skill-name>/...` the canonical skill resource interface for pi.

It works in both local sessions and remote-backed sessions such as `pi-ssh`, without any pi core changes.

## What it owns

- rewrite `<available_skills>` prompt locations to `skill://...`
- detect duplicate skill names across all discovered skills and warn when the last entry overrides earlier ones
- resolve `skill://...` paths for `read`, `write`, and `edit`
- guard against traversal and symlink escapes from skill roots
- provide `run_skill_script` for executing any file relative to a skill root

## Source precedence

`skill-uri` uses the already-discovered `<available_skills>` prompt block as the source of truth.

If the same skill name appears multiple times, the last entry wins. The extension rewrites the prompt to keep only the winning entry and emits a warning.

This means overlapping names from:
- `~/.pi/agent/skills`
- `.pi/skills`
- other discovered skill sources already known to pi

all follow the same rule without reimplementing pi core discovery.

## Remote behavior

`skill-uri` does not implement remote transport itself.

A remote-capable extension can register a backend provider. In this vault, `pi-ssh` does that. When such a backend is active:
- non-skill workspace reads/writes/edits are delegated to the remote backend
- `skill://...` paths still resolve to the local skill source
- `run_skill_script` stages the local skill root remotely and executes the requested file there automatically

## `run_skill_script`

`run_skill_script` accepts any file relative to the skill root.

It no longer accepts an explicit execution `target`. Skills always resolve from the local machine. Execution follows the active backend automatically:
- no remote backend: execute locally
- remote backend active: stage locally-sourced skill files to the remote host, then execute there

Examples:
- `skill://pi-ssh/scripts/pi-ssh-setup.sh`
- `skill://my-skill/tools/bootstrap.py`
- `skill://my-skill/bin/run`

Relative paths like `scripts/demo.sh` are rejected. Use the full `skill://...` URI.
