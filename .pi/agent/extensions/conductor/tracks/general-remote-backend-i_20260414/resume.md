# Track Resume: general remote backend interface

> Read this file first when resuming or compacting the track.

Track id: `general-remote-backend-i_20260414`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state
The extension workspace audit is done at a high level. The current shared remote contract lives in `skill-uri/lib/backend-runtime.ts`, `pi-ssh` registers into it, `skill-uri` consumes it directly, and `self-checkpointing` imports it only for backend discovery. A first spec draft now proposes moving that contract into a neutral shared runtime while preserving current behavior.

## Active phase / task
- Phase: Spec approval
- Task: Review and refine `spec.md` before writing `plan.md` or code

## Last completed step
- Drafted the initial track spec and project-context docs from the extension workspace audit

## Progress log
- 2026-04-14: Audited `package.json`, `lat-md/extensions.md`, `lat-md/tests.md`, `pi-ssh`, `skill-uri`, and `self-checkpointing` runtime/test files relevant to remote backend sharing
- 2026-04-14: Created Conductor track `general-remote-backend-i_20260414`
- 2026-04-14: Drafted `spec.md` for a neutral shared remote backend interface

## Accepted behaviors currently in scope
Pending user approval. The current draft keeps these behaviors in scope:
- last registered active backend wins
- no active backend means local behavior
- `skill-uri` continues using the active backend for non-skill workspace ops and remote `run_skill_script`
- `self-checkpointing` continues using SSH-backed checkpoint probing and remote-aware pending resume behavior

## Decisions / non-goals
- No pi core changes in this track
- No product-level behavior changes beyond the shared contract migration
- The current draft assumes a hard cut away from `skill-uri/lib/backend-runtime.ts` unless a concrete in-repo need for a temporary alias appears

## Deviations from approved spec/plan
- None yet; spec not approved

## Blockers / risks
- The right neutral name for the shared runtime is still open
- The migration should stay narrow enough that it does not accidentally redesign remote probing/staging behavior

## Latest review outcome
- Status: not run
- Findings / fixes:

## Setup / prerequisites
- Worktree: `~/.pi/agent/extensions/`
- Git: `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`

## Where to pick up (next steps)
1) Review and approve or edit `spec.md`
2) After approval, draft `plan.md` with concrete migration and verification steps
3) Implement the shared runtime, migrate consumers, and run targeted regression tests

## Verification commands
- Spec stage: read `conductor/tracks/general-remote-backend-i_20260414/spec.md`
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
