# pi-mono patch note: preserve extension CLI flags across runtime bootstrap

Status:
- **Superseded upstream in `pi-mono v0.65.0` and later**
- Keep this note for historical context and for older checkouts only
- Do **not** re-apply this patch on top of `v0.65.0+` unless a fresh regression proves the issue is back

Patch file:
- `patches/pi-mono-extension-flag-bootstrap.patch`

Canonical upstream repo:
- `https://github.com/badlogic/pi-mono`

Likely regression commit:
- `d86122cbd3d981e3a882d511de91e368c855d4ce`
- `refactor(coding-agent): add runtime host for session switching closes #2024`
- date: `2026-03-31`

Feature introduction commit (working baseline):
- `c956a726ed4ccfe1a22940764945bd780afc293d`
- `feat(coding-agent): add hook API for CLI flags, shortcuts, and tool control`
- date: `2026-01-03`

## Why this patch was needed

`pi-ssh` relies on extension CLI flags:
- `--ssh`
- `--ssh-port`

The extension activates in `session_start` by calling `pi.getFlag("ssh")` and `pi.getFlag("ssh-port")`.

In current `pi-mono`, the CLI does parse those flags, but the parsed values are written into an early startup extension runtime that is later discarded. The live runtime created by `createAgentSessionRuntime()` rebuilds the resource loader and extension runtime, but it does not inherit the parsed extension flag values.

Result:
- `pi.getFlag("ssh")` is `undefined` in the live extension instance
- `pi-ssh` never enters SSH mode
- `read`, `write`, `edit`, and `bash` silently stay local

This also affects any other extension that depends on `pi.registerFlag(...)` plus `pi.getFlag(...)` during the real session runtime.

## Observed symptom from investigation

In a clean repo outside the vault (`~/research/doc-to-lora`), with a real reachable SSH host:

- a remote-only probe file was created under `/home/rujikorn_sakana_ai/research/doc-to-lora`
- the local repo did not contain that file
- running `pi --ssh gcp_slurm_sakana_eu-pi-agent:/home/rujikorn_sakana_ai/research/doc-to-lora ...` still produced:
  - local `pwd`: `/home/tan/research/doc-to-lora`
  - local `ENOENT` for the remote-only file

That proves the extension loaded but never switched the tool transport to SSH.

A minimal debug extension confirmed the root cause:
- register a custom flag
- log `pi.getFlag(...)` in `session_start`
- run `pi --myflag hello ...`
- the live extension saw `undefined`

## How the bug came into existence

### Before `d86122cb` (working)

The old startup flow in `packages/coding-agent/src/main.ts` was effectively:

1. load extensions early
2. collect extension flags
3. parse CLI again with those flags
4. store parsed values in `extensionsResult.runtime.flagValues`
5. pass the same `resourceLoader` / extension runtime into `createAgentSession(...)`

Because the same extension runtime was used for the actual session, the live extension could read the parsed flag values.

### After `d86122cb` (broken)

The runtime-host refactor changed startup to:

1. load extensions early
2. collect extension flags
3. parse CLI again with those flags
4. store parsed values in the startup `extensionsResult.runtime.flagValues`
5. build a new runtime via `createAgentSessionRuntime(...)`
6. `createAgentSessionRuntime(...)` creates a fresh `DefaultResourceLoader`
7. `resourceLoader.reload()` creates a fresh extension runtime
8. parsed extension flag values are not copied into that fresh runtime

So the CLI parser still works, but the live extension runtime loses the values.

## What this patch changes

It threads parsed extension flag values through the runtime bootstrap boundary.

Touched files:
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/test/agent-session-runtime-events.test.ts`

### 1) `main.ts`

`buildRuntimeBootstrap(...)` now stores:
- `extensionFlagValues: new Map(parsed.unknownFlags)`

This freezes the parsed extension flag values into the bootstrap object used by the runtime host.

### 2) `agent-session-runtime.ts`

Adds a bootstrap field:
- `extensionFlagValues?: Map<string, boolean | string>`

After the fresh `resourceLoader.reload()` call, the patch copies those values into:
- `extensionsResult.runtime.flagValues`

That restores the contract expected by `pi.getFlag(...)` in the live extension instance.

### 3) Regression test

Adds a runtime-level regression test proving that:
- an extension registers `my-flag`
- bootstrap carries `my-flag=hello`
- the live extension sees `pi.getFlag("my-flag") === "hello"` during `session_start`

## Why this is the right layer

This is a core bootstrap bug, not a `pi-ssh` bug.

`pi-ssh` does not need a workaround. The correct behavior is:
- CLI parses extension flags once
- runtime replacement preserves those values for the live extension runtime

This is also unrelated to the `activity-block` transcript-mode patches. Those patches touch turn lifecycle and interactive transcript rendering. This bug is specifically about extension flag propagation across runtime bootstrap.

## Upstream status

As of verification against GitHub tag `v0.65.0`, `pi-mono` already carries the relevant behavior by a different implementation:

- `packages/coding-agent/src/main.ts` passes `extensionFlagValues: parsed.unknownFlags`
- `packages/coding-agent/src/core/agent-session-services.ts` applies those values into the live extension runtime via `extensionsResult.runtime.flagValues`

That means the old patch file no longer applies cleanly, but the underlying fix is already present.

## Apply

Only for older `pi-mono` versions that still exhibit the lost-extension-flag bug.

From the `pi-mono` repo root:

```bash
git apply /home/tan/.pi/agent/extensions/pi-ssh/patches/pi-mono-extension-flag-bootstrap.patch
```

## Verification

Recommended checks after applying:

```bash
cd /home/tan/research/pi-mono/packages/coding-agent
npx vitest --run test/agent-session-runtime-events.test.ts
```

And end-to-end:

```bash
cd ~/research/doc-to-lora
pi --ssh gcp_slurm_sakana_eu-pi-agent:/home/rujikorn_sakana_ai/research/doc-to-lora
```

Expected after fix:
- `pi-ssh` shows an SSH-enabled status line
- remote-only files become readable through `read`
- `bash pwd` returns the remote cwd

## Notes

This note and patch were generated without modifying the current `pi-mono` working tree, because that tree already contains unrelated local changes.
