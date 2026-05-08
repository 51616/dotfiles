# Track Resume: shared pi-ssh session interface

> Read this file first when resuming or compacting the track.

Track id: `general-remote-backend-i_20260414`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state
Track implementation, review, and verification are complete. The old `skill-uri/lib/backend-runtime.ts` registry is gone. `pi-ssh` now owns the shared SSH runtime through `pi-ssh/lib/pi-ssh-session-runtime.ts`, publishes one active session on session start, and clears it on shutdown/error cleanup. `skill-uri` consumes `getActivePiSshSession()` for non-skill workspace ops and remote `run_skill_script`, and `self-checkpointing` reads SSH connection metadata from the same session runtime while intentionally keeping its synchronous probe implementation. The post-review fixup slice is also complete: the active-session mutation API now uses owner/test-oriented publish helpers, `skill-uri` has explicit write/edit delegation proof for non-skill paths, and `pi-ssh` docs now spell out the shared helper prerequisites (`git` for `repoRoot()`, `python3|python` for `stat()`). The targeted test suite and `lat` verification were rerun after those fixups and passed.

## Active phase / task
- Phase: Complete
- Task: none

## Last completed step
- Reran the targeted verification suite and `lat` checks after the review-fixup slice; all checks passed

## Progress log
- 2026-04-14: Audited `package.json`, `.lat-md/extensions.md`, `.lat-md/tests.md`, `pi-ssh`, `skill-uri`, and `self-checkpointing` runtime/test files relevant to remote backend sharing
- 2026-04-14: Created Conductor track `general-remote-backend-i_20260414`
- 2026-04-14: Drafted the initial spec and project-context docs from the extension workspace audit
- 2026-04-14: Revised the spec to an SSH-only `pi-ssh` session interface, dropped multi-provider logic, and added planned helpers for repo-root resolution, path mapping, exact exec capture, and file exists/stat probing
- 2026-04-14: Drafted `plan.md` with targeted regression coverage for `pi-ssh`, `skill-uri`, and `self-checkpointing`, then updated it to include shared repo-root resolution for future `pi-diff-review` use
- 2026-04-14: Implemented `pi-ssh/lib/pi-ssh-session-runtime.ts` with singleton session publication, repo-root lookup, path mapping, exact exec capture, and exists/stat helpers
- 2026-04-14: Refactored `pi-ssh/index.ts` to publish/clear the active session and removed the old `skill-uri`-owned backend registration path
- 2026-04-14: Migrated `skill-uri` and `self-checkpointing` to the new `pi-ssh` session runtime, deleted `skill-uri/lib/backend-runtime.ts`, and updated regression tests accordingly
- 2026-04-14: Updated `pi-ssh`, `skill-uri`, `self-checkpointing`, and lattice docs to describe the new shared SSH-session boundary
- 2026-04-14: Verified the migration with focused `pi-ssh`, `skill-uri`, and `self-checkpointing` test runs plus `lat` checks
- 2026-04-14: Ran Codex review against the finished track; findings were limited to session mutation API naming/visibility, missing README/spec notes about shared helper prerequisites, and missing write/edit delegation proof in `skill-uri`
- 2026-04-14: Started review fixups by renaming the publish/clear API and adding non-skill write/edit delegation coverage; verification still needs rerun after this slice
- 2026-04-14: Finished review fixups by documenting shared helper prerequisites in `pi-ssh` docs, reran the targeted test suite, and reran `lat` verification successfully

## Accepted behaviors currently in scope
Implemented and verified:
- no active `pi-ssh` session means local behavior
- one active `pi-ssh` session supplies shared SSH helpers to consumers, including repo-root resolution for repo-aware extensions
- `skill-uri` continues using the active session for non-skill workspace ops and remote `run_skill_script`
- `self-checkpointing` continues using SSH-backed checkpoint probing and remote-aware pending resume behavior

## Decisions / non-goals
- No pi core changes in this track
- No product-level behavior changes beyond the shared contract migration and small SSH-helper additions
- Hard-cut the old `skill-uri/lib/backend-runtime.ts` path; no compatibility shim was needed in-repo
- Keep `self-checkpointing`’s probe synchronous for now; it now consumes shared `pi-ssh` session metadata instead of switching to async session helpers mid-track
- Multi-provider registry logic stays out of scope; the contract is explicitly `pi-ssh`-only

## Deviations from approved spec/plan
- No scope drift
- Minor naming cleanup: the new runtime docs and code use “session runtime” wording instead of “backend provider” wording where practical, but the observable `checkpointProbe: ... source=active-backend|cached-backend` status text was kept to avoid needless behavior churn

## Blockers / risks
- No current blockers
- Remaining operational risk is ordinary remote environment drift: consumers of the shared helper API still need `git` for `repoRoot()` and `python3|python` for `stat()` on the remote host, and the docs now call that out explicitly

## Latest review outcome
- Status: pass
- Findings / fixes:
  - Codex review initially returned `pass with minor notes`
  - fixed: renamed owner-only session mutation API away from the generic `set/clearActive...` surface
  - fixed: added regression proof for non-skill write/edit delegation in `skill-uri`
  - fixed: documented `python3|python` and `git` remote prerequisites for the shared session helpers in `pi-ssh` docs
  - reran targeted verification after the fixes; still green

## Setup / prerequisites
- Worktree: `~/.pi/agent/extensions/`
- Git: `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`

## Where to pick up (next steps)
1) Run `/reload` because extension code/docs changed
2) Commit the intended extension-workspace files with dotfiles git, without touching unrelated dirty files such as `startup-demo/index.ts`
3) If any later follow-up is needed, start from `pi-ssh/lib/pi-ssh-session-runtime.ts` and the focused regression tests that already prove the shared-session contract

## Verification commands
- Final targeted verification after the review-fixup slice:
  - `cd /home/tan/.pi/agent/extensions && node --test pi-ssh/test/session-runtime.test.mjs skill-uri/test/backend-runtime.test.mjs skill-uri/test/run-skill-script.test.mjs skill-uri/test/skill-uris.test.mjs self-checkpointing/test/checkpoint-probe.test.mjs self-checkpointing/test/pending-resume.test.mjs self-checkpointing/test/footer-handler.test.mjs self-checkpointing/test/compaction-ui.test.mjs pi-ssh/test/remote-context.test.mjs pi-ssh/test/tool-signal-forwarding.test.mjs pi-ssh/test/abort-recovery.test.mjs`
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Useful inspection commands:
  - `sed -n '1,260p' /home/tan/.pi/agent/extensions/pi-ssh/lib/pi-ssh-session-runtime.ts`
  - `sed -n '1450,1715p' /home/tan/.pi/agent/extensions/pi-ssh/index.ts`
  - `sed -n '160,260p' /home/tan/.pi/agent/extensions/skill-uri/index.ts`
  - `sed -n '1,220p' /home/tan/.pi/agent/extensions/self-checkpointing/lib/self-checkpointing-checkpoint-probe.ts`
- (optional) `uvx showboat verify ./evidence/showboat.md` (when the demo doc exists)

## lat.md drift checks (when used by the repo)
- Last run: `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all` — passed
- Commands (examples):
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Notes: `.lat-md/pi-ssh.md` and `.lat-md/tests.md` now point at the shared `pi-ssh` session runtime and its proving tests
