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

## Planned API shape (draft)

Default target unless implementation reveals a cleaner equivalent:

- module: `pi-ssh/lib/pi-ssh-session-runtime.ts`
- getter: `getActivePiSshSession(): PiSshSession | null`
- internal setter/clear helpers for `pi-ssh` runtime ownership only
- main type: `PiSshSession`

Planned `PiSshSession` surface:
- `getConnectionInfo()`
- `createReadOps(signal?)`
- `createWriteOps(signal?)`
- `createEditOps(signal?)`
- `createBashOps()`
- `getRemoteContext(signal?)`
- `mapLocalPathToRemote(localPath)`
- `execCapture(command, options?)`
- `exists(remotePath, signal?)`
- `stat(remotePath, signal?)`

The public surface should stay small. Expose narrow helpers, not the whole internal transport unless a current consumer needs it.

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

### Behavior 6: local→remote workspace path mapping is exposed and correct for consumers
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with focused mapping cases for:
    - local cwd path mapped to remote cwd
    - local home path mapped to remote home
    - already-remote absolute path passed through only where intended by the current mapper contract

### Behavior 7: exact one-shot SSH exec capture preserves stdout, stderr, and exit code semantics
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with a fake exec/capture dependency proving:
    - stdout and stderr stay separate
    - nonzero exit codes survive
    - helper is suitable for probe-style consumers instead of PTY-shell streaming

### Behavior 8: shared exists/stat helper supports remote artifact validation
- Planned proof:
  - add `pi-ssh/test/session-runtime.test.mjs` with focused cases for:
    - existing remote file
    - missing remote file
    - mtime propagation for freshness checks
  - if self-checkpointing migrates to these helpers directly, expand `self-checkpointing/test/checkpoint-probe.test.mjs` to prove the real consumer path

## Change evidence (paths + snippets)

Append entries as you go. Suggested format:

- `path/to/file.ext` — short note (why / which scenario)

```text
<minimal excerpt here>
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
- [ ] Task: Finalize the `PiSshSession` public API shape from the draft above
- [ ] Task: Decide which existing `pi-ssh/index.ts` helpers move into `pi-ssh-session-runtime.ts` versus stay internal
- [ ] Task: Decide whether self-checkpointing keeps its own SSH probe implementation or should use the new shared exists/stat/exec helpers directly
- [ ] Task: Confirm the runtime ownership model is singleton session state, not provider registration
- [ ] Task: Record the chosen API and migration boundary in Change evidence

## Phase 2: Tests first for the new session contract
- [ ] Task: Add `pi-ssh/test/session-runtime.test.mjs` for singleton session lifecycle, path mapping, exec capture, and exists/stat helpers
- [ ] Task: Update `skill-uri/test/backend-runtime.test.mjs` to use the `pi-ssh` session runtime instead of `skill-uri/lib/backend-runtime.ts`
- [ ] Task: Update `skill-uri/test/run-skill-script.test.mjs` only as needed to prove the new session runtime hookup
- [ ] Task: Update `self-checkpointing/test/checkpoint-probe.test.mjs` to use the new `pi-ssh` session runtime contract
- [ ] Task: Keep `self-checkpointing/test/pending-resume.test.mjs` aligned and green
- [ ] Task: Link each new/changed test to the approved behaviors in Change evidence

## Phase 3: Implementation
- [ ] Task: Implement `pi-ssh/lib/pi-ssh-session-runtime.ts`
- [ ] Task: Refactor `pi-ssh/index.ts` to publish/clear the active session through the new runtime module
- [ ] Task: Expose narrow helpers for path mapping, exact exec capture, and exists/stat without leaking unnecessary transport internals
- [ ] Task: Migrate `skill-uri/index.ts` and any helper modules to consume `getActivePiSshSession()`
- [ ] Task: Migrate `self-checkpointing` checkpoint discovery/probing code to consume the `pi-ssh` session runtime directly
- [ ] Task: Remove or retire `skill-uri/lib/backend-runtime.ts` and update imports/docs accordingly
- [ ] Task: Update Change evidence for each behavior slice

## Phase 4: Verification
- [ ] Task: Run `node --test pi-ssh/test/session-runtime.test.mjs`
- [ ] Task: Run targeted `skill-uri` verification:
  - `node --test skill-uri/test/backend-runtime.test.mjs skill-uri/test/run-skill-script.test.mjs skill-uri/test/skill-uris.test.mjs`
- [ ] Task: Run targeted `self-checkpointing` verification:
  - `node --test self-checkpointing/test/checkpoint-probe.test.mjs self-checkpointing/test/pending-resume.test.mjs self-checkpointing/test/footer-handler.test.mjs self-checkpointing/test/compaction-ui.test.mjs`
- [ ] Task: Run relevant `pi-ssh` regression checks that could catch collateral damage:
  - `node --test pi-ssh/test/remote-context.test.mjs pi-ssh/test/tool-signal-forwarding.test.mjs pi-ssh/test/abort-recovery.test.mjs`
- [ ] Task: Run lattice verification for the extension workspace:
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- [ ] Task: Perform one manual reasoning pass over SSH-only behavior changes and note whether any live-session E2E check is still warranted

## Phase 5: Review
- [ ] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [ ] Task: Confirm every new/changed test maps to an approved behavior/scenario
- [ ] Task: Review implementation against the approved `plan.md` and note any scope drift
- [ ] Task: Ensure Change evidence is sufficient for precise review
- [ ] Task: Run `codex-review.sh` with `spec.md`, `plan.md`, `resume.md`, Change evidence, and the touched files
- [ ] Task: Fix straightforward review findings and rerun targeted verification if needed
- [ ] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 6: Completion sync
- [ ] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [ ] Task: Update `lat-md/pi-ssh.md`, `lat-md/tests.md`, and any other touched lattice docs to describe the new `pi-ssh` session interface
- [ ] Task: Update `pi-ssh/README.md`, `pi-ssh/extension-spec.md`, `skill-uri/README.md`, and `self-checkpointing` docs where the shared contract changed
- [ ] Task: Best-effort sync project docs (`project.md`, `tech-stack.md`, `workflow.md`) if the completed track changed them materially
- [ ] Task: Mark track complete in `conductor/tracks.md`

## Notes
- Default implementation preference: keep the shared session API tight and explicit; avoid exposing raw transport unless a real consumer needs it.
- Default testing preference: add focused `pi-ssh` session-runtime unit tests for the new helpers, and keep consumer tests anchored on actual behaviors rather than duplicating helper internals.
