# Track Spec: general remote backend interface

> This spec is the behavior contract for the track.
>
> Test policy: do not write tests for the sake of testing. Every new/changed test must directly prove one of the expected behaviors or scenario examples defined here.

## Context
Today, remote-session sharing exists, but the contract is owned by `skill-uri`. `pi-ssh` registers a backend through `skill-uri/lib/backend-runtime.ts`, `skill-uri` consumes it directly for non-skill workspace delegation and remote skill staging, and `self-checkpointing` imports the same module only to discover SSH connection details for remote checkpoint probing. That works, but the abstraction boundary is wrong: unrelated extensions have to depend on a `skill-uri` internal just to learn whether a remote session is active.

The result is a contract that is practically shared but not clearly presented as one canonical, extension-wide interface. New extensions can reuse it only if they know to reach into `skill-uri` internals. That is fragile and misleading.

## Goal
Define and implement one canonical extension-wide remote backend interface, move the registry/runtime into a shared location, migrate `pi-ssh`, `skill-uri`, and `self-checkpointing` to that interface, and preserve current observable behavior.

## Non-goals
- No pi core changes
- No new remote transport backend beyond `pi-ssh` in this track
- No product-level behavior changes to `skill-uri`, `pi-ssh`, or `self-checkpointing` beyond the shared contract migration
- No redesign of self-checkpointing into an async remote-probe architecture
- No compatibility bridge for old internal import paths unless a concrete in-repo use requires it

## Requirements
- Add a shared runtime module under a neutral shared path in the extensions workspace, not under `skill-uri`
- Define a provider interface with neutral naming that covers the currently required shared capabilities:
  - active backend registration and selection
  - remote workspace tool-operation factories used by `skill-uri`
  - remote staging context used by `run_skill_script`
  - backend connection metadata used by `self-checkpointing`
- Migrate `pi-ssh` to register itself through the new shared interface
- Migrate `skill-uri` to consume the new shared interface for:
  - non-skill workspace `read` / `write` / `edit` delegation
  - remote `run_skill_script` backend selection and staging context
- Migrate `self-checkpointing` to consume the new shared interface directly instead of importing `skill-uri` runtime internals
- Preserve existing registry semantics:
  - no active backend means local behavior
  - the last registered active backend wins
  - checkpoint probing may keep using the last seen SSH backend info when the active provider temporarily disappears
- Document the interface as an extension-wide shared contract, including who owns registration and who consumes which parts
- Add regression tests that prove the migrated contract keeps the current `skill-uri` and `self-checkpointing` behavior correct

## Acceptance criteria
- There is one canonical shared remote-backend runtime module outside `skill-uri`
- `pi-ssh`, `skill-uri`, and `self-checkpointing` all use that shared module directly
- No live extension code outside compatibility tests depends on `skill-uri/lib/backend-runtime.ts`
- Existing `skill-uri` behavior remains intact:
  - local `skill://...` paths still resolve locally
  - non-skill workspace operations still delegate to the active remote backend when one is active
  - `run_skill_script` still uses the active backend automatically for remote staging/execution
- Existing `self-checkpointing` behavior remains intact:
  - SSH-backed checkpoint probing still reads connection info from the active remote backend
  - pending resume still respects remote-only checkpoints
  - cached SSH backend behavior still works across transient provider disappearance during the same session lifecycle
- Regression tests cover the shared runtime selection semantics and the current `skill-uri` and `self-checkpointing` integration behavior
- README/spec/lattice docs describe the new shared interface clearly enough that a new extension author can find the right contract without reading `skill-uri` internals

## Expected behaviors
- With no active remote backend, extensions behave as they do today in local-only sessions
- When `pi-ssh` is active, the shared runtime reports one active remote backend with SSH connection metadata
- `skill-uri` uses the active shared backend for non-skill workspace operations, but still resolves `skill://...` resources from local skill roots
- `run_skill_script` uses the active shared backend for remote staging/execution when available, and local execution otherwise
- `self-checkpointing` uses shared backend connection metadata to decide whether to run checkpoint validation as SSH-backed instead of local-only
- If a remote backend temporarily disappears during the same session, checkpoint probing can still use the last seen SSH connection metadata, preserving current recovery behavior
- If multiple backends are registered and active, the newest active backend wins, matching current behavior
- The shared contract remains explicit about backend kind. SSH-specific consumers may branch on `kind === "ssh"` instead of assuming every backend is SSH-shaped

## Scenario examples
- Scenario: A local session starts without `pi-ssh`
  - `skill-uri` reads and writes normal workspace paths locally
  - `run_skill_script` executes locally
  - `self-checkpointing` validates checkpoints on the local filesystem

- Scenario: An SSH session starts with `pi-ssh`
  - `pi-ssh` registers the active shared remote backend
  - `skill-uri` delegates non-skill workspace reads through the shared backend
  - `skill://...` reads still come from the local skill source

- Scenario: `run_skill_script` is called for `skill://checkpointing/scripts/new-checkpoint.sh` in an SSH session
  - `skill-uri` resolves the script from the local skill root
  - it obtains remote staging context from the shared backend
  - it stages and executes the script remotely

- Scenario: `self-checkpointing` validates a checkpoint footer during an SSH session
  - it obtains SSH connection info through the shared backend runtime
  - it treats checkpoint freshness/existence as remote, not local
  - valid remote-only checkpoints are accepted

- Scenario: The remote backend becomes temporarily unavailable after previously being active in the session
  - checkpoint probing can still use the last seen SSH connection metadata
  - the current resilience behavior is preserved

- Scenario: Two remote backend providers are registered and active
  - the most recently registered active provider is treated as canonical

## Evidence plan (scenario → proof)
- Scenario: active backend selection stays stable and last-active-wins
  - Proof: shared runtime unit test migrated from the existing backend registry test

- Scenario: `skill-uri` still delegates non-skill reads through the active backend
  - Proof: existing `skill-uri` read-delegation regression test updated to import the shared runtime

- Scenario: `run_skill_script` still uses remote staging/execution through the active backend
  - Proof: existing `skill-uri/test/run-skill-script.test.mjs` coverage kept green and expanded only if the migration introduces a new edge worth proving

- Scenario: `self-checkpointing` still maps SSH backend metadata to checkpoint probing
  - Proof: existing `self-checkpointing/test/checkpoint-probe.test.mjs` updated to import the shared runtime contract or its connection-info type from the new shared location

- Scenario: pending resume still respects remote-only checkpoints
  - Proof: existing `self-checkpointing/test/pending-resume.test.mjs`

- Scenario: shared contract is discoverable to new extension authors
  - Proof: updated README/spec/lattice docs for `pi-ssh`, `skill-uri`, and the shared runtime location

## Constraints / assumptions
- This is an internal workspace contract inside `~/.pi/agent/extensions/`, so we can hard-cut old internal imports if all in-repo consumers are migrated together
- The current shared capability set is enough for this track; the goal is to make it canonical and neutral, not to invent a much larger remote API than current consumers need
- `self-checkpointing` can continue using its own SSH probe implementation in this track as long as backend discovery no longer depends on `skill-uri`

## Risks
- A too-large abstraction rewrite could change behavior that currently works, especially around `run_skill_script` staging and checkpoint recovery
- Renaming/moving the runtime module without updating all tests/docs could leave future extension work more confusing, not less
- Over-generalizing beyond current needs could create dead interface surface that no consumer actually uses

## Open questions
- Naming: use `remote-backend`, `remote-workspace`, or another neutral shared name?
- Hard cut vs temporary re-export: given current repo-only usage, the default should be a hard cut unless the migration reveals a concrete need for a short-lived alias
