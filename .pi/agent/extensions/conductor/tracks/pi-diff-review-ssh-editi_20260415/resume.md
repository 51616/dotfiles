# Track Resume: pi diff review ssh editing and latency

> Read this file first when resuming or compacting the track.

Track id: `pi-diff-review-ssh-editi_20260415`

## Canonical docs

- Spec: [./spec.md](./spec.md)
- Plan: [./plan.md](./plan.md)
- Metadata: [./metadata.json](./metadata.json)
- Evidence (optional): [./evidence/](./evidence/)

## Current state
Track complete. `PiSshSession` now exposes a text-oriented `execText()` helper, and `repoRoot()` / `exists()` use that low-latency path when the session provides it. `stat()` intentionally stays on stdout-only `execCapture()`, and the new stage-preflight repo-path inspect also uses `execCapture()` because its JSON contract is parse-critical. `pi-ssh/index.ts` wires `execText()` to the persistent remote shell path. `pi-diff-review` remote git/text commands use the persistent text helper for stdin-free structured probes, with stderr suppressed on parse-critical git calls; exact-byte file reads/writes, `stat()`, stage-preflight inspect, and patch-stdin reverse-apply stay on the safe capture path. SSH edit mode is enabled: `e` / `g` stage the selected remote file locally, allocate a fresh stage path if an older recovery copy exists, refuse binary/symlink/hardlink targets before the editor opens, preserve executable bits on writeback, and write changes back only through one remote compare-and-write step against the original baseline. Conflict/drift leaves the staged local file in place and warns the user. Docs and `lat-md` are updated. Focused and full targeted verification passed after the final preflight follow-up, repeated Codex review no longer surfaced major code-level issues, and `/reload` is queued for the updated live extensions.

## Active phase / task
- Phase: Complete
- Task: None

## Last completed step
- Closed the final preflight symlink/hardlink follow-up, queued `/reload`, and committed the completion-sync changes without touching `startup-demo/index.ts`

## Progress log
- 2026-04-15: Created Conductor track `pi-diff-review-ssh-editi_20260415`
- 2026-04-15: Captured the approved approach in `spec.md`: local staged SSH editor with optimistic-lock writeback, plus persistent `pi-ssh` text execution for diff-review git/text commands
- 2026-04-15: Added `PiSshSession.execText()` to the shared session runtime, kept `stat()` on stdout-only capture, and wired `pi-ssh/index.ts` to the persistent shell-backed text path
- 2026-04-15: Updated `lib/pi-diff-review-ssh.ts` so remote diff-review stdin-free git/text commands use `execText()` with stderr suppressed for parse-critical calls, while stdin-driven patch-apply stays on exact capture
- 2026-04-15: Added `pi-diff-review-tui/lib/ssh-staged-editor.ts` and wired SSH edit mode in `app-workflows.ts` to local staging + remote compare-and-write + clean failure notifications
- 2026-04-15: Hardened the staged SSH editor with size guards, session-id sanitization, unique recovery-safe stage paths, executable-mode preservation, and explicit symlink/hardlink refusal
- 2026-04-15: Added/updated regression coverage in `pi-ssh/test/session-runtime.test.mjs`, `pi-diff-review-tui/test/backend-ssh.test.mjs`, `pi-diff-review-tui/test/ssh-staged-editor.test.mjs`, and `pi-diff-review-tui/test/app.test.mjs`
- 2026-04-15: Updated `pi-diff-review-tui/README.md`, `pi-ssh/README.md`, `pi-ssh/extension-spec.md`, `lat-md/pi-diff-review-tui.md`, `lat-md/pi-ssh.md`, and `lat-md/tests.md`
- 2026-04-15: Verified the change set with targeted/full diff-review + pi-ssh tests, repeated `lat` checks, and a real SSH staged-edit verification script under `/tmp/pi-work`
- 2026-04-15: Ran repeated Codex review loops and fixed the reported major issues until code-level major findings stopped appearing in the committed slice
- 2026-04-15: After commit `da724ee`, Codex found one more real safety issue: symlink/hardlink refusal happened too late (after staging)
- 2026-04-15: Closed that follow-up by adding a preflight repo-path inspect before staging, moving the inspect path onto stdout/stderr-separated `execCapture()`, updating the staged-editor tests to prove the editor never opens for symlink/hardlink targets, and re-verifying the full targeted suite

