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
- SSH connection multiplexing (`ControlMaster`/`ControlPersist`) for faster startup and auxiliary commands
- SSH runtime reuse across `/new`, `/resume`, and `/fork` session replacement without reconnecting
- A persistent non-PTY file worker, separate from bash:
  - ranged text reads select and truncate remotely before transfer
  - writes send raw UTF-8 bytes once, without base64 expansion
  - edits validate and apply replacement blocks remotely and return only a bounded diff
  - concurrent request IDs allow independent file calls to overlap
  - worker failures fail clearly, terminate timed-out startup processes, and restart lazily on the next request
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
- Both the `pi-ssh` and `skill-uri` extensions installed and enabled. `skill-uri` owns workspace file-tool routing; SSH mode fails closed if it is absent so a remote shell can never silently coexist with local file mutations.
- Passwordless SSH auth recommended (keys/agent)
- Remote host with:
  - a standard login shell (for example `zsh` or `bash`)
  - Python 3.9 or newer exposed as `python3` or `python`; this is mandatory for workspace file operations and `PiSshSession.stat()`
  - `base64` for the one-time dependency-free worker bootstrap
  - normal shell utilities such as `grep`, `pwd`, `test`, and `tr` for bash/session helpers
  - `git` if consumers use the shared `PiSshSession.repoRoot()` helper

The worker uses only the Python standard library and installs nothing remotely. Missing or older Python is a hard error; pi-ssh does not fall back to the old multi-command file path. The optional forced-command logger setup additionally requires local Node and `sha256sum`, plus `sha256sum` in the remote forced-command environment.

## Install

### Option A: project-local extension

```bash
mkdir -p .pi/extensions/{pi-ssh,skill-uri}
cp -a /path/to/pi-ssh/. .pi/extensions/pi-ssh/
cp -a /path/to/skill-uri/. .pi/extensions/skill-uri/
```

Copy both whole packages. `pi-ssh/index.ts` loads `lib/pi-ssh-file-worker.py`, while `skill-uri` registers the local/remote workspace router. Then start pi in your project and pass `--ssh`.

### Option B: global extension

```bash
mkdir -p ~/.pi/agent/extensions/{pi-ssh,skill-uri}
cp -a /path/to/pi-ssh/. ~/.pi/agent/extensions/pi-ssh/
cp -a /path/to/skill-uri/. ~/.pi/agent/extensions/skill-uri/
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

It must also recognize the `PI_SSH_FILE_WORKER_PROTOCOL=1` marker and verify the complete launcher command against the SHA-256 rendered at installation. Only that exact command may use the payload-private branch; marker lookalikes fail closed. Legitimate SCP/SFTP/rsync server commands bypass stream logging only through a fixed executable and server-mode grammar. Executable or argument substrings such as `sftp-server-lookalike` are ordinary audited commands.

Worker stdout is the binary framed protocol and must bypass audit payload logging unchanged. Structured worker stderr remains logged. Copying worker stdout into the audit log leaks file contents and adds heavy NFS writes, even if `tee` happens to preserve the frame bytes.

Use the setup helper in this extension to install or repair the wrapper:

```bash
bash ~/.pi/agent/extensions/pi-ssh/scripts/pi-ssh-logger-setup.sh \
  --host user@host-pi-agent
