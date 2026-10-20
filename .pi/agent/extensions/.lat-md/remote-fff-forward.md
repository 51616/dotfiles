# remote-fff-forward

This extension routes FFF path/content search through the active `pi-ssh` session so `fffind` and `ffgrep` inspect the remote filesystem instead of the local vault.

## Responsibilities

The canonical entrypoint is [[remote-fff-forward/index.ts]]. It registers SSH-aware `fffind` and `ffgrep` overrides only when `--ssh` is active or `pi-ssh` has published a session.

Without SSH state, it stays inert. In SSH mode, it re-registers on session start so the remote override wins over local `@ff-labs/pi-fff` tool registration.

The extension also registers `/remote-fff-health` and `/remote-fff-restart` for operator checks. The health command probes the active worker and native FFF state; restart drops the cached worker so the next search restages and relaunches it.

## Runtime boundary

[[remote-fff-forward/lib/remote-runtime.ts]] owns remote runtime discovery and worker staging. It uses the shared `PiSshSession` exact-capture/write-file boundary.

It loads remote `nvm` when present, discovers `node` and `npm root -g`, then runs `buildFffNodeResolveScript()` against the global `@ff-labs/fff-node` package. That script reads the entry file from the package's own `package.json` `exports` map (never a hardcoded `dist/...` path), rejects versions older than `MIN_FFF_NODE_VERSION` (0.11.0) with an install hint, loads the native library, and prints the entry. Setup then stages [[remote-fff-forward/remote/worker.mjs]] under `~/.cache/pi/remote-fff-forward/<worker version>/`.

The remote worker imports the absolute global `fff-node` entry because Node ESM does not resolve global npm packages from arbitrary working directories. If remote Node or `@ff-labs/fff-node` is missing or too old, setup fails clearly instead of falling back to local search. Only fff-node 0.11.0 and newer are supported; there is no code path for the older `dist/src/index.js` + `dist/types.js` layout.

## Worker lifecycle

[[remote-fff-forward/lib/manager.ts]] keeps one `RemoteFffWorkerClient` per active SSH target and remote cwd. [[remote-fff-forward/lib/worker-client.ts]] owns the local `ssh -T ... node worker.mjs` child, JSON-lines requests, request timeouts, abort handling, stderr tail reporting, and process teardown.

Workers must not survive normal session shutdown or local client crashes. Normal shutdown calls `manager.dispose()`, which closes the SSH child. A local crash closes the worker stdin through the orphaned SSH process; the remote worker exits on stdin close and also has an idle TTL as a final cleanup guard. The SSH child uses keepalive options so a half-open network path eventually closes instead of leaving a remote worker indefinitely.

## Query and cursor contract

[[remote-fff-forward/lib/query.ts]] adapts `@ff-labs/pi-fff` query construction to accept both local mapped paths and remote absolute paths.

Include/exclude constraints are normalized against the local workspace root and the remote base path so an agent can pass either representation safely.

[[remote-fff-forward/lib/cursors.ts]] uses stateless base64url cursor tokens instead of an in-memory cursor map. This lets grep/find pagination survive worker restarts and keeps the remote worker protocol simple.

The grep token carries fff-node's own `nextCursor` object verbatim. fff-node treats that cursor as opaque and has no public constructor, so neither the worker nor the extension may read or build its fields; they only pass it back. Tokens from the old offset-based format are rejected with an invalid-cursor error. [[remote-fff-forward/lib/format.ts]] preserves the local `pi-fff` output contract: native frecency order, git/frecency annotations, weak fuzzy-match trimming, grep context lines, and terse no-match messages.

## Verification

The proving tests live under `remote-fff-forward/test/`. They cover query normalization, formatting, cursor tokens, the fff-node version gate, local worker stdio including grep pagination, worker reuse, invalid worker output, and abort cleanup.

The local worker test resolves pi's own `@ff-labs/fff-node` copy through the same resolve script the remote probe uses, and fails rather than skips when it is missing. A hardcoded path plus a skip guard previously hid the fff-node 0.11 layout break.

For behavior changes, run `node --test remote-fff-forward/test/*.test.mjs`, the TypeScript no-emit check for `remote-fff-forward/**/*.ts`, `remote-fff-forward/test/live-smoke.mjs` against `gcp_slurm_sakana_eu`, and the pi-ssh shared-runtime regression tests named in [[pi-ssh#Verification]].
