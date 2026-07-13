# pi-ssh extension spec

## Summary

`pi-ssh` keeps pi, model credentials, and provider traffic on the local machine while executing shell and workspace file tools on a remote SSH host. Remote mode is explicit through `--ssh`; without that flag, pi keeps its normal local behavior.

## Goals

- Make normal pi `bash`, `read`, `write`, and `edit` behavior available against a remote workspace.
- Keep SSH setup small: an SSH client locally and standard-library Python remotely.
- Reuse long-lived channels so warm tool calls do not pay repeated SSH startup costs.
- Preserve pi tool output, path, mutation-serialization, image, cancellation, and error contracts.
- Publish one typed SSH session boundary for other extensions instead of duplicating remote logic.
- Keep remote file payloads out of forced-command audit logs while retaining operational metrics.

## Non-goals

- Remote model/provider proxying.
- Caching remote file contents locally.
- Replacing SSH authentication or host configuration.
- Avoiding complete payload upload for overwrite-style `write` calls.
- Hiding missing remote dependencies behind a slower compatibility fallback.

## CLI contract

- `--ssh user@host`
- `--ssh user@host:/absolute/remote/path`
- optional port: `--ssh-port 2222` or `--port 2222`

When the path is absent, pi-ssh resolves the remote login cwd with `pwd`. The status/footer identifies the SSH target and remote cwd. User `!` commands follow the same remote bash route.

## Runtime architecture

### Connection and reusable runtime

SSH commands use OpenSSH multiplexing through `ControlMaster`, `ControlPersist`, and a target-derived control path. A process-local runtime cache retains the active transport across `/new`, `/resume`, and `/fork` when the SSH target, port, local cwd, and remote cwd still match. Reload, quit, failed setup, or a changed target disposes the runtime.

The runtime owns two independent channels:

1. `PersistentRemoteShell`: one PTY-backed login shell for `bash`, `!`, and low-latency text helpers. Its command queue preserves shell environment and output order.
2. `PiSshFileWorkerClient`: one non-PTY `ssh -T` child running the dependency-free Python worker. File requests never enter the bash queue.

A long bash command therefore does not block an independent file request.

### Persistent file protocol

`lib/pi-ssh-file-protocol.ts` owns the local client. `lib/pi-ssh-file-worker.py` owns remote filesystem behavior. `lib/pi-ssh-file-transport.ts` validates worker metadata before exposing it to the session.

Every frame consists of:

1. a 4-byte big-endian JSON-header length;
2. a UTF-8 JSON header;
3. exactly `payloadLength` raw payload bytes.

Protocol version 1 requires a worker hello frame with all required capabilities before requests. Requests and responses carry positive integer IDs. Multiple requests may be in flight and responses may arrive out of order. An incremental head-indexed chunk queue parses large fragmented frames without repeated buffer copies or array shifting. Frame lengths, response kinds, versions, IDs, operation fields, request-range/result coherence, payload byte/line counts, and operation metadata are validated at their boundaries. Unsolicited or duplicate response IDs poison the worker rather than being ignored.

Limits are explicit:

- header: 8 MiB;
- request or response payload: 64 MiB;
- source file read into worker memory: 512 MiB;
- edit diff returned in response metadata: 256 KiB;
- normal pi text read output: 2,000 lines and 50 KiB.

The source-file limit bounds remote memory. Ranged reads still read the source on the remote host to preserve pi's exact line/truncation behavior, but only selected and truncated output crosses SSH. Images require complete transfer.

### Worker startup and dependencies

`index.ts` embeds the Python source in the SSH launch command, resolves `python3` then `python`, and verifies Python 3.9 or newer before evaluating that source. Bootstrap uses remote `base64`; the file-operation payload protocol itself does not.

Remote Python 3.9+ is mandatory and the worker uses only the standard library. Missing/old Python, missing capabilities, invalid protocol versions, malformed frames, and oversized operations fail clearly. There is no legacy one-shot `cat`/base64/edit fallback.

