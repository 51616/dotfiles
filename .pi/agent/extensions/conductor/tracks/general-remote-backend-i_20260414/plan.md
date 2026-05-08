# Track Plan: shared pi-ssh session interface

> Status markers: `[ ]` not started, `[~]` in progress, `[x]` done
>
> Use the approved `spec.md` as the behavior contract. Each implementation step should trace back to accepted behaviors and scenario examples.
>
> Implementation should be non-interactive. Resolve ambiguity during audit/spec/plan drafting, not after coding starts.
>
> Precise review requirement: maintain a running **Change evidence** section in this `plan.md` as you implement.
> - include touched file paths
> - include minimal code snippets/excerpts (with a bit of surrounding context)
> - note which behavior/scenario each snippet satisfies
> - keep it lean: snippets, not whole files

## Chosen API shape

Default target unless implementation reveals a cleaner equivalent:

- module: `pi-ssh/lib/pi-ssh-session-runtime.ts`
- getter: `getActivePiSshSession(): PiSshSession | null`
- internal setter/clear helpers for `pi-ssh` runtime ownership only
- main type: `PiSshSession`

Planned `PiSshSession` surface:
- `getConnectionInfo()`
- `repoRoot(remoteCwd?)`
- `createReadOps(signal?)`
- `createWriteOps(signal?)`
- `createEditOps(signal?)`
- `createBashOps()`
- `getRemoteContext(signal?)`
- `mapLocalPathToRemote(localPath)`
- `execCapture(command, options?)`
- `exists(remotePath, signal?)`
- `stat(remotePath, signal?)`

The public surface should stay small. Expose narrow helpers, not the whole internal transport unless a current consumer needs it. In the finished implementation the only non-reader mutation helpers are owner/test-oriented publish helpers, not generic consumer-facing setters.

## Behavior → planned tests

### Behavior 1: no active `pi-ssh` session means local behavior
- Planned proof:
  - existing `skill-uri/test/backend-runtime.test.mjs` adapted to the new `pi-ssh` session runtime import surface
  - existing self-checkpointing local-path behavior in `self-checkpointing/test/checkpoint-probe.test.mjs` kept green

### Behavior 2: `skill-uri` delegates non-skill workspace reads through the active `pi-ssh` session
- Planned proof:
  - update `skill-uri/test/backend-runtime.test.mjs` to register/set a fake active SSH session and assert non-skill reads come from session-provided read ops

### Behavior 3: `run_skill_script` keeps using remote staging/execution through the active `pi-ssh` session
- Planned proof:
  - keep `skill-uri/test/run-skill-script.test.mjs` green
  - add or update a focused case proving remote session context is consumed from the new `pi-ssh` session runtime

### Behavior 4: `self-checkpointing` still detects SSH mode through `pi-ssh` session data and validates remote checkpoints correctly
- Planned proof:
  - update `self-checkpointing/test/checkpoint-probe.test.mjs` to import the SSH connection/session types from `pi-ssh/lib/pi-ssh-session-runtime.ts`
  - preserve the case that maps SSH connection info to remote checkpoint probing

### Behavior 5: pending resume still respects remote-only checkpoints
- Planned proof:
  - keep `self-checkpointing/test/pending-resume.test.mjs` green

### Behavior 6: remote repo-root resolution is exposed and correct for repo-aware consumers
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with focused repo-root cases using a fake exec/capture dependency

### Behavior 7: local→remote workspace path mapping is exposed and correct for consumers
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with focused mapping cases for:
    - local cwd path mapped to remote cwd
    - local home path mapped to remote home
    - already-remote absolute path passed through only where intended by the current mapper contract

### Behavior 8: exact one-shot SSH exec capture preserves stdout, stderr, and exit code semantics
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with a fake exec/capture dependency proving:
    - stdout and stderr stay separate
    - nonzero exit codes survive
    - helper is suitable for probe-style consumers instead of PTY-shell streaming

### Behavior 9: shared exists/stat helper supports remote artifact validation
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with focused cases for:
    - existing remote file
    - missing remote file
    - mtime propagation for freshness checks
  - if self-checkpointing migrates to these helpers directly, expand `self-checkpointing/test/checkpoint-probe.test.mjs` to prove the real consumer path

## Change evidence (paths + snippets)

- `pi-ssh/lib/pi-ssh-session-runtime.ts` — new canonical SSH-only session contract (Behaviors 6–9; also the shared runtime boundary for 1–5)

