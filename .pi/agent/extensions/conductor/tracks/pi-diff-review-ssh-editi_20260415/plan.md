# Track Plan: pi diff review ssh editing and latency

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

## Change evidence (paths + snippets)

- `conductor/tracks/pi-diff-review-ssh-editi_20260415/spec.md` — locked the behavior contract for staged SSH editing + persistent text capture (all scenarios)

```text
- SSH backend editor behavior:
  - read the remote file bytes
  - place them in a local staging file
  - if changed, re-read the remote file and compare it to the baseline
  - if the baseline still matches, upload the new file contents
  - if the baseline no longer matches, do not upload
```

- `pi-ssh/lib/pi-ssh-session-runtime.ts` — added shared text-oriented persistent execution to the SSH session boundary while keeping `stat()` on stdout-only capture (latency + PTY-safety scenarios)

```text
export interface PiSshSession {
  execCapture(command: string, ...): Promise<PiSshExecCaptureResult>;
  execText(command: string, ...): Promise<PiSshExecTextResult>;
  exists(...): Promise<boolean>;
  stat(...): Promise<PiSshRemoteStat>;
  repoRoot(...): Promise<string | null>;
}
...
async stat(remotePath, signal) {
  const result = await execCapture(buildRemoteStatCommand(remotePath), ...);
  return parseRemoteStat(result.stdout);
}
```

- `pi-diff-review-tui/lib/ssh-staged-editor.ts` and `lib/pi-diff-review-ssh.ts` — stages SSH edits locally, preflights remote paths before staging, allocates a fresh recovery-safe stage path, refuses binary/symlink/hardlink targets, preserves execute bits, and fails closed through one remote compare-and-write step (happy / no-op / conflict scenarios)

```text
const remoteProbe = await inspectRepoPathForStage(...);
if (remoteProbe.isSymlink) throw new Error("Refusing to stage a symlinked remote file...");
if ((remoteProbe.linkCount ?? 0) > 1) throw new Error("Refusing to stage a hardlinked remote file...");
...
const stagePath = await resolveWritableStagePath(resolveSshEditorStagePath(...));
const writeResult = await compareAndWriteRepoPath(... baseline.bytes, stagedBytes);
if (!writeResult.ok) {
  return { uploaded: false, conflict: true, stagePath, ... };
}
```

- `pi-diff-review-tui/lib/app-workflows.ts` — wired `e` / `g` to the SSH staged editor path while preserving local behavior and surfacing failures cleanly

```text
try {
  if (ctx.backendKind === "ssh") {
    const result = await editRemoteFileViaLocalStage(...);
    if (result.conflict) notify(...stagePath...);
    if (result.uploaded) notify("Uploaded the staged edit back to the remote checkout.");
    await ctx.reloadCurrentScope();
    return;
  }
} catch (error) {
  ctx.callbacks.notify(`Could not complete the editor workflow: ${message}`, "error");
}
```

- `pi-diff-review-tui/test/backend-ssh.test.mjs`, `pi-diff-review-tui/test/ssh-staged-editor.test.mjs`, `pi-diff-review-tui/test/app.test.mjs`, and `pi-ssh/test/session-runtime.test.mjs` — proved persistent text helper usage, stderr suppression for parse-critical git calls, stdout-only stat parsing, staged edit safety, recovery-path uniqueness, preflight symlink/hardlink refusal before the editor opens, mode preservation, and clean editor failure reporting

```text
assert.ok(counters.execText >= 3);
assert.equal(counters.execCapture, 0);
assert.equal(counters.execTextCommands.every((command) => command.includes("2>/dev/null")), true);
...
await assert.rejects(... /Refusing to stage a symlinked remote file over SSH edit/);
await assert.rejects(... /Refusing to stage a hardlinked remote file over SSH edit/);
assert.equal(opened, false);
assert.equal(fs.statSync(targetPath).mode & 0o777, 0o755);
assert.notEqual(result.stagePath, originalStagePath);
...
assert.equal(captureCalls.length, 1);
```

## Evidence (optional, Showboat — milestone-only)

If you want reproducible proof-of-work, keep a Showboat demo doc at:

- `./evidence/showboat.md`

Default (Option A): capture only key checkpoints:
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied
- final verification

## Phase 1: Scope / impact alignment
- [x] Task: Confirm the approved spec captures the required acceptance criteria, expected behaviors, and scenario examples
- [x] Task: Identify affected modules / files / boundaries
- [x] Task: Choose the verification approach for each behavior slice
- [x] Task: Resolve all remaining ambiguity before implementation starts

## Phase 2: Behavior-driven implementation
- [x] Task: Add a persistent text execution helper to the shared `PiSshSession` boundary and migrate diff-review remote git/text calls onto it
- [x] Task: Add SSH staged editor support that opens a local temp file, performs optimistic-lock writeback, and reloads the diff
- [x] Task: Write or extend regression tests only where they prove approved scenarios
- [x] Task (when `.lat-md/` exists): Update the relevant `.lat-md/` sections and add/adjust `@lat:` anchors near touched entrypoints (follow the `lat-md` skill)
- [x] Task: Update **Change evidence** (paths + snippets) for each completed behavior slice
- [x] Task: Refactor while preserving the approved behavior and keeping tests green
- [x] Task: Repeat for remaining behavior slices

## Phase 3: Verification
- [x] Task: Run targeted automated verification for touched behavior slices
- [x] Task: Run the smallest meaningful repo checks for touched areas
- [x] Task (when `.lat-md/` exists): Run `lat check`
- [x] Task: Perform manual verification against a real SSH target for staged edit + lower-latency remote behavior

## Phase 4: Review
- [x] Task: Review implementation against the approved `spec.md` behaviors and scenarios
- [x] Task: Confirm every new/changed test maps to an approved behavior/scenario
- [x] Task: Review implementation against the approved `plan.md` and note any scope drift
- [x] Task: Ensure **Change evidence** is sufficient for precise review
- [x] Task: Run `codex-review.sh` with the relevant `spec.md`, `plan.md`, `resume.md`, and Change evidence context
- [x] Task: Fix straightforward review findings and rerun targeted verification if needed until major issues stop appearing
- [x] Task: Record review outcome in `resume.md` (`pass`, `pass with minor notes`, or `fail`)

## Phase 5: Completion sync
- [x] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- [x] Task (when `.lat-md/` exists): Update `.lat-md/tests.md` and any affected module docs for the new staged-editor and persistent-text boundary
- [x] Task: Best-effort sync extension docs/READMEs for the new SSH editor + latency behavior
- [x] Task: Mark track complete in `conductor/tracks.md`
- [x] Task: Reload pi because live extensions changed
- [x] Task: Commit the implementation with dotfiles git without touching unrelated dirty files

## Notes
- Key code boundaries expected in scope:
  - `pi-ssh/index.ts`
  - `pi-ssh/lib/pi-ssh-session-runtime.ts`
  - `pi-ssh/test/session-runtime.test.mjs`
  - `pi-diff-review-tui/lib/backend.ts`
  - `pi-diff-review-tui/lib/app.ts`
  - `pi-diff-review-tui/lib/app-workflows.ts`
  - `pi-diff-review-tui/lib/external-editor.ts`
  - new SSH staged-editor helper module + focused tests
  - docs in `pi-diff-review-tui/README.md`, `pi-ssh/README.md`, and relevant `.lat-md/*`
