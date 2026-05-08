# Track Plan: do not stop goal semantics

> Status markers: `[ ]` not started, `[~]` in progress, `[x]` done
>
> Use the approved `spec.md` as the behavior contract. Each implementation step must trace back to accepted behaviors and scenario examples.
>
> Implementation should be non-interactive after this plan is approved. Resolve ambiguity during discovery/planning, not halfway through code changes.

## Change evidence (paths + snippets)

Append implementation evidence here as tasks are completed. Keep snippets small and map each one to a spec scenario.

Implementation completed and verified for the scoped `/do-not-stop` track.

Evidence summary:

- `do-not-stop/index.ts`: refactored from repeat-toggle state to `DoNotStopGoalState | null`; commands now create/replace/status/clear/budget goals; ordinary input only records previous-message context; `agent_end` runs external audit before follow-up dispatch; stale audit dispatches are guarded by goal id and dispatch token.
- `do-not-stop/lib/do-not-stop.ts`: command parsing now hard-cuts `pause`, `resume`, `on`, `off`, `toggle`, and `repeats`; status labels use `goal active|budget-limited|complete`.
- `do-not-stop/lib/do-not-stop-state.ts`: goal creation, replacement, budget, completion, turn increment, and scheduling gates are pure/tested.
- `do-not-stop/lib/do-not-stop-audit.ts`: strict JSON-only audit parsing; high-confidence completion requires evidence and source paths.
- `do-not-stop/lib/do-not-stop-audit-runner.ts`: external `pi -p` runner uses current model, `--thinking medium`, explicit `--session <path>` on every attempt, creates the audit-session parent directory, and never uses `-c`/`--continue`.
- `do-not-stop/lib/do-not-stop-continuation.ts`: anchored and fallback continuation templates include objective, budget/progress, audit context, completed/remaining work, and guardrails.
- `do-not-stop/lib/do-not-stop-runtime.ts`: per-session goal snapshots plus session custom-entry reconstruction; legacy repeat snapshots resolve to no goal.
- `do-not-stop/lib/do-not-stop-session.ts`: previous-user-message extraction is branch-aware, and audit prompts include session/checkpoint/conductor hints.
- `test/do-not-stop*.test.mjs`: rewritten/expanded to cover command parsing, state transitions, audit parsing, runner command safety, session restore, blank command adoption, stale dispatch protection, budget limiting, completion ownership, and fallback continuation.
- `.lat-md/do-not-stop.md` and `.lat-md/tests.md`: updated for goal semantics, audit-owned completion, hard-cut legacy commands, and test ownership.
- Review fixes applied after Codex review: completion requires evidence/source paths; audit-session parent dirs are created; old toggle commands are unsupported; audit parsing is strict JSON-only; previous-message memory is session-scoped; post-audit gates are rechecked; dispatch tokens prevent stale audits from clearing newer locks; same-goal updates no longer cancel in-flight dispatch locks.

## Evidence (optional, milestone-only)

Use `./evidence/` only if implementation produces useful reproducible proof artifacts. Do not add verbose logs by default.

## Phase 1: API and Runtime Discovery