## Accepted behaviors currently in scope
- SSH `e`/`g` open a locally staged copy of the remote file, not a direct remote path
- unchanged staged edits do not mutate the remote checkout
- changed staged edits upload back only when the remote baseline still matches the pre-edit bytes through one remote compare-and-write step
- remote baseline drift blocks upload and preserves the staged file for recovery
- binary-looking SSH edit targets are refused instead of being staged blindly
- diff-review stdin-free remote git/text commands move onto a persistent `PiSshSession` text execution helper
- exact-byte file reads/writes, stdout-only `stat()` parsing, and patch-stdin reverse-apply remain on the existing safe path
- local diff-review behavior stays unchanged

## Decisions / non-goals
- Keep the remote checkout canonical; no general local mirror becomes source-of-truth
- Use optimistic-lock full-file writeback for editor saves, not remote patch application as the primary save path
- Keep binary/exact-byte file transfer on the existing non-PTY path; only text command execution should move to the persistent shell helper
- Treat `execText()` as text-oriented / PTY-style combined output only; byte-sensitive consumers must keep using `execCapture()` or remote transport file reads
- Reverse-apply stays on exact capture because it needs stdin-capable, byte-safe patch transport

## Deviations from approved spec/plan
- No scope drift so far
- The staged editor helper hashes file bytes and performs one remote compare-and-write step instead of storing a separate metadata sidecar or doing a separate pre-write re-read; behavior is aligned with the updated spec

## Blockers / risks
- No known blockers remain for this track
- Assumption: the remote host and checkout are user-controlled, not hostile. The staged editor now refuses ordinary symlink/hardlink targets before staging, but it does not claim adversarial race-proof nofollow reads across an actively hostile remote filesystem

## Latest review outcome
- Status: pass
- Findings / fixes:
  - fixed unhandled SSH editor failures by surfacing workflow errors through notifications
  - moved staged SSH writeback to one remote compare-and-write step and kept `stat()` on stdout-only capture
  - added size guards, binary refusal, executable-mode preservation, recovery-safe unique stage paths, and explicit symlink/hardlink refusal before the editor opens
  - hardened parse-critical remote git text commands against PTY/stderr noise by suppressing stderr on stdin-free structured probes
  - moved the new stage-preflight inspect helper onto `execCapture()` so its JSON contract is not exposed to PTY-combined output noise

## Setup / prerequisites
- Worktree: `~/.pi/agent/extensions/`
- Git: `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`
- Remote prerequisites for SSH staged editing: `python3` or `python`
- Existing unrelated dirty file to avoid: `~/.pi/agent/extensions/startup-demo/index.ts`

## Where to pick up (next steps)
- No pending work in this track.
- If a new SSH diff-review issue appears, start a fresh follow-up track from the completed state.

## Verification commands
- Full targeted suite:
  - `cd /home/tan/.pi/agent/extensions && timeout 1500s node --test pi-ssh/test/*.mjs pi-diff-review-turn-tracker/test/*.mjs pi-diff-review-tui/test/*.mjs`
- Focused slice used during implementation:
  - `cd /home/tan/.pi/agent/extensions && timeout 1500s node --test pi-ssh/test/session-runtime.test.mjs pi-diff-review-tui/test/backend-ssh.test.mjs pi-diff-review-tui/test/ssh-staged-editor.test.mjs pi-diff-review-tui/test/external-editor.test.mjs pi-diff-review-tui/test/entrypoint.test.mjs`
- Lattice drift check:
  - `timeout 1500s bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Real SSH verification artifacts:
  - `/tmp/pi-work/remote_diff_review_edit_verify.mjs`
  - `/tmp/pi-work/run_remote_diff_review_edit_verify.py`
  - `/tmp/pi-work/remote-diff-review-edit-verify.txt`
- (optional) `uvx showboat verify ./evidence/showboat.md` (when the demo doc exists)

## lat.md drift checks (when used by the repo)
- Last run: `timeout 1500s bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all` — passed
- Commands (examples):
  - `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`
- Notes: `lat-md/pi-diff-review-tui.md`, `lat-md/pi-ssh.md`, and `lat-md/tests.md` are already updated for staged SSH editing and the shared `execText()` runtime boundary
