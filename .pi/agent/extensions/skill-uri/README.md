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

In this vault, `pi-ssh` publishes one canonical SSH session contract at `pi-ssh/lib/pi-ssh-session-runtime.ts`. `skill-uri` registers itself as the lifecycle-scoped workspace file router and unregisters on session shutdown. `pi-ssh` deliberately refuses SSH mode when this registration is absent; both extensions must be installed and enabled so remote bash can never coexist with accidental local file mutations.

When an active `pi-ssh` session exists:
- non-skill workspace reads/writes/edits use the session's high-level persistent file-worker methods
- one ranged read, raw write, or remote edit becomes one logical worker request after startup
- read continuation notices and image attachments keep pi's built-in UX through `lib/remote-workspace-tools.ts`
- writes and edits to the same path remain serialized through pi's mutation queue; an abort while waiting settles promptly and prevents later dispatch
- `skill://...` paths still resolve to the local skill source and never use the remote workspace worker
- `run_skill_script` stages the local skill root remotely and executes the requested file there automatically

There is no slow operation-builder fallback. If the active SSH worker or required remote Python 3.9+ is unavailable, the workspace tool fails with the pi-ssh diagnostic.

## `run_skill_script`

`run_skill_script` accepts any file relative to the skill root.

It no longer accepts an explicit execution `target`. Skills always resolve from the local machine. Execution follows the active `pi-ssh` session automatically:
- no active `pi-ssh` session: execute locally
- active `pi-ssh` session: stage locally-sourced skill files to the remote host, then execute there

Examples:
- `skill://pi-ssh/scripts/pi-ssh-setup.sh`
- `skill://my-skill/tools/bootstrap.py`
- `skill://my-skill/bin/run`

Relative paths like `scripts/demo.sh` are rejected. Use the full `skill://...` URI.

## Debugging remote staging

Set `PI_SKILL_URI_DEBUG=1` to emit staging traces to stderr.

Key events:
- `resolve-run-skill-script-request`
- `stage-local-skill-root-to-remote.begin`
- `stage-local-skill-root-to-remote.cache-hit`
- `stage-local-skill-root-to-remote.cache-miss`
- `stage-local-skill-root-to-remote.staged`
- `prepare-run-skill-script.remote`

When debugging with `pi-ssh`, pair it with `PI_SSH_DEBUG=1` so you can see the remote file probes and writes that back the stage logic.

If `skill-uri` says a remote stage is a cache hit but the later remote `bash` call says the staged script is missing, do not assume permissions first. Check the remote SSH wrapper semantics first. A broken forced-command logger can make missing-file probes look successful by mangling stdout, stderr, or exit codes.

For a fresh remote re-stage during debugging, remove the relevant cache subtree and retry:

```bash
ssh user@host-pi-agent 'rm -rf ~/.cache/pi/skill-stage/<skill-name>'
```