```text
export interface PiSshSession {
  getConnectionInfo(): PiSshConnectionInfo;
  getRemoteContext(signal?: AbortSignal): PiSshRemoteContext;
  createReadOps(signal?: AbortSignal): ReadOperations;
  createWriteOps(signal?: AbortSignal): WriteOperations;
  createEditOps(signal?: AbortSignal): EditOperations;
  createBashOps(options?: { onCommandComplete?: (cwd: string) => void }): BashOperations;
  mapLocalPathToRemote(localPath: string): string;
  execCapture(command: string, options?: PiSshExecCaptureOptions): Promise<PiSshExecCaptureResult>;
  exists(remotePath: string, signal?: AbortSignal): Promise<boolean>;
  stat(remotePath: string, signal?: AbortSignal): Promise<PiSshRemoteStat>;
  repoRoot(remoteCwd?: string, signal?: AbortSignal): Promise<string | null>;
}
```

- `pi-ssh/index.ts` — `pi-ssh` now owns publication/clearing of one active session instead of registering through `skill-uri` (Behaviors 1–4)

```text
activeSession = createPiSshSession({
  connection: sessionConnection,
  transport,
  execCapture: (command, options) => sshCapture(sessionConnection.remote, sessionConnection.port, command, options),
});
publishActivePiSshSession(activeSession);
...
activeSession = null;
clearPublishedPiSshSession();
```

- `skill-uri/index.ts` and `skill-uri/lib/run-skill-script.ts` — consumers now use `getActivePiSshSession()` and the `pi-ssh` remote context/staging transport directly (Behaviors 1–3)

```text
const session = getActivePiSshSession();
...
const remoteContext = request.executionBackend === "remote" ? session?.getRemoteContext(signal) ?? null : null;
...
const runner = prepared.executionBackend === "remote"
  ? createBashTool(localCwd, { operations: session!.createBashOps() })
  : localBash;
```

- `self-checkpointing/lib/self-checkpointing-checkpoint-probe.ts` — checkpoint probing now reads SSH connection metadata from the shared `pi-ssh` session runtime while keeping the existing synchronous probe implementation (Behaviors 4–5)

```text
import {
  getActivePiSshSession,
  type PiSshConnectionInfo,
  type PiSshSession,
} from "../../pi-ssh/lib/pi-ssh-session-runtime.ts";
...
const getActiveSession = options.getActiveSession ?? getActivePiSshSession;
const activeSshConfig = resolveCheckpointSshConfig(getActiveSession()?.getConnectionInfo());
```

- `pi-ssh/test/session-runtime.test.mjs` — focused proof for singleton lifecycle, path mapping, repo-root lookup, exact exec capture, and exists/stat helpers (Behaviors 6–9)

```text
__publishActivePiSshSessionForTests(two);
assert.equal(getActivePiSshSession(), two);
assert.equal(session.mapLocalPathToRemote("/local/worktree/src/app.ts"), "/remote/worktree/src/app.ts");
const repoRoot = await session.repoRoot("/remote/repo/subdir");
assert.deepEqual(await session.stat("/remote/worktree/out.txt"), {
  exists: true,
  kind: "file",
  mtimeMs: 1710000000123,
  size: 42,
});
```

- `skill-uri/test/backend-runtime.test.mjs`, `skill-uri/test/run-skill-script.test.mjs`, and `self-checkpointing/test/checkpoint-probe.test.mjs` — consumer regressions now prove the new runtime hookup instead of the deleted `skill-uri/lib/backend-runtime.ts` path (Behaviors 1–5)

```text
__publishActivePiSshSessionForTests(makeSession());
...
assert.equal(result.content[0].text, "from-session:/remote/worktree/README.md\\n");
...
await writeTool.execute("write-1", { path: "NOTES.md", content: "after\\n" });
...
assert.equal(result.details.executionBackend, "remote");
...
assert.equal(probe.isFreshCheckpointFile(checkpointPath, 60_000), true);
```

## Evidence (optional, Showboat — milestone-only)

If you want reproducible proof-of-work, keep a Showboat demo doc at:

- `./evidence/showboat.md`

Default (Option A): capture only key checkpoints:
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied
- final verification

## Phase 1: Interface design and extraction boundary
- [x] Task: Finalize the `PiSshSession` public API shape from the draft above
- [x] Task: Decide which existing `pi-ssh/index.ts` helpers move into `pi-ssh-session-runtime.ts` versus stay internal
- [x] Task: Decide whether self-checkpointing keeps its own SSH probe implementation or should use the new shared exists/stat/exec helpers directly
- [x] Task: Confirm the runtime ownership model is singleton session state, not provider registration
- [x] Task: Record the chosen API and migration boundary in Change evidence

