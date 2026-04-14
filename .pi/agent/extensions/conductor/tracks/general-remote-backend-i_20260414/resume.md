# Track Resume: shared pi-ssh session interface

> Read this file first when resuming or compacting the track.

Track id: `general-remote-backend-i_20260414`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state
The extension workspace audit is done at a high level. The current shared SSH contract lives in `skill-uri/lib/backend-runtime.ts`, `pi-ssh` registers into it, `skill-uri` consumes it directly, and `self-checkpointing` imports it only for backend discovery. The spec now narrows scope deliberately: this will become a documented `pi-ssh`-owned session interface, not a general remote-backend abstraction.

## Active phase / task
- Phase: Plan approval
- Task: Review and refine `plan.md` test and migration slices before code changes

## Last completed step
- Drafted the behavior-driven implementation and test plan

## Progress log
- 2026-04-14: Audited `package.json`, `lat-md/extensions.md`, `lat-md/tests.md`, `pi-ssh`, `skill-uri`, and `self-checkpointing` runtime/test files relevant to remote backend sharing
- 2026-04-14: Created Conductor track `general-remote-backend-i_20260414`
- 2026-04-14: Drafted the initial spec and project-context docs from the extension workspace audit
- 2026-04-14: Revised the spec to an SSH-only `pi-ssh` session interface, dropped multi-provider logic, and added planned helpers for repo-root resolution, path mapping, exact exec capture, and file exists/stat probing
- 2026-04-14: Drafted `plan.md` with targeted regression coverage for `pi-ssh`, `skill-uri`, and `self-checkpointing`, then updated it to include shared repo-root resolution for future `pi-diff-review` use

## Accepted behaviors currently in scope
Pending user approval. The current draft keeps these behaviors in scope:
- no active `pi-ssh` session means local behavior
- one active `pi-ssh` session supplies shared SSH helpers to consumers, including repo-root resolution for repo-aware extensions
- `skill-uri` continues using the active session for non-skill workspace ops and remote `run_skill_script`
- `self-checkpointing` continues using SSH-backed checkpoint probing and remote-aware pending resume behavior

## Decisions / non-goals
- No pi core changes in this track
- No product-level behavior changes beyond the shared contract migration and small SSH-helper additions
- The current draft assumes a hard cut away from `skill-uri/lib/backend-runtime.ts` unless a concrete in-repo need for a temporary alias appears
- Multi-provider registry logic is intentionally out of scope; the contract is `pi-ssh`-only

## Deviations from approved spec/plan
- None yet; spec not approved

## Blockers / risks
- The API surface still needs a concrete final shape, especially singleton getter vs explicit session-state setter/getter
- The migration should stay narrow enough that it does not accidentally redesign remote probing/staging behavior

## Latest review outcome
- Status: not run
- Findings / fixes:

## Setup / prerequisites
- Worktree: `~/.pi/agent/extensions/`
- Git: `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`

## Where to pick up (next steps)
1) Review and approve or edit `plan.md`
2) After approval, implement `pi-ssh/lib/pi-ssh-session-runtime.ts` and migrate consumers in small slices
3) Run targeted regression tests for `pi-ssh`, `skill-uri`, and `self-checkpointing` after each meaningful slice

## Verification commands
- Planning stage:
  - `sed -n '1,260p' /home/tan/.pi/agent/extensions/conductor/tracks/general-remote-backend-i_20260414/spec.md`
  - `sed -n '1,320p' /home/tan/.pi/agent/extensions/conductor/tracks/general-remote-backend-i_20260414/plan.md`
- Audit references:
  - `sed -n '1,220p' /home/tan/.pi/agent/extensions/skill-uri/lib/backend-runtime.ts`
  - `sed -n '1540,1585p' /home/tan/.pi/agent/extensions/pi-ssh/index.ts`
  - `sed -n '1,220p' /home/tan/.pi/agent/extensions/self-checkpointing/lib/self-checkpointing-checkpoint-probe.ts`
- (optional) `uvx showboat verify ./evidence/showboat.md` (when the demo doc exists)

## lat.md drift checks (when used by the repo)
- Last run: not run for this track yet
- Commands (examples):
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Notes: update relevant lattice docs if the shared runtime location or ownership changes
