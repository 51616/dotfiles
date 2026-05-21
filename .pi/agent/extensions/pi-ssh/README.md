# pi-ssh

Run pi locally, work on files remotely over SSH.

`pi-ssh` is a pi extension that gives you a Cursor-like remote SSH workflow:

- pi runs on your local machine
- model access, API keys, and billing stay local
- `read`, `write`, `edit`, and `bash` run on a remote host via SSH

## Why

This is useful when:

- your code/checkouts live on a VM
- your model/tooling access is easier locally
- you want one local account to drive many remote workspaces

## Features

- `--ssh user@host` or `--ssh user@host:/remote/path`
- optional port: `--ssh-port 2222` (alias: `--port 2222`, default: `22`)
- Remote tool delegation for:
  - `read`
  - `write`
  - `edit`
  - `bash`
- SSH connection multiplexing (`ControlMaster`/`ControlPersist`) for faster repeated tool calls
- SSH runtime reuse across `/new`, `/resume`, and `/fork` session replacement without reconnecting
- Persistent remote shell session for bash commands
  - uses your remote account's configured login shell (for example zsh)
  - environment persists across commands (for example `export TEST=123`)
  - Ctrl-C interrupts the current remote command
  - if an interrupted or timed-out command never prints its completion marker, pi-ssh force-resets the remote shell so the session recovers instead of hanging forever
- Remote execution for user `!` commands
- Status indicator in the pi UI when SSH mode is active
- System prompt cwd rewrite to reflect remote cwd
- Remote prompt-context pickup from `remoteCwd/AGENTS.md` or `remoteCwd/CLAUDE.md` (exact directory only; `AGENTS.md` wins)

## Requirements

- SSH client installed locally
- Passwordless SSH auth recommended (keys/agent)
- Remote host with:
  - a standard login shell (for example `zsh` or `bash`)
  - `base64`, `cat`, `grep`, `mkdir`, `pwd`, `test`, `tr`
  - `git` if consumers use the shared `PiSshSession.repoRoot()` helper
  - `python3` or `python` if consumers use the shared `PiSshSession.stat()` helper
  - optional: `file` (for image mime detection)

## Install

### Option A: project-local extension

```bash
mkdir -p .pi/extensions
cp /path/to/pi-ssh/index.ts .pi/extensions/pi-ssh.ts
```

Then start pi in your project and pass `--ssh`.

### Option B: global extension

```bash
mkdir -p ~/.pi/agent/extensions
cp /path/to/pi-ssh/index.ts ~/.pi/agent/extensions/pi-ssh.ts
```

## Usage

### Use remote host default cwd

```bash
pi --ssh user@my-vm
# same, explicit default
pi --ssh user@my-vm --ssh-port 22
```

### Use explicit remote workspace path

```bash
pi --ssh user@my-vm:/home/user/chromium/src
# custom port
pi --ssh user@my-vm:/home/user/chromium/src --port 2222
```

You should see a status line similar to:

```text
SSH user@my-vm:/home/user/chromium/src (port 22)
```

## Typical workflow

1. Start pi locally with `--ssh ...`
2. Ask pi to inspect/edit files as usual
3. All tool operations run remotely
4. Keep local model switching, auth, and limits as usual

## Logger setup

Some hosts use a dedicated `*-pi-agent` SSH key that forces a remote logger wrapper through `authorized_keys`.

That wrapper must preserve three things for noninteractive commands:
- stdout stays on stdout
- stderr stays on stderr
- the real command exit status is returned unchanged

If it breaks those semantics, `pi-ssh` one-shot reads and writes can mis-detect missing files as successful reads. That in turn can confuse `skill-uri` remote staging.

Use the setup helper in this extension to install or repair the wrapper:

```bash
bash ~/.pi/agent/extensions/pi-ssh/scripts/pi-ssh-logger-setup.sh \
  --host user@host-pi-agent
```

The helper uploads `scripts/pi-ssh-logger.remote.sh`, backs up the existing remote wrapper, installs the new one, and verifies the SSH alias semantics.

## Notes