## Phase 2: Tests first for the new session contract
- [x] Task: Add `pi-ssh/test/session-runtime.test.mjs` for singleton session lifecycle, repo-root resolution, path mapping, exec capture, and exists/stat helpers
- [x] Task: Update `skill-uri/test/backend-runtime.test.mjs` to use the `pi-ssh` session runtime instead of `skill-uri/lib/backend-runtime.ts`
- [x] Task: Update `skill-uri/test/run-skill-script.test.mjs` only as needed to prove the new session runtime hookup
- [x] Task: Update `self-checkpointing/test/checkpoint-probe.test.mjs` to use the new `pi-ssh` session runtime contract
- [x] Task: Keep `self-checkpointing/test/pending-resume.test.mjs` aligned and green
- [x] Task: Link each new/changed test to the approved behaviors in Change evidence

## Phase 3: Implementation
- [x] Task: Implement `pi-ssh/lib/pi-ssh-session-runtime.ts`
- [x] Task: Refactor `pi-ssh/index.ts` to publish/clear the active session through the new runtime module
- [x] Task: Expose narrow helpers for repo-root resolution, path mapping, exact exec capture, and exists/stat without leaking unnecessary transport internals
- [x] Task: Migrate `skill-uri/index.ts` and any helper modules to consume `getActivePiSshSession()`
- [x] Task: Migrate `self-checkpointing` checkpoint discovery/probing code to consume the `pi-ssh` session runtime directly
- [x] Task: Remove or retire `skill-uri/lib/backend-runtime.ts` and update imports/docs accordingly
- [x] Task: Update Change evidence for each behavior slice

## Phase 4: Verification
- [x] Task: Run `node --test pi-ssh/test/session-runtime.test.mjs`
- [x] Task: Run targeted `skill-uri` verification:
  - `node --test skill-uri/test/backend-runtime.test.mjs skill-uri/test/run-skill-script.test.mjs skill-uri/test/skill-uris.test.mjs`
- [x] Task: Run targeted `self-checkpointing` verification:
  - `node --test self-checkpointing/test/checkpoint-probe.test.mjs self-checkpointing/test/pending-resume.test.mjs self-checkpointing/test/footer-handler.test.mjs self-checkpointing/test/compaction-ui.test.mjs`
- [x] Task: Run relevant `pi-ssh` regression checks that could catch collateral damage:
  - `node --test pi-ssh/test/remote-context.test.mjs pi-ssh/test/tool-signal-forwarding.test.mjs pi-ssh/test/abort-recovery.test.mjs`
- [x] Task: Run lattice verification for the extension workspace:
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- [x] Task: Perform one manual reasoning pass over SSH-only behavior changes and note whether any live-session E2E check is still warranted
  - Result: no live-session E2E check looks necessary for this track because the observable behavior is intentionally unchanged and the affected seams are covered by focused `pi-ssh`, `skill-uri`, and `self-checkpointing` regressions.

## Phase 5: Review
- [x] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [x] Task: Confirm every new/changed test maps to an approved behavior/scenario
- [x] Task: Review implementation against the approved `plan.md` and note any scope drift
- [x] Task: Ensure Change evidence is sufficient for precise review
- [x] Task: Run `codex-review.sh` with `spec.md`, `plan.md`, `resume.md`, Change evidence, and the touched files
- [x] Task: Fix straightforward review findings and rerun targeted verification if needed
- [x] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 6: Completion sync
- [x] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [x] Task: Update `.lat-md/pi-ssh.md`, `.lat-md/tests.md`, and any other touched lattice docs to describe the new `pi-ssh` session interface
- [x] Task: Update `pi-ssh/README.md`, `pi-ssh/extension-spec.md`, `skill-uri/README.md`, and `self-checkpointing` docs where the shared contract changed
- [x] Task: Best-effort sync project docs (`project.md`, `tech-stack.md`, `workflow.md`) if the completed track changed them materially
  - Result: no additional project-wide conductor docs needed updates; the completed track stayed within extension-local architecture and documentation.
- [x] Task: Mark track complete in `conductor/tracks.md`

## Notes
- Default implementation preference: keep the shared session API tight and explicit; avoid exposing raw transport unless a real consumer needs it.
- Default testing preference: add focused `pi-ssh` session-runtime unit tests for the new helpers, and keep consumer tests anchored on actual behaviors rather than duplicating helper internals.
