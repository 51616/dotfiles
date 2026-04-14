# Track Spec: shared pi-ssh session interface

> This spec is the behavior contract for the track.
>
> Test policy: do not write tests for the sake of testing. Every new/changed test must directly prove one of the expected behaviors or scenario examples defined here.

## Context
Today, shared SSH-session access exists, but the contract is owned by `skill-uri`. `pi-ssh` registers backend state through `skill-uri/lib/backend-runtime.ts`, `skill-uri` consumes it directly for non-skill workspace delegation and remote skill staging, and `self-checkpointing` imports the same module only to discover SSH connection details for remote checkpoint probing.

That works, but the ownership boundary is wrong for the scope we actually want. We are not trying to create a universal remote-backend system right now. We only want one explicit SSH-session interface for extensions that cooperate with `pi-ssh`.

The contract should therefore live under `pi-ssh`, be documented as SSH-only, drop the multi-provider registry logic, and expose a small public session API that matches current needs plus a few missing SSH helpers that other extensions are likely to need.

## Goal
Define and implement one canonical `pi-ssh` session interface, move the shared runtime under `pi-ssh`, migrate `skill-uri` and `self-checkpointing` to that interface, add a few missing SSH helpers, and preserve current observable behavior.

## Non-goals
- No pi core changes
- No general remote-backend abstraction in this track
- No new remote transport backend beyond `pi-ssh`
- No product-level behavior changes to `skill-uri`, `pi-ssh`, or `self-checkpointing` beyond the shared contract migration and helper additions
- No redesign of self-checkpointing into an async remote-probe architecture unless the migration makes that cleanup clearly cheap
- No compatibility bridge for old internal import paths unless a concrete in-repo use requires it

## Requirements
- Add a documented public runtime module under `pi-ssh`, default target:
  - `pi-ssh/lib/pi-ssh-session-runtime.ts`
- Define an explicit SSH-only session contract with neutral-enough but SSH-honest naming, covering:
  - active session discovery (`getActivePiSshSession()` or equivalent)
  - remote workspace tool-operation factories used by `skill-uri`
  - remote staging context used by `run_skill_script`
  - SSH connection metadata used by `self-checkpointing`
  - remote path mapping from local workspace paths to remote workspace paths
  - exact one-shot command capture with real stdout/stderr/exit semantics
  - remote file existence/stat probing suitable for checkpoint validation and future artifact checks
- Drop multi-provider selection logic
- Keep the runtime model simple:
  - no active `pi-ssh` session means local behavior
  - one active `pi-ssh` session means consumers use that session
- Preserve the current resilience behavior for checkpoint probing across transient session-state disappearance during one session lifecycle if that behavior is still needed after the refactor. The mechanism can change, but the user-visible recovery should not regress accidentally.
- Migrate `pi-ssh` to own and publish the session object through the new interface
- Migrate `skill-uri` to consume the `pi-ssh` session interface for:
  - non-skill workspace `read` / `write` / `edit` delegation
  - remote `run_skill_script` staging/execution context
- Migrate `self-checkpointing` to consume the `pi-ssh` session interface directly instead of importing `skill-uri` runtime internals
- Decide whether `self-checkpointing` should keep its own SSH probe implementation or switch to the new `pi-ssh` helpers. Default preference: use the shared `pi-ssh` helpers if that keeps the code simpler and preserves correctness.
- Document the interface as the SSH integration point for other extensions that want to cooperate with `pi-ssh`
- Add regression tests that prove the migrated contract keeps current `skill-uri` and `self-checkpointing` behavior correct

## Acceptance criteria
- There is one canonical shared SSH-session runtime module under `pi-ssh`
- `pi-ssh`, `skill-uri`, and `self-checkpointing` all use that module directly
- No live extension code outside compatibility tests depends on `skill-uri/lib/backend-runtime.ts`
- Existing `skill-uri` behavior remains intact:
  - local `skill://...` paths still resolve locally
  - non-skill workspace operations still delegate to the active `pi-ssh` session when one is active
  - `run_skill_script` still uses the active session automatically for remote staging/execution
- Existing `self-checkpointing` behavior remains intact:
  - SSH-backed checkpoint probing still uses SSH connection/session data from `pi-ssh`
  - pending resume still respects remote-only checkpoints
  - transient SSH session-state loss does not accidentally break the existing recovery path during the same session lifecycle
- The new `pi-ssh` session contract exposes the added helpers and they are covered by tests where they prove an approved behavior:
  - remote path mapping
  - exact one-shot command capture
  - remote exists/stat probing
- README/spec/lattice docs describe the `pi-ssh` session interface clearly enough that a new extension author can find the right contract without reading `skill-uri` internals