- [x] Task: Inspect the installed pi CLI/session implementation to determine the exact audit subprocess command contract.
  - Source paths to inspect:
    - `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
    - `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli/**`
    - `/home/tan/.nvm/versions/node/v25.7.0/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.d.ts`
  - Decisions to produce:
    - exact command shape for first audit attempt, expected to be `pi -p --model <current-model> --thinking medium --session <audit-session-path-or-id> <prompt>` or equivalent
    - how to create/capture the explicit audit session path/id for retries
    - how to retry with `--session <path|id>` only
    - confirmation that `-c` / `--continue` is never needed and must not be used
  - Safe commands only:
    - `timeout 10s pi --help`
    - inspect local installed source; avoid live model calls during discovery unless absolutely necessary

- [x] Task: Inspect extension APIs and current context shape for previous-user-message discovery.
  - Source paths:
    - installed typings: `dist/core/extensions/types.d.ts`, `dist/core/session-manager.d.ts`
    - current `do-not-stop/index.ts`
    - representative tests that mock `sessionManager`, especially `test/activity-block-index.test.mjs`
  - Decision to produce:
    - exact helper for blank `/do-not-stop` during a running turn to get the previous user message from `ctx.sessionManager.getBranch()` / `getLeafEntry()` / recent input tracking
    - fallback behavior if the previous user message cannot be found

- [x] Task: Inspect self-checkpointing artifact surfaces for audit inputs.
  - Source paths:
    - `self-checkpointing/index.ts`
    - `self-checkpointing/lib/self-checkpointing-checkpoint-probe.ts`
    - `self-checkpointing/lib/self-checkpointing-session-store.ts`
    - `lib/autockpt/**`
  - Decisions to produce:
    - which local paths are worth passing to the audit prompt, likely `/tmp/pi-work/checkpoints` and pending-resume/checkpoint paths under `~/.pi/agent/state/pi-self-checkpointing`
    - whether the implementation should only mention these sources to `pi -p` or pre-scan/read selected files directly

- [x] Task: Inspect current `do-not-stop` tests and classify which are replaced vs retained.
  - Current tests:
    - `test/do-not-stop.test.mjs`
    - `test/do-not-stop-follow-up.test.mjs`
    - `test/do-not-stop-runtime.test.mjs`
  - Expected result:
    - repeat/toggle assertions become obsolete and are replaced by goal/budget/audit assertions
    - ANSI color test can remain if `brightRed` stays
    - border-label tests are rewritten for goal labels

## Phase 2: Data Model, Parsing, and Pure Helpers

- [x] Task: Replace repeat-centric helper API in `do-not-stop/lib/do-not-stop.ts` with goal-centric contracts.
  - Add/export types or JS-doc-compatible constants for:
    - `DoNotStopGoalStatus = "active" | "budget_limited" | "complete"`
    - `DoNotStopGoalState`
    - `DoNotStopAuditResult`
    - command result variants for `setObjective`, `show`, `status`, `clear`, `setBudget`, `help`, and unsupported commands
  - Remove or stop using:
    - `DO_NOT_STOP_PROMPT` as the primary continuation prompt
    - `DEFAULT_DO_NOT_STOP_REPEATS`
    - `normalizeDoNotStopRepeats`
    - `shouldArmDoNotStopFollowUp`
    - repeat-based `shouldDispatchDoNotStopFollowUp`
  - Keep `brightRed` if still used by the editor.

- [x] Task: Implement and test command parsing for goal semantics.
  - Target tests: `test/do-not-stop.test.mjs`
  - Required scenario coverage:
    - Scenario 1: `/do-not-stop <objective>` creates active unlimited goal
    - Scenario 1b: blank command can be represented distinctly for command handler to resolve previous user message
    - Scenario 9: `pause` / `resume` unsupported
    - Scenario 14: `repeats` rejected with `budget` guidance
    - `budget <n>` accepts positive integers
    - `budget unlimited` clears budget
    - `clear`, `status`, `help` parse explicitly
  - Red phase command:
    - `cd /home/tan/.pi/agent/extensions && node --test test/do-not-stop.test.mjs`

- [x] Task: Implement and test state transition helpers.
  - Suggested new file: `do-not-stop/lib/do-not-stop-state.ts`
  - Helpers to define:
    - `createGoal(objective, options)`
    - `replaceGoal(existing, objective, options)`
    - `setGoalBudget(goal, budget)`
    - `clearGoal()` / null handling
    - `markGoalBudgetLimited(goal)`
    - `markGoalCompleteFromAudit(goal, auditResult, nowMs)`
    - `shouldScheduleGoalContinuation({ goal, isIdle, hasPendingMessages, dispatchScheduled })`
    - `shouldBudgetLimitGoal(goal)`
    - `formatGoalStatusSummary(goal, nowMs)`
    - `buildDoNotStopBorderLabel(goal)`
  - Required scenario coverage:
    - Scenario 1, 4, 5, 6, 12

- [x] Task: Implement and test audit result validation/parsing.
  - Suggested new file: `do-not-stop/lib/do-not-stop-audit.ts`
  - Helpers to define:
    - `parseAuditResult(text)` extracts strict JSON from audit stdout; fail closed on ambiguity
    - `normalizeAuditResult(value)` validates `decision`, `confidence`, arrays, and required strings
    - `isHighConfidenceComplete(audit)`
    - `fallbackAuditResult(reason)` or equivalent internal representation
  - Required scenario coverage:
    - Scenario 6: high-confidence complete accepted
    - Scenario 7: medium/low confidence complete, invalid JSON, timeout/failure do not complete

- [x] Task: Implement and test continuation message construction.
  - Suggested new file: `do-not-stop/lib/do-not-stop-continuation.ts`
  - Helpers to define:
    - `buildAnchoredContinuationMessage(goal, auditResult)`
    - `buildFallbackContinuationMessage(goal, failureReason)`
    - `formatBudgetForPrompt(goal)`
  - Required message sections:
    - original objective
    - turns used and turn budget / unlimited
    - audit summary and source paths when available
    - completed items not to repeat
    - remaining items / next concrete steps
    - guardrails against repeating work or claiming completion from budget exhaustion
  - Required scenario coverage:
    - Scenario 2, 7, 11

## Phase 3: Runtime Persistence and Session State

- [x] Task: Replace repeat snapshot store in `do-not-stop/lib/do-not-stop-runtime.ts` with goal-state persistence/cache helpers.
  - Preserve a test-only reset helper.
  - New helper candidates:
    - `getLastDoNotStopGoalSnapshot()`
    - `getDoNotStopGoalSnapshotForSession(sessionId)`
    - `saveDoNotStopGoalSnapshot(sessionId, goal)`
    - `snapshotFromSessionBranch(entries)` for `pi.appendEntry` / session branch reconstruction if feasible
    - `isLegacyRepeatSnapshot(value)` to fail safe to no goal
  - Required scenario coverage:
    - Scenario 10: old repeat snapshot does not restore as active goal
    - session-specific goal snapshots stay isolated

- [x] Task: Add session-tree append/reconstruction if feasible with current extension API.
  - Use `pi.appendEntry("do-not-stop-goal-state", data)` for state transitions if available from the current code path.
  - Reconstruct latest state on `session_start` by scanning `ctx.sessionManager.getBranch()` for custom entries with `customType === "do-not-stop-goal-state"`.
  - If `appendEntry` is not available in the needed path, document why in `resume.md` and keep the global store as cache with a follow-up debt item.
  - Tests:
    - add branch-entry reconstruction tests in `test/do-not-stop-runtime.test.mjs` using mocked session entries.

- [x] Task: Implement previous-user-message extraction helper for blank `/do-not-stop` during a running turn.
  - Suggested helper: `findPreviousUserMessageForGoal(ctx)` or pure helper taking session branch entries.
  - Must avoid treating extension/custom continuation messages as the original user goal.
  - Required scenario coverage:
    - Scenario 1b

## Phase 4: Audit Subprocess Runner

- [x] Task: Implement an audit runner module that is separately testable and has injectable process execution.
  - Suggested new file: `do-not-stop/lib/do-not-stop-audit-runner.ts`
  - Dependencies should be injectable for tests:
    - `exec(command, args, options)` or `pi.exec`
    - clock/timer
    - audit session path/id generator
    - logger/debug sink
  - Defaults:
    - current model from `ctx.model` / equivalent model info
    - `--thinking medium`
    - total cap: 60 minutes
    - explicit `--session <path|id>` for every retry after an audit session is created
    - never use `-c` or `--continue`
  - Audit output:
    - strict JSON parsed by `parseAuditResult`
    - failure reasons classified as timeout, process error, invalid output, or unavailable source

- [x] Task: Test audit retry/session behavior without live model calls.
  - Target tests: new `test/do-not-stop-audit-runner.test.mjs` or fold into `test/do-not-stop-follow-up.test.mjs` if smaller.
  - Required assertions:
    - first attempt uses `pi -p` with current model and `--thinking medium`
    - retry uses explicit `--session <path|id>`
    - no generated command includes `-c` or `--continue`
    - total timeout cap stops retries
    - final failure returns fallback/no-complete result

- [x] Task: Build audit prompt inputs.
  - Suggested helper: `buildAuditPrompt({ goal, sessionInfo, checkpointHints, conductorHints, progressHints })`
  - The prompt must request the strict JSON schema from the spec.
  - Include source hints rather than dumping large files by default; let `pi -p` inspect files with tools unless a small file read is clearly safer.

## Phase 5: Extension Entrypoint Integration

- [x] Task: Refactor `do-not-stop/index.ts` from repeat loop to goal lifecycle.
  - Replace state variables:
    - remove `enabled`, `repeatTarget`, `pendingRepeats`, `completedRepeats`
    - add `currentGoal: DoNotStopGoalState | null`
    - keep `dispatchScheduled`, `editorOverrideActive`, `activeSessionId`
  - Remove arming on ordinary `input` events.
  - Keep a small recent-user-message tracker only if needed for Scenario 1b.

- [x] Task: Update `/do-not-stop` command handler.
  - Implement:
    - blank command summary/help/adopt-previous-message behavior
    - explicit objective creation
    - replacement confirmation in UI
    - non-UI replacement failure unless explicit replacement command/flag is implemented
    - `status`, `clear`, `budget <n>`, `budget unlimited`, `help`
    - unsupported `pause`, `resume`, and `repeats` with actionable help
  - Tests:
    - update harness in `test/do-not-stop-follow-up.test.mjs` to assert notifications, persisted state, and sent messages.

- [x] Task: Update continuation scheduling on `agent_end`.
  - Gate with `shouldScheduleGoalContinuation`.
  - If budget exhausted before audit, mark `budget_limited`, persist, refresh UI, notify if possible, and stop.
  - Run audit before dispatch.
  - If audit high-confidence complete, mark complete, persist, refresh UI, notify if possible, and stop.
  - If audit continue/unknown, build anchored or fallback continuation message.
  - Increment `turnsUsed` only if dispatch succeeds; restore state on dispatch failure.
  - Check `goalId` before dispatch to cancel stale scheduled continuations.

- [x] Task: Choose and implement continuation delivery mechanism.
  - Preferred default pending discovery: `pi.sendUserMessage(message, { deliverAs: "followUp" })` for simplicity and parity with current tests.
  - If `pi.sendMessage` with `display: false` and `triggerTurn: true` gives a cleaner transcript contract, use it and document the reason in `resume.md`.
  - Tests should assert only the extension-visible send call shape, not live LLM behavior.

- [x] Task: Update UI badge/editor label behavior.
  - Active unlimited: `goal active <turnsUsed>/∞`
  - Active budgeted: `goal active <turnsUsed>/<turnBudget>`
  - Budget-limited: `goal budget-limited <turnsUsed>/<turnBudget>`
  - Complete: `goal complete <turnsUsed>/<budget-or-∞>`
  - No goal: unregister/remove active badge/editor override.
  - Keep compatibility with `tui-broker` badge provider and direct `CustomEditor` path.

## Phase 6: Tests and Lat-MD Sync

- [x] Task: Rewrite `test/do-not-stop.test.mjs` for pure helpers.
  - Covers scenarios: 1, 1b helper representation, 4, 5, 6, 7, 9, 11, 12, 14.

- [x] Task: Rewrite `test/do-not-stop-follow-up.test.mjs` for extension entrypoint behavior.
  - Covers scenarios: 2, 3, 4, 6, 7, 8, 12, 13.
  - Mock audit runner and message sender; do not run live `pi -p`.

- [x] Task: Rewrite `test/do-not-stop-runtime.test.mjs` for goal persistence and legacy repeat migration.
  - Covers scenarios: 10 and session isolation.

- [x] Task: Add audit-runner tests if the runner is complex enough to deserve a separate file.
  - Suggested file: `test/do-not-stop-audit-runner.test.mjs`
  - Covers command construction, retry policy, no `-c/--continue`, timeout cap, and fallback.

- [x] Task: Update lattice docs for changed ownership and tests.
  - Files likely touched:
    - `.lat-md/do-not-stop.md`
    - `.lat-md/tests.md`
  - Required content:
    - goal semantics replace repeat semantics
    - external audit owns completion decision
    - no pause/resume
    - explicit test refs for new/rewritten tests
  - Add/update `@lat:` anchors near changed entrypoints/tests if existing conventions require them.

## Phase 7: Verification

- [x] Task: Run targeted do-not-stop tests.

```bash
cd /home/tan/.pi/agent/extensions && node --test test/do-not-stop*.test.mjs
```

- [x] Task: Run targeted adjacent tests if self-checkpointing artifact discovery or checkpoint probe code is imported/reused. Not applicable: implementation only passes checkpoint/conductor paths as audit prompt hints and does not import or modify self-checkpointing code.

```bash
cd /home/tan/.pi/agent/extensions && node --test test/autockpt*.test.mjs self-checkpointing/test/checkpoint-probe.test.mjs self-checkpointing/test/pending-resume.test.mjs
```

Only run the adjacent command if implementation changes or imports those surfaces.

- [x] Task: Run a broader extension inventory smoke test if entrypoint wiring changes significantly.

```bash
cd /home/tan/.pi/agent/extensions && node --test test/runtime-extension-inventory.mjs
```

- [x] Task: Run lattice checks after `.lat-md/` edits. During this track, the helper failed because the workspace had not yet moved to `.lat-md/`; that mismatch has since been removed.
  - Current command: `bash /home/tan/vault/.pi/skills/lat-md/scripts/run-lat.sh /home/tan/.pi/agent/extensions check all`.
  - Record the exact command and result in `resume.md`.

- [x] Task: Do a no-live-model audit command dry check. Covered by `test/do-not-stop-audit-runner.test.mjs`; no live `pi -p` audit was run.
  - Verify command construction in tests.
  - Do not run a live one-hour `pi -p` audit during normal verification.
  - If a live smoke test is needed, use a tiny `timeout 60s` audit prompt and an explicit temporary `--session` path, then record the command and cleanup.

## Phase 8: Review

- [x] Task: Update this `plan.md` Change evidence with touched paths and scenario mappings.
- [x] Task: Update `resume.md` with final current state, decisions, deviations, and verification commands/results.
- [x] Task: Run `codex-review` on the approved spec, plan, resume, touched implementation files, tests, and Change evidence.
  - Review focus:
    - spec compliance
    - no pause/resume leakage
    - no `-c`/`--continue` in audit runner
    - audit failure cannot mark complete
    - tests map to scenarios
    - no stale repeat toggle behavior remains
- [x] Task: Fix straightforward review findings and rerun targeted tests.

## Phase 9: Completion Sync

- [x] Task: Ensure `spec.md`, `plan.md`, and `resume.md` reflect final behavior.
- [x] Task: Sync `.lat-md/do-not-stop.md` and `.lat-md/tests.md` if implementation changed architecture/test reality.
- [x] Task: Commit implementation with a Conventional Commit message, likely `feat(do-not-stop): add goal continuation audits`.
- [x] Task: Run `/reload` after committing extension changes.
- [x] Task: Mark track complete in `conductor/tracks.md` only after implementation, verification, review, and completion sync pass.

## Implementation Notes

- Prefer small modules over one large `index.ts`; keep files below 800 LOC.
- Keep audit runner side effects injectable so tests do not call live models.
- Treat old repeat snapshots as invalid legacy state; never convert them into active goals.
- Prefer explicit, noisy failure over silent fallback for command/user errors. The only silent-ish fallback is audit failure after the one-hour retry cap, where continuation uses the predefined unanchored template and should still record/debug why anchoring failed.
