---
name: pi-ssh
description: Set up a dedicated SSH key for pi access, install server-side session logging (forced command), and provide log reading helpers.
---

# pi-ssh

This skill is the playbook for giving pi (or any automation) **interactive SSH access with audit logs**, without creating a new Unix user.

Core idea:
- Generate a **dedicated keypair** per host (or per trust domain).
- Add that public key to `~/.ssh/authorized_keys` on the server with restrictions:
  - `no-agent-forwarding`
  - `no-X11-forwarding`
  - `command=".../pi-ssh-logger"` (forced command wrapper)
- The forced command starts a login shell wrapped by `script(1)` so sessions are recorded.

Important limitations (read this so you don’t fool yourself):
- If pi logs in as **your normal Unix user**, it can still do anything that user can. Logging is *audit*, not a sandbox.
- SCP/SFTP/rsync are **not logged** by this method (we bypass them to avoid breaking file transfer protocols).
- Reading/listing logs over SSH creates more logs (because that itself is an SSH session).

## Recommended default policy for the “pi key”

- Keep interactive shell.
- Disable agent + X11 forwarding.
- (Optional) keep port-forwarding enabled if you need VS Code Remote; otherwise also add `no-port-forwarding`.

## One-command setup (local machine)

Use the script in this skill:

```bash
bash ~/.pi/agent/skills/pi-ssh/scripts/pi-ssh-setup.sh \
  --host internal-webserver-001 \
  --key ~/.ssh/pi_internal_webserver_001_ed25519 \
  --comment pi-internal-webserver-001
```

What it does:
1. Creates the keypair (if missing).
2. Installs/updates `~/bin/pi-ssh-logger` on the server.
3. Adds (or replaces) the matching line in `~/.ssh/authorized_keys` with:
   - `command="…/pi-ssh-logger"`
   - `no-agent-forwarding,no-X11-forwarding`
4. Runs a smoke test SSH command and prints the log path.

Prereq: you must already be able to SSH to `--host` using some existing auth, because we need an initial channel to install the new key.

## Operationalize hostnames (make pi always use the pi key)

Recommend using **two SSH host aliases**:
- `<host>`: your normal key (human)
- `<host>-pi-agent`: pi key (forced-command logging enabled on server)

Example SSH config:

```sshconfig
Host internal-webserver-001
  HostName 104.198.121.16
  User rujikorn_sakana_ai
  IdentityFile ~/.ssh/google_compute_engine
  IdentitiesOnly yes

Host internal-webserver-001-pi-agent
  HostName 104.198.121.16
  User rujikorn_sakana_ai
  IdentityFile ~/.ssh/pi_internal_webserver_001_ed25519
  IdentitiesOnly yes
```

This makes it deterministic: pi uses `ssh <host>-pi-agent` and can’t accidentally fall back to your human key.

## Running Slurm GPU jobs via `ssh <host>-pi-agent` (reliable pattern)

Template:

```bash
ssh <host>-pi-agent "bash -lc 'cd ~/research/<repo> && \
  srun -p <gpu_partition> --gres=gpu:1 --cpus-per-task=4 --mem=32G --time=00:15:00 --job-name <name> \
    bash -lc \"cd ~/research/<repo> && uv run python <path>.py\"'"
```

Flow:
- wrap remote command in `bash -lc` (PATH)
- wrap compute-node command in `srun ... bash -lc` (consistent env)

## How to read logs

### List recent logs
```bash
bash ~/.pi/agent/skills/pi-ssh/scripts/pi-ssh-readlog.sh --host internal-webserver-001 --ls
```

### Show the latest log
```bash
bash ~/.pi/agent/skills/pi-ssh/scripts/pi-ssh-readlog.sh --host internal-webserver-001 --latest
```

### Copy the latest log to local disk
```bash
bash ~/.pi/agent/skills/pi-ssh/scripts/pi-ssh-readlog.sh --host internal-webserver-001 --copy-latest ./latest.log
```

## Manual setup (what the scripts do)

### A) Generate a key (local)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/pi_<host>_ed25519 -C "pi-<host>" -N ""
chmod 600 ~/.ssh/pi_<host>_ed25519
chmod 644 ~/.ssh/pi_<host>_ed25519.pub
```

### B) Install the logger script (remote)
Remote path:
- `~/bin/pi-ssh-logger`
- logs: `~/ssh-session-logs/pi/*.log`

The logger uses `script -f` so output is flushed to file (less data loss on disconnect).

### C) Add the forced-command entry (remote)
Example `authorized_keys` line:

```text
command="/home/<user>/bin/pi-ssh-logger",no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... pi-<host>
```

## Troubleshooting notes

- If `scp` breaks with errors like “Received message too long”: your forced-command wrapper is emitting output for scp/sftp sessions. Fix by bypassing `sftp-server`/`scp` in the logger (the provided logger already does this).
- If your SSH command **looks like it hangs at a shell prompt after finishing** (common after running multi-line heredocs): that’s because the logger uses `script(1)` which allocates a PTY, and shells can behave interactively.
  - Prefer single-command invocations: `ssh <host>-pi-agent 'bash -lc "..."'`
- If log files overwrite: include a PID in the filename (the provided logger does this).
- If you want to reduce blast radius further: use `from="x.x.x.x/32"` on the key line (but be ready for IP changes).
