# pi-ssh patch note: fix first remote bash command hanging in persistent SSH shell

Status:
- **Still required locally as of `origin/main` checked on 2026-04-04**
- Upstream `pi-ssh` still prints the first start marker without the leading newline
- Keep this patch until upstream merges an equivalent fix and a real remote `bash pwd` repro passes without it

Patch file:
- `patches/pi-ssh-bash-first-marker-newline.patch`

Extension repo:
- `https://github.com/hjanuschka/pi-ssh`

Local fix commit:
- `b1b486d8978646782a23e2e5fe8a019009d4eb24`
- `fix(ssh): force first shell marker onto a new line`

## Symptom

With `pi --ssh ...` enabled, `read` could work, but `bash` often hung on the first remote command.

Observed in:
- local repo: `~/research/doc-to-lora`
- remote target: `gcp_slurm_sakana_eu-pi-agent:/home/rujikorn_sakana_ai/research/doc-to-lora`

A minimal repro prompt was:

```bash
cd ~/research/doc-to-lora
pi --no-session --thinking off --print --tools bash \
  --ssh gcp_slurm_sakana_eu-pi-agent:/home/rujikorn_sakana_ai/research/doc-to-lora \
  "Use the bash tool exactly once with command pwd. Then respond with the pwd output only."
```

Before the fix, the run printed the SSH-enabled message, emitted a `tool_call` for `bash`, and then stalled until timeout.

## Root cause

`pi-ssh` executes remote bash commands through a persistent interactive SSH shell and delimits each command with markers:
- `__PI_SSH_BEGIN_<id>__`
- `__PI_SSH_DONE_<id>__:<exitcode>`

The parser in `index.ts` expects the start marker to appear at the start of a line, matched by:

```ts
/(^|\n)__PI_SSH_BEGIN_...(?=\n|$)/
```

On the first command in a fresh SSH PTY session, the remote login prompt is still on screen. The shell printed output like:

```text
rujikorn_sakana_ai@slurm0-login-001:~$ __PI_SSH_BEGIN_<id>__
/home/rujikorn_sakana_ai/research/doc-to-lora

__PI_SSH_DONE_<id>__:0
```

That means the start marker is appended to the login prompt line instead of starting a new line. The parser never recognizes the start marker, so:
- incremental output streaming never starts
- command completion is never detected
- the promise returned by the remote bash exec never resolves
- the SSH command queue stays blocked behind that command

This is why the agent appeared to hang specifically on `bash`.

## Why `read` behaved differently

`read` uses one-shot SSH execution for file reads, not the persistent PTY shell used by `bash`. So the marker parsing bug mainly affected `bash` and other PTY-shell-backed operations.

## Fix

Change the start marker print from:

```ts
`printf '${startMarker}\\n'`
```

to:

```ts
`printf '\\n${startMarker}\\n'`
```

This forces the first command marker onto a fresh line even when the login prompt has just been emitted.

## Why this fix is minimal and correct

The parser already expects markers to begin at line start. Changing the printed marker format is safer than weakening the parser, because:
- it keeps the marker grammar strict
- it avoids accidental marker matches inside ordinary command output
- it fixes the exact PTY/login-prompt edge case without changing the rest of the command framing logic

## Verification

### 1) Direct bash-tool repro

After the fix, the same repro completed successfully and returned:

```text
/home/rujikorn_sakana_ai/research/doc-to-lora
```

### 2) End-to-end remote read + bash probe

A remote-only probe file was created on the SSH host, then `pi --ssh ...` was asked to:
- `read` that file
- run `bash pwd`

Observed output after the fix:

```text
CONTENT:PI_SSH_FIXED_PROBE_<timestamp>
PWD:/home/rujikorn_sakana_ai/research/doc-to-lora
```

That confirms both:
- remote file access works
- remote bash execution now completes instead of hanging

## Files involved

Primary fix location:
- `index.ts`

Relevant logic:
- `PersistentRemoteShell.execOne(...)`
- `parseDelimitedShellOutput(...)`
- `streamIncremental(...)`

## Upstream status

As of local verification against `origin/main`, upstream still has:

```ts
`printf '${startMarker}\\n'`
```

while the local fixed version has:

```ts
`printf '\\n${startMarker}\\n'`
```

So this patch is still local-only and should not be dropped yet.

## Relationship to the earlier pi-mono bug

This patch is separate from the earlier `pi-mono` flag-bootstrap fix.

- The `pi-mono` bug prevented `--ssh` from reaching the live extension runtime at all.
- This `pi-ssh` bug affected remote bash execution after SSH mode was already enabled.

Both fixes were needed for a clean end-to-end `pi --ssh ...` workflow.