Worker exit or protocol corruption rejects all affected requests and tears down that worker instance. A later request starts one clean new worker. A caller aborted during a shared startup settles immediately without disrupting other waiters; silent startup timeout terminates the SSH child before lazy recovery. Startup and process errors include at most eight retained 2,000-character stderr lines, including a bounded unterminated tail decoded safely across UTF-8 chunks.

## Tool behavior

### `read`

A workspace read is one `read_workspace` request after startup. The request carries path, optional 1-indexed `offset`, optional positive `limit`, and pi's output limits. The worker:

- opens the path once without blocking on special files, validates that exact descriptor as regular with `fstat`, and bounds the subsequent read even if the file grows;
- recognizes PNG, JPEG, GIF, and WebP by signature;
- returns complete bytes for a supported image;
- otherwise decodes as UTF-8 with replacement behavior matching Node, applies offset/limit and pi truncation remotely, and returns only visible text plus metadata.

`skill-uri/lib/remote-workspace-tools.ts` formats continuation notices and sends image bytes through pi's built-in resize/model-attachment path without a second remote read.

### `write`

A workspace write is one `write_file` request after startup. Raw UTF-8 content appears once as the frame payload; it is not base64 encoded. The worker creates parent directories, opens the target with nonblocking semantics, validates the exact descriptor as regular, truncates only after validation, and overwrites it. FIFOs/devices fail without occupying executor threads. The skill-uri adapter wraps pi's per-file mutation queue with abort-aware settlement and a pre-dispatch signal guard, so a queued canceled mutation is never sent.

### `edit`

A workspace edit is one `edit_workspace` request after startup. Only the path, display path, and old/new replacement blocks are sent. The worker reads and validates the file remotely, matches all edits against the same original content, rejects missing/duplicate/empty/overlapping/no-change edits before mutation, and applies replacements in reverse offset order.

Matching preserves pi's existing behavior:

- UTF-8 BOM is ignored for matching and restored;
- dominant CRLF/LF style is detected and restored, with the first observed style breaking ties;
- fuzzy matching normalizes trailing whitespace, smart punctuation, Unicode dashes/spaces, and NFKC text when exact matching fails.

The edited file is replaced atomically while preserving mode bits. The response contains a compact numbered diff, first changed line, and byte counts. The complete old or new file does not cross SSH.

Python `SequenceMatcher(..., autojunk=True)` is used only to generate bounded display diffs; it prevents quadratic behavior on large repeated-line files and does not affect edit matching.

### `bash`

Bash commands stream through `PersistentRemoteShell` and support pi's timeout and abort behavior. If an interrupted or timed-out command never emits its completion marker, pi-ssh resets the PTY shell so later queued commands recover. That reset loses shell-local environment from the old PTY but does not reset the independent file worker.

### Cancellation

An already-aborted file call fails before sending. A caller canceled while the shared worker is starting settles immediately. A request canceled while waiting for the per-file mutation queue or local frame-write queue is skipped and never reaches the worker. Cancellation during a partial frame write resets the channel because the framing boundary is no longer trustworthy. After a complete send, abort settles the caller and retains a bounded response-ID tombstone so a late response can be discarded safely; a request timeout resets the worker because channel health is unknown. A mutation already started remotely may still finish, matching the practical cancellation limit of local filesystem APIs.

## Shared SSH session contract

`lib/pi-ssh-session-runtime.ts` publishes the active `PiSshSession`. It provides:

- `readWorkspaceFile()`, `writeWorkspaceFile()`, and `editWorkspaceFile()` for high-level workspace tools;
- exact worker-backed `readFile()` and `writeFile()` for remote skill staging;
- `createBashOps()` for remote command execution;
- deterministic local cwd/home to remote cwd/home path mapping;
- remote staging context (`remoteHome` and transport);
- exact `execCapture()`, PTY-oriented `execText()`, `repoRoot()`, `exists()`, and `stat()` helpers.

