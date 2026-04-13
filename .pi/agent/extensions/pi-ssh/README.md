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

## Notes

- Absolute paths are strongly recommended for the remote path.
- Paths under local `$HOME` are mapped to remote `$HOME` in SSH mode (for example `~/.config/...`).
- On session start, `pi-ssh` checks only the resolved `remoteCwd` for `AGENTS.md`, then `CLAUDE.md`. It does not walk parent or child directories.
- When one of those files is found, its contents are cached once for the session and injected into the system prompt using the same project-context file format local pi uses.
- Remote prompt-context loading is high-trust. If the remote workspace is not trusted, do not point `pi-ssh` at it.
- Canonical `skill://...` handling now lives in the separate `skill-uri` extension so the same skill interface works in both local and SSH sessions.
- `pi-ssh` registers the active remote backend used by `skill-uri` for non-skill workspace paths and for remote `run_skill_script` staging/execution.
- When the SSH backend is active, normal workspace `read`/`write`/`edit` calls go remote, while `skill://...` paths still resolve against the local skill source managed by `skill-uri`.
- The pi-managed remote shell disables shell history so wrapper commands do not flood your normal `bash`/`zsh` history.
- If you need remote audit logs, connect through a server setup that already logs SSH sessions, such as a `*-pi-agent` alias created with the separate `pi-ssh` logger workflow.
- If `--ssh` is not set, extension falls back to local tool behavior.
- Current version focuses on remote workspace tool execution (`bash` directly, and `read`/`write`/`edit` through the `skill-uri` backend contract).

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

## Development

- Spec: `extension-spec.md`
- Extension entry: `index.ts`

## License

MIT