## Expected behaviors
- With no active `pi-ssh` session, extensions behave as they do today in local-only sessions
- When `pi-ssh` is active, the shared runtime reports one active SSH session object with connection metadata and helper methods
- `skill-uri` uses the active `pi-ssh` session for non-skill workspace operations, but still resolves `skill://...` resources from local skill roots
- `run_skill_script` uses the active `pi-ssh` session for remote staging/execution when available, and local execution otherwise
- `self-checkpointing` uses `pi-ssh` session data or helpers to decide whether to run checkpoint validation as SSH-backed instead of local-only
- The session object exposes exact one-shot exec capture so extensions can run SSH probes without rebuilding raw `ssh` subprocess logic
- The session object exposes file existence/stat helpers so checkpoint or artifact validation does not need to reimplement path probing each time
- The session object exposes local→remote path mapping for extensions that reason about workspace paths
- The API is explicitly SSH-only. Consumers should not assume it is a generic remote-provider abstraction.

## Scenario examples
- Scenario: A local session starts without `pi-ssh`
  - `skill-uri` reads and writes normal workspace paths locally
  - `run_skill_script` executes locally
  - `self-checkpointing` validates checkpoints on the local filesystem

- Scenario: An SSH session starts with `pi-ssh`
  - `pi-ssh` publishes one active SSH session object
  - `skill-uri` delegates non-skill workspace reads through that session
  - `skill://...` reads still come from the local skill source

- Scenario: `run_skill_script` is called for `skill://checkpointing/scripts/new-checkpoint.sh` in an SSH session
  - `skill-uri` resolves the script from the local skill root
  - it obtains remote staging context from the active `pi-ssh` session
  - it stages and executes the script remotely

- Scenario: `self-checkpointing` validates a checkpoint footer during an SSH session
  - it obtains SSH connection data or helpers from the active `pi-ssh` session
  - it treats checkpoint freshness/existence as remote, not local
  - valid remote-only checkpoints are accepted

- Scenario: An extension needs to validate a remote artifact path without parsing shell output itself
  - it uses the shared `pi-ssh` session exists/stat helper
  - it does not shell out with a custom raw `ssh` subprocess just to answer a file-presence question

- Scenario: An extension needs exact stdout/stderr/exit semantics for a one-shot remote probe
  - it uses the shared `pi-ssh` session exec-capture helper
  - it does not depend on the persistent PTY shell path for exact-byte probe semantics

- Scenario: An extension needs to convert a local workspace path into the matching remote workspace path
  - it uses the shared `pi-ssh` session path-mapping helper instead of reimplementing workspace mapping logic

## Evidence plan (scenario → proof)
- Scenario: local mode still falls back cleanly when no `pi-ssh` session is active
  - Proof: existing `skill-uri` and self-checkpointing local-path tests remain green after the migration

- Scenario: `skill-uri` still delegates non-skill reads through the active `pi-ssh` session
  - Proof: existing `skill-uri` read-delegation regression test updated to import the `pi-ssh` session runtime

- Scenario: `run_skill_script` still uses remote staging/execution through the active `pi-ssh` session
  - Proof: existing `skill-uri/test/run-skill-script.test.mjs` coverage kept green and expanded only if the migration introduces a new edge worth proving

- Scenario: `self-checkpointing` still maps SSH session metadata to checkpoint probing correctly
  - Proof: existing `self-checkpointing/test/checkpoint-probe.test.mjs` updated to import the session contract or its connection-info type from `pi-ssh`

- Scenario: pending resume still respects remote-only checkpoints
  - Proof: existing `self-checkpointing/test/pending-resume.test.mjs`

- Scenario: shared path mapping remains correct for consumer use
  - Proof: new focused `pi-ssh` session-runtime regression test or expanded existing `pi-ssh` test coverage

- Scenario: exact one-shot exec capture preserves stdout/stderr/exit semantics
  - Proof: new focused `pi-ssh` session-runtime regression test or expanded existing `pi-ssh` test coverage

- Scenario: remote exists/stat probing works for future artifact validation needs
  - Proof: new focused `pi-ssh` session-runtime regression test or expanded existing `pi-ssh` test coverage

- Scenario: shared contract is discoverable to new extension authors
  - Proof: updated README/spec/lattice docs for `pi-ssh`, plus consumer docs in `skill-uri` and `self-checkpointing`

## Constraints / assumptions
- This is an internal workspace contract inside `~/.pi/agent/extensions/`, so we can hard-cut old internal imports if all in-repo consumers are migrated together
- We are intentionally optimizing for SSH-only cooperation, not future generic remote backends
- The session API should stay small and explicit; only add helpers with clear current or near-term extension value
- The most likely useful added helpers are:
  - exact one-shot exec capture
  - file exists/stat probing
  - local→remote workspace path mapping

## Risks
- Moving the runtime under `pi-ssh` could accidentally leak too much implementation detail if the session API is not kept tight
- A too-large cleanup could change behavior that currently works, especially around `run_skill_script` staging and checkpoint recovery
- If `self-checkpointing` switches from its own SSH probing to new shared helpers, the change could regress subtle freshness/error behavior unless the tests stay honest

## Open questions
- Exact API shape: singleton-style `getActivePiSshSession()` vs explicit setter/getter pair with internal module state
- How much of the current internal transport should be exposed directly versus wrapped in narrower helpers
