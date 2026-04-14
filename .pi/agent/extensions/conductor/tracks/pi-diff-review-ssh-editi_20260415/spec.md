# Track Spec: pi diff review ssh editing and latency

> This spec is the behavior contract for the track.
>
> Test policy: do not write tests for the sake of testing. Every new/changed test must directly prove one of the expected behaviors or scenario examples defined here.

## Context
`pi-diff-review` now uses the shared `pi-ssh` session runtime for remote diff inspection, but two user-visible problems remain in SSH mode. First, external edit mode is disabled entirely, so pressing `e`/`g` cannot open the current file. Second, remote diff operations still rely heavily on one-shot SSH capture, so latency is noticeably higher than the normal remote shell path. The desired direction is to keep the remote checkout canonical while using a local staged copy for editor UX and the existing persistent remote shell for text-oriented remote diff-review commands.

## Goal
Make SSH diff-review usable and faster by adding local staged editing with safe writeback to the remote file, and by moving diff-review’s remote text command path onto the persistent `pi-ssh` session.

## Non-goals
- No general remote sync engine or local mirror that becomes canonical.
- No background file watching or automatic bidirectional reconciliation.
- No binary-file editing workflow.
- No symlink-preserving or hardlink-preserving SSH edit workflow in v1; those targets should fail closed instead of being rewritten.
- No broad refactor of unrelated `pi-ssh` consumers.
- No silent overwrite when the remote file changed during a staged edit.

## Requirements
- SSH diff-review edit mode must open the selected remote file in the local editor by staging it locally first.
- The staged edit flow must write the edited file back to the remote checkout only when the remote file still matches the baseline captured before editing.
- On remote drift, the staged edit flow must fail closed, keep the staged local file for recovery, and tell the user what happened.
- Diff-review remote text commands must use the persistent `pi-ssh` shell path instead of one-shot SSH capture where text-only semantics are sufficient.
- The shared `PiSshSession` boundary must remain explicit and narrow.
- Existing local diff-review behavior must stay unchanged.

## Acceptance criteria
- In SSH mode, `e`/`g` open a local staged file, and a successful edit updates the remote working tree and reloads the diff.
- In SSH mode, unchanged staged edits do not rewrite the remote file.
- In SSH mode, remote baseline drift blocks writeback and surfaces a clear recovery message that includes the staged file path.
- Diff-review remote workspace diff, per-file patch lookup, repo-root lookup, and other stdin-free git/text probes use a persistent text capture path through `PiSshSession`.
- Reverse-apply remains on exact capture because it sends patch stdin and may need byte-safe patch handling.
- The affected tests pass, `lat` checks pass, and a manual remote verification proves the staged edit and debug/diff path against a real SSH target.

## Expected behaviors
- Local backend behavior stays as-is: editor opens the real local file directly.
- SSH backend editor behavior:
  - resolve the selected repo-relative path
  - read the remote file bytes
  - place them in a local staging file under a diff-review-owned local directory
  - open the local editor on that staged file, preserving line targeting
  - refuse binary-looking, symlinked, or hardlinked targets instead of rewriting them through the staged editor flow
  - if the staged file is unchanged after the editor exits, do nothing remotely
  - if changed, run one remote compare-and-write step against the baseline
  - if the baseline still matches, upload the new file contents to the remote path and reload the diff
  - if the baseline no longer matches, do not upload; keep the local staged file and show recovery guidance
- Persistent remote text execution behavior:
  - `pi-ssh` exposes a text-oriented command helper on `PiSshSession`
  - the helper uses the persistent shell/session path, not one-shot SSH capture
  - the helper returns combined text output plus exit status, which is acceptable for diff-review’s stdin-free remote git/text commands
  - binary-sensitive paths such as exact file reads, JSON-like stat parsing, and patch-stdin apply flows remain on the existing exact-byte path
- Failure behavior:
  - missing/non-editable/deleted files still fail cleanly
  - remote command failures remain visible to the user instead of silently falling back

## Scenario examples
- Happy path: while reviewing over SSH, I press `e` on `src/tracked.ts`, the local editor opens a staged copy, I save a change, exit, and the remote file is updated. Reload shows the new remote diff state.
- No-op path: I press `e`, exit without changing the staged file, and diff-review reloads without mutating the remote checkout.
- Conflict path: I press `e`, someone or something changes the remote file before I save, and on exit diff-review refuses to overwrite it, keeps my staged local file, and tells me where it is.
- Latency path: in SSH mode, diff-review workspace/patch/debug operations use the persistent remote text path and no longer rely on one-shot capture for normal git text commands.
- Local safety path: in local mode, editor and diff behavior remain unchanged.

## Evidence plan (scenario → proof)
- Scenario: SSH edit happy path updates the remote file after local staging.
  - Proof: new regression test for the staged SSH editor helper; manual remote verification against a real SSH host.
- Scenario: unchanged staged file does not rewrite remote content.
  - Proof: regression test for staged SSH editor helper.
- Scenario: remote baseline drift blocks writeback and preserves the staged file.
  - Proof: regression test for staged SSH editor helper.
- Scenario: diff-review remote git/text paths use the persistent text helper.
  - Proof: `pi-ssh` session-runtime tests plus diff-review SSH backend tests that assert the new helper is used.
- Scenario: local mode remains unchanged.
  - Proof: existing external-editor and local diff-review tests remain green.
- Scenario: real SSH target still works end to end.
  - Proof: manual remote verification script/output captured in `/tmp/pi-work` and referenced in `resume.md`.

## Constraints / assumptions
- The remote checkout remains the canonical source of truth.
- The persistent `pi-ssh` shell is text-oriented; it is acceptable for git/text command output but not for exact byte reads.
- The selected editor can open an arbitrary local temp file path.
- The remote host still provides the existing shell/git/base64 prerequisites already required by `pi-ssh`.

## Risks
- PTY-backed persistent shell output can differ slightly from one-shot output, so the new shared helper must be explicitly documented as text-oriented.
- Editor writeback logic can accidentally clobber newer remote content if baseline checks are weak.
- Added SSH edit flow increases the number of local temp artifacts; cleanup must be predictable and the recovery path must be explicit.

## Open questions
- None for implementation. Tan explicitly chose the combined approach: local staged editing plus persistent remote session usage for lower latency.