- Absolute paths are strongly recommended for the remote path.
- Paths under local `$HOME` are mapped to remote `$HOME` in SSH mode (for example `~/.config/...`).
- On session start, `pi-ssh` checks only the resolved `remoteCwd` for `AGENTS.md`, then `CLAUDE.md`. It does not walk parent or child directories.
- When one of those files is found, its contents are cached once for the session and injected into the system prompt using the same project-context file format local pi uses.
- Remote prompt-context loading is high-trust. If the remote workspace is not trusted, do not point `pi-ssh` at it.
- Canonical `skill://...` handling now lives in the separate `skill-uri` extension so the same skill interface works in both local and SSH sessions.
- `pi-ssh` publishes the active SSH session through `pi-ssh/lib/pi-ssh-session-runtime.ts`.
- `pi-ssh` keeps the active SSH runtime in a process-local cache while pi replaces sessions for `/new`, `/resume`, and `/fork`; `/reload`, quit, failed setup, or a changed SSH target disposes it cleanly.
- `skill-uri`, `self-checkpointing`, and `pi-diff-review-*` consume that session directly for remote workspace ops, remote diff inspection, local staged editor flows, `run_skill_script` staging/execution, and SSH-backed checkpoint probing.
- Consumers that need SSH repo identity should use the shared `resolveActivePiSshRepoIdentity(localCwd)` helper instead of doing ad hoc late `session.repoRoot(...)` lookups. That helper caches the resolved remote repo root for the active session and preserves SSH-specific failures instead of masking them as local fallback behavior.
- The shared session helpers currently assume `git` is present for `repoRoot()` and `python3` or `python` is present for `stat()`.
- `PiSshSession.execText()` is the shared low-latency text-command path backed by the persistent remote shell. Use it for git/text workflows where combined PTY output is acceptable.
- `PiSshSession.stat()` still uses stdout-only exact capture under the hood so callers do not have to parse PTY noise around JSON payloads.
- Keep exact-byte reads/writes on `execCapture()` or the remote transport.
- When the SSH session is active, normal workspace `read`/`write`/`edit` calls go remote, while `skill://...` paths still resolve against the local skill source managed by `skill-uri`.
- The pi-managed remote shell disables shell history so wrapper commands do not flood your normal `bash`/`zsh` history.
- If you need remote audit logs, connect through a server setup that already logs SSH sessions, such as a `*-pi-agent` alias created with the separate `pi-ssh` logger workflow.
- If `--ssh` is not set, extension falls back to local tool behavior.
- Current version focuses on remote workspace tool execution (`bash` directly, and `read`/`write`/`edit` plus shared SSH helpers through the `pi-ssh` session runtime consumed by `skill-uri` and other extensions).

## Troubleshooting

### "pi-ssh failed to connect"

Check:

```bash
ssh user@host
ssh user@host 'pwd'
```

### Commands work locally but not remotely

Verify remote shell tools exist:

```bash
ssh user@host 'which cat test mkdir pwd'
```

### Slow tool calls

`bash`/`!` and most `read`/`write`/`edit` operations use a shared persistent SSH session.
Very large writes fall back to one-shot SSH streaming for reliability.

If pi-ssh force-resets the persistent shell after an interrupt or timeout, shell-local state from that shell session is lost. Normal non-interrupted commands still preserve shell state across calls.

Remote `read`/`write`/`edit` one-shot SSH operations honor the tool abort signal too, so cancelling a turn can stop those calls instead of waiting for SSH to exit on its own.

### `skill-uri` staging says files exist, then `bash` says they do not

This is the main cross-extension failure mode to check first.

Run pi with both debug flags enabled:

```bash
PI_SSH_DEBUG=1 PI_SKILL_URI_DEBUG=1 \
pi -ne \
  -e ~/.pi/agent/extensions/pi-ssh/index.ts \
  -e ~/.pi/agent/extensions/skill-uri/index.ts \
  --ssh user@host-pi-agent:/remote/worktree \
  -p "YOUR_TEST_PROMPT_GOES_HERE"
```

What to look for:
- `pi-ssh` prints `resolve-ssh-connection` with the exact `remoteHome` and `remoteCwd`
- `skill-uri` prints `stage-local-skill-root-to-remote.begin`
- `pi-ssh` prints `transport.read-file.*` and `transport.write-file.*` for paths under `~/.cache/pi/skill-stage/...`
- `skill-uri` prints `cache-hit`, `cache-miss`, or `staged`

If `transport.read-file.ok` claims a staged file exists but a later remote `bash` says the same path is missing, suspect the remote forced-command wrapper, not permissions.

Check the SSH alias directly:

```bash
ssh user@host-pi-agent "printf %s ok"
ssh user@host-pi-agent "ls /definitely-missing"
```

Healthy behavior:
- the `printf` command exits `0` and prints only `ok` on stdout
- the `ls` command exits nonzero
- the missing-file message stays on stderr, not stdout

If those checks fail, inspect and repair the remote logger wrapper:

```bash
ssh user@host-pi-agent "grep -n 'command=' ~/.ssh/authorized_keys || true"
ssh user@host-pi-agent "sed -n '1,220p' ~/bin/pi-ssh-logger"
bash ~/.pi/agent/extensions/pi-ssh/scripts/pi-ssh-logger-setup.sh \
  --host user@host-pi-agent
```

### Stale remote skill-stage cache

`skill-uri` stages local skill files under:

```text
~/.cache/pi/skill-stage/<skill>/<content-hash>/...
```

If you want a clean remote re-stage during debugging, remove the skill subtree and retry:

```bash
ssh user@host-pi-agent 'rm -rf ~/.cache/pi/skill-stage/<skill-name>'
```

## Development

- Spec: `extension-spec.md`
- Extension entry: `index.ts`

## License

MIT