```

The helper derives the current production launcher, renders its SHA-256 into `scripts/pi-ssh-logger.remote.sh`, uploads and backs up the wrapper, then verifies normal stdout/stderr/exit semantics plus a real worker hello frame and audit privacy. Run it on each new machine or SSH alias whose forced command uses this logger, and rerun it whenever the embedded worker launcher changes. Setup fails rather than installing an unhashed template.

## Notes

- Absolute paths are strongly recommended for the remote path.
- Paths under local `$HOME` are mapped to remote `$HOME` in SSH mode (for example `~/.config/...`).
- On session start, `pi-ssh` checks only the resolved `remoteCwd` for `AGENTS.md`, then `CLAUDE.md`. It does not walk parent or child directories.
- When one of those files is found, its contents are cached once for the session and injected into the system prompt using the same project-context file format local pi uses.
- Remote prompt-context loading is high-trust. If the remote workspace is not trusted, do not point `pi-ssh` at it.
- Canonical `skill://...` handling and workspace file routing live in the required companion `skill-uri` extension so the same skill interface works in both local and SSH sessions. Its registration is scoped to the extension lifecycle and removed on shutdown/reload.
- `pi-ssh` publishes the active SSH session through `pi-ssh/lib/pi-ssh-session-runtime.ts`.
- `pi-ssh` keeps the active SSH runtime in a process-local cache while pi replaces sessions for `/new`, `/resume`, and `/fork`; `/reload`, quit, failed setup, or a changed SSH target disposes it cleanly.
- `skill-uri`, `self-checkpointing`, and `pi-diff-review-*` consume that session directly for remote workspace ops, remote diff inspection, local staged editor flows, `run_skill_script` staging/execution, and SSH-backed checkpoint probing.
- Consumers that need SSH repo identity should use the shared `resolveActivePiSshRepoIdentity(localCwd)` helper instead of doing ad hoc late `session.repoRoot(...)` lookups. That helper caches the resolved remote repo root for the active session and preserves SSH-specific failures instead of masking them as local fallback behavior.
- The shared session helpers currently assume `git` is present for `repoRoot()` and `python3` or `python` is present for `stat()`.
- `PiSshSession.execText()` is the shared low-latency text-command path backed by the persistent remote shell. Use it for git/text workflows where combined PTY output is acceptable.
- `PiSshSession.stat()` still uses stdout-only exact capture under the hood so callers do not have to parse PTY noise around JSON payloads.
- Consumers should use `readWorkspaceFile()`, `writeWorkspaceFile()`, and `editWorkspaceFile()` for normal workspace tools. Exact staging bytes use `readFile()` and `writeFile()` on the same worker-backed transport.
- The protocol caps headers at 8 MiB and payloads at 64 MiB. Workspace source reads cap at 512 MiB, returned diffs at 256 KiB, retained worker diagnostics at eight 2,000-character lines, and normal text output at pi's 2,000-line/50 KiB limits. Oversized operations fail explicitly.
- Reads and writes open a target without blocking, validate the exact descriptor as a regular file, and reject FIFOs/devices. This prevents special files from consuming the worker's finite request pool.
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

`bash`/`!` use one persistent PTY shell. `read`/`write`/`edit` use a different persistent non-PTY worker, so a long bash command does not block file calls. The first file call pays worker startup; warm file calls send one logical request each.

Run with `PI_SSH_DEBUG=1` and look for `file-worker.worker.start`, `file-worker.worker.ready`, `file-worker.request.begin`, and `file-worker.request.end`. Repeated `worker.start` events indicate the remote process is exiting or the runtime is being recreated.

If pi-ssh force-resets the persistent shell after an interrupt or timeout, shell-local state from that shell session is lost. The file worker is independent. Cancellation during worker startup settles that caller immediately; a silent startup is forcibly terminated at the startup deadline. A canceled request still queued locally—including one waiting for pi's per-file mutation queue—is never sent. Cancellation during a partial frame write resets the worker; cancellation after a complete send settles the caller and discards the bounded late response by ID. A sent request timeout resets the worker because channel health is unknown. A mutation already started remotely may still finish.

### File operations report that Python is missing

Install Python 3.9 or newer on the remote host or expose an existing interpreter as `python3` or `python` in the forced-command environment:

```bash
ssh user@host 'py=$(command -v python3 || command -v python) && "$py" -c "import sys; print(sys.version); raise SystemExit(sys.version_info < (3, 9))"'
```

There is deliberately no legacy fallback. A fallback would reintroduce redundant SSH round trips and full-file edit transfers.

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