`skill-uri` owns normal workspace tool routing because it must keep canonical `skill://...` paths local while sending non-skill paths through the active session. It registers a lifecycle-scoped router token and removes it on session shutdown. SSH mode refuses to initialize without a current token, preventing remote bash from silently coexisting with local workspace mutations. Other extensions consume this same session rather than building ad hoc SSH commands.

`repoRoot()` requires remote `git`. `stat()` requires remote Python and deliberately uses exact capture rather than PTY text output.

## Forced-command logger contract

A `*-pi-agent` key may force `scripts/pi-ssh-logger.remote.sh`. The wrapper must:

- preserve generic command stdout, stderr, and child exit status;
- recognize the file-worker marker `PI_SSH_FILE_WORKER_PROTOCOL=1; export PI_SSH_FILE_WORKER_PROTOCOL; ` and require the complete command's SHA-256 to match the production launcher hash rendered at installation;
- reject marker-prefixed lookalikes without executing or logging their raw command;
- bypass stream logging for transfer protocols only when a fixed system SCP/SFTP/rsync executable also matches its server-mode grammar; transfer-name substrings remain fully audited;
- pass worker stdout directly and byte-for-byte without `tee`, `script`, or audit-log copying;
- copy structured worker stderr into the audit log while preserving it on stderr;
- record only a safe worker command label, not the embedded worker source.

The worker logs `worker.ready`, request ID, operation, path, status, duration, request/response payload bytes, and filesystem read/write byte counts to stderr. It never logs raw payloads.

`scripts/pi-ssh-logger-setup.sh` uses local Node to derive the current production launcher, hashes it with `sha256sum`, renders the wrapper template, backs up and installs it, then verifies generic success/failure semantics by launching the real worker. The probe fetches its audit log and proves the hello frame is absent while `worker.ready` stderr is present. Setup requires local and remote `sha256sum`; an unrendered template and hash mismatches fail closed. Install this wrapper on every new forced-command SSH alias before using the file worker, and reinstall after launcher/source changes.

## Safety and errors

- Remote mode requires an explicit `--ssh` target.
- SSH authentication is delegated to OpenSSH; pi-ssh does not forward model credentials.
- Workspace paths are normalized and must become absolute before worker filesystem access.
- File requests fail closed on invalid protocol or malformed operation metadata.
- Filesystem errors identify missing paths, non-regular files, permission failures, and size limits.
- `PI_SSH_DEBUG=1` exposes lifecycle, request IDs, operation names, and byte counts locally without payload data.
- Remote prompt-context loading from exact `remoteCwd/AGENTS.md` or `CLAUDE.md` is high-trust and should only target trusted workspaces.

## Verification contract

The extension suite must cover:

- out-of-order response routing, startup/queued/sent/partial-write aborts, startup child termination, stream errors, bounded unterminated stderr, capability errors, fragmented large frames, unsolicited/duplicate responses, malformed frames, worker exit, lazy restart, and size limits;
- ranged transfer bounds and request/result coherence, one-open regular-file validation, read/write FIFO rejection and pool recovery, image signatures, exact raw writes, large-file remote edits, BOM/dominant-line-ending/fuzzy matching including lone-CR ties, multi-edit success, invalid-edit atomicity, concurrency, and structured logs;
- file-call independence from the bash queue and signal/path forwarding;
- forced logger stdout privacy, stderr observability, exit status, exact launcher-hash enforcement, worker/transfer lookalike rejection, legitimate live SCP behavior, and setup behavior.

The skill-uri suite must cover tool-level notices/images, one-request writes/edits, mutation serialization, path mapping, and unchanged local/skill behavior. Live rollout requires logger installation, `/reload`, a temporary remote write/read/edit/read scenario, benchmark evidence, and vault health checks.
