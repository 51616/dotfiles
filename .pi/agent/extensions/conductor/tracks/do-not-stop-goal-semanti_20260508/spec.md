# Track Spec: do not stop goal semantics

> This spec is the behavior contract for changing the `do-not-stop` pi extension from a bounded repeat toggle into an explicit persisted goal-continuation workflow.
>
> Test policy: do not write tests for the sake of testing. Every new/changed test must directly prove one of the expected behaviors or scenario examples defined here.

## Context

The live pi extensions workspace is `~/.pi/agent/extensions/`. The `do-not-stop` extension currently lives at `do-not-stop/index.ts` with helper modules in `do-not-stop/lib/` and regression tests under `test/`.

Current behavior is repeat-based:

- `/do-not-stop` toggles a global enabled flag.
- `/do-not-stop on|off|status|repeats <n>` controls that flag and a repeat count.
- When enabled, ordinary user input arms a cycle with `pendingRepeats = repeatTarget`.
- On `agent_end`, if pi is idle and no pending messages exist, the extension queues a generic visible follow-up user message: `DO_NOT_STOP_PROMPT`.
- The loop stops when the repeat count is exhausted, not when the original objective is complete.
- State is cached through `do-not-stop/lib/do-not-stop-runtime.ts` using a `globalThis` store keyed by session id.
- TUI feedback is shown through an editor border/badge such as `↻ repeat 0/1`.

This track changes the behavior to be closer to Codex `/goal`: a user sets an explicit objective, pi continues while the goal is active and idle, and completion is an explicit state transition rather than an exhausted repeat counter.

## Goal

Implement explicit goal semantics for `/do-not-stop`:

- `/do-not-stop <objective>` creates or replaces the active goal for the current session.
- The active goal continues automatically when pi is idle until it becomes `complete`, becomes `budget_limited`, or is cleared by the user.
- Continuation is grounded by an external `pi -p` progress audit that inspects real work artifacts before constructing the next continuation prompt.
- Completion is determined by the external progress/completion audit, not by the active agent judging its own work.
- Runtime budget exhaustion is distinct from completion.
- No pause/resume feature exists in this version.
- Continuation budget is unlimited by default when not explicitly set.
- User-visible status and editor affordances reflect goal state, not repeat-cycle state.

## Non-goals

- Do not implement pause/resume commands or a `paused` status.
- Do not preserve the old global toggle semantics as a parallel mode.
- Do not infer goals automatically from ordinary user prompts.
- Do not implement token-level budget accounting unless a reliable per-goal token delta API is discovered and approved later.
- Do not change pi core. This work must stay inside the extension workspace.
- Do not let the active agent be the sole judge of completion.
- Do not require conductor tracks, checkpoints, or progress notes to exist; use them when available and fail safe when they are absent.
- Do not add broad compatibility bridges for stale `globalThis` repeat snapshots; safe hard-cut migration to “no active goal” is acceptable unless explicitly revised.

## Requirements

### Data model

The extension must represent the current goal with an explicit state object. The canonical shape may evolve during implementation, but it must include these fields or clear equivalents:

```ts
type DoNotStopGoalStatus = "active" | "budget_limited" | "complete";

type DoNotStopGoalState = {
  goalId: string;
  objective: string;
  status: DoNotStopGoalStatus;
  turnBudget: number | null;
  turnsUsed: number;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};
```

Rules:

- `active` means the runtime may schedule continuation turns when idle.
- `budget_limited` means a configured turn budget was exhausted; this is not completion.
- `complete` means the external `pi -p` audit judged the objective achieved with high confidence and concrete evidence.
- Absence of a goal is represented as `null` / no current goal, not as a status.
- `turnBudget: null` means unlimited continuation turns.
- `turnsUsed` counts extension-scheduled continuation turns, not ordinary user turns.
- Goal replacement creates a new `goalId` and resets `turnsUsed`.

### Slash command behavior

`/do-not-stop` must behave as a goal command:

- `/do-not-stop` with no arguments shows the current goal summary when a goal exists.
- `/do-not-stop` with no arguments creates an active goal from the previous user message when no goal exists and a turn is currently running.
- `/do-not-stop` with no arguments shows usage/help when no goal exists and no turn is running.
- `/do-not-stop <objective>` creates a new active goal when no goal exists.
- `/do-not-stop <objective>` replaces the existing goal only after interactive confirmation when UI is available; in non-UI contexts it fails with a clear “clear first or pass replace” style message unless an explicit replacement flag/command is implemented.
- `/do-not-stop status` shows goal state, objective, turns used, turn budget, and elapsed time.
- `/do-not-stop clear` removes the current goal and stops future continuation.
- `/do-not-stop budget <n>` sets a positive turn budget on the current goal, preserving `turnsUsed`.
- `/do-not-stop budget unlimited` clears the configured turn budget.
- `/do-not-stop help` shows the supported command surface.
- `/do-not-stop pause` and `/do-not-stop resume` are unsupported and must return a clear error/help message.

Old repeat terminology is hard-cut from the command surface. `/do-not-stop repeats <n>` must return help that points users to `/do-not-stop budget <n>` instead of acting as an alias.

### Continuation scheduling

The extension may schedule a continuation only when all gates pass:

- A current goal exists.
- `goal.status === "active"`.
- `ctx.isIdle()` is true.
- `ctx.hasPendingMessages()` is false when that API is available.
- No continuation dispatch is already scheduled.
- The scheduled goal id still matches the current goal id when the dispatch fires.
- `turnBudget === null` or `turnsUsed < turnBudget`.

When the budget check fails, the runtime must set the goal status to `budget_limited`, persist state, refresh UI, and stop scheduling continuations.

Continuation must not be armed from every ordinary user input. The objective is set explicitly through `/do-not-stop <objective>`.

### External progress and completion audit

Before scheduling a continuation turn, the extension must run a bounded external audit by invoking `pi -p` as a separate process. This audit is the completion judge and progress summarizer for the goal. It reduces self-evaluation bias because the active agent does not decide whether its own work is complete.

The audit process should inspect real work context when available:

- the original `/do-not-stop <objective>` text
- the current goal state: status, `goalId`, `turnsUsed`, and `turnBudget`
- the current session or branch transcript/progress information available through pi session files or extension APIs
- auto-checkpoint artifacts produced by the self-checkpointing extension, when available
- conductor track files when the work appears to be under a track, especially `conductor/tracks/*/spec.md`, `plan.md`, and `resume.md`
- progress notes, TODO files, or resume/progress documents discovered in the current workspace when they clearly relate to the objective
- relevant repo state that can be inspected safely by the audit process

The audit must return a strict machine-readable result. The final schema may be adjusted during implementation, but it must express this contract:

```ts
type DoNotStopAuditDecision = "complete" | "continue" | "unknown";

type DoNotStopAuditResult = {
  decision: DoNotStopAuditDecision;
  confidence: "high" | "medium" | "low";
  summary: string;
  completedItems: string[];
  remainingItems: string[];
  evidence: string[];
  sourcePaths: string[];
  continuationMessage: string;
};
```

Decision rules:

- `complete` with high confidence marks the goal `complete`, sets `completedAtMs`, persists state, refreshes UI, and prevents future continuation.
- `complete` with medium/low confidence must not mark completion; treat it as `unknown` and continue cautiously.
- `continue` produces the next continuation prompt from `continuationMessage`, the remaining items, and the predefined guardrails.
- `unknown` must not mark completion. It may produce a conservative continuation prompt that asks the active agent to inspect real state and continue from the original objective.
- Audit timeout, invalid JSON, process failure, or missing progress sources must never mark completion.

Audit subprocess policy:

- Invoke the audit through `pi -p` using the current model and `--thinking medium`.
- Cap total audit wall-clock time at 60 minutes.
- When the initial audit attempt fails or times out, retry by resuming the same audit session when possible using `--session <path|id>`.
- Retry attempts must reuse an explicit audit session path/id if one was created, so the second process can continue from partial audit progress rather than starting from zero.
- Do not use `-c` or `--continue` for audit retries. Multiple pi instances may run concurrently, so “most recent session” is not a safe audit-session selector.
- If the audit still fails or times out after the one-hour cap, do not mark completion. Send the predefined fallback continuation template without anchored audit details.
- Missing conductor/checkpoint/progress sources are not audit failure by themselves; the audit may still return `continue` or `unknown` from the original objective and session state.

The implementation plan must choose exact command arguments, retry schedule, session-id/path capture, output parsing, timeout enforcement, and logging behavior after inspecting the installed pi CLI behavior.

### Continuation message contract

Continuation messages must be anchored to both the original goal and the external audit result.

Every continuation message must include:

- the original active objective
- current budget/progress facts: `turnsUsed` and `turnBudget` or `unlimited`
- audit summary and source paths when available
- completed items that should not be repeated
- remaining items or next concrete steps from conductor/checkpoint/progress artifacts when available
- a predefined guardrail section that tells the active agent not to repeat completed work, not to claim completion from budget exhaustion, and to inspect real state when uncertain

Continuation should prefer fine-grained remaining work from conductor tracks, auto-checkpoints, and progress notes over a generic “do not stop” prompt. If no fine-grained source exists, the fallback continuation must still include the original objective and require the active agent to audit current state before proceeding.

The exact message role, display behavior, and delivery mechanism (`pi.sendUserMessage`, `pi.sendMessage`, `before_agent_start`, or `before_turn_response`) remain implementation decisions, but the message construction must be isolated behind a small function/module.

### Completion ownership

The active agent must not receive a general-purpose tool that lets it mark the goal complete by self-assessment. Completion is runtime-owned and comes from the external `pi -p` audit result.

Completion behavior:

- The extension marks a goal `complete` only when the external audit returns `decision: "complete"` with `confidence: "high"`.
- The completion transition records `completedAtMs`, persists state, refreshes UI, and records a concise completion summary including objective, elapsed time, `turnsUsed`, budget, and evidence/source paths from the audit.
- User commands may still `clear` a goal, but clearing is not completion.
- The runtime, user command handler, and active agent must not set `budget_limited` as completion.

### Persistence

Goal state must survive extension reloads and session switches.

Preferred canonical persistence:

- Append state transitions to the session tree with `pi.appendEntry(customType, data)` using a stable custom type such as `do-not-stop-goal-state`.
- Reconstruct the latest goal state for the current branch during `session_start` using `ctx.sessionManager.getBranch()` or the closest available branch/session API.

The existing `globalThis` runtime store may remain as a cache, but it must not be the only durable source if session-tree persistence is feasible.

Migration rule:

- Old repeat-based snapshots may be ignored or treated as no active goal.
- The extension must not accidentally start a goal from stale `enabled=true` repeat state after this change.

### UI / status behavior

The TUI affordance must reflect goal state:

- Active goal with unlimited budget: show a compact label such as `goal active 3/∞`.
- Active goal with turn budget: show `goal active 3/10` or equivalent.
- Budget-limited goal: show `goal budget-limited 10/10` or equivalent.
- Complete goal: show `goal complete 7/∞` or equivalent.
- No goal: remove the `do-not-stop` badge/editor override.

The UI must remain compatible with the `tui-broker` editor badge provider path and the direct `CustomEditor` override path.

### Observability and failure behavior

- Scheduling and state transitions must be explicit functions, not hidden mutation in event handlers.
- Failed continuation dispatch must restore counters/state if it incremented `turnsUsed` before failure.
- User-facing errors must say what happened and how to recover.
- Budget exhaustion must notify the user when UI is available.

## Acceptance criteria

- `/do-not-stop <objective>` creates an active goal with unlimited budget by default.
- Blank `/do-not-stop` during a running turn creates an active goal from the previous user message when no goal exists.
- Active goals continue automatically after `agent_end` when idle and no pending messages exist.
- Continuation stops only when the goal is complete, budget-limited, cleared, or the scheduling gates fail.
- A configured turn budget moves the goal to `budget_limited` when exhausted; unlimited budget never exhausts by turn count.
- Completion is marked only by a high-confidence external `pi -p` audit result, not by the active agent.
- Continuation messages are grounded in real progress sources when conductor tracks, checkpoints, or progress notes are available.
- Audit failures/timeouts are retried within a one-hour cap and fall back to an unanchored continuation template if still unsuccessful.
- There is no pause/resume status or user command in the supported command surface.
- Old repeat toggle state cannot cause unexpected continuation after reload.
- UI labels/status reflect active, budget-limited, complete, and no-goal states; completed goals remain visible until the user clears them.
- Targeted regression tests prove command parsing, state transitions, scheduling gates, budget behavior, audit-result handling, continuation-message construction, and migration from old repeat snapshots.

## Expected behaviors

- Creating a goal starts an active state immediately but does not interrupt a currently running turn unless the approved continuation delivery mechanism explicitly requires that behavior.
- Replacing a goal resets budget progress and creates a fresh `goalId`.
- Clearing a goal removes UI state and prevents scheduled dispatch from sending stale continuation messages.
- Budget exhaustion is runtime-owned. The active agent is not allowed to set `budget_limited`.
- Completion is audit-owned. The active agent does not infer or set completion from its own final answer.
- Unsupported commands such as `pause` and `resume` return help instead of silently doing nothing.
- Non-UI sessions still persist state and schedule continuations according to the same gates.

## Scenario examples

### Scenario 1: Create an unlimited active goal

A user runs `/do-not-stop finish the lint cleanup`. No goal exists. The extension stores a new active goal with objective `finish the lint cleanup`, `turnBudget = null`, and `turnsUsed = 0`. The UI shows an active goal label with unlimited budget.

### Scenario 1b: Blank command during running turn adopts previous user message

No goal exists and a turn is currently running for the user message `fix the failing auth tests`. The user runs blank `/do-not-stop`. The extension creates an active goal using `fix the failing auth tests` as the objective, with `turnBudget = null` and `turnsUsed = 0`. The command does not inject an immediate continuation into the running turn; continuation waits for the normal idle scheduling gate.

### Scenario 2: Continue after idle agent end

An active unlimited goal exists with `turnsUsed = 0`. The agent ends, `ctx.isIdle()` is true, and there are no pending messages. The extension invokes the external `pi -p` audit. The audit returns `decision: "continue"`, cites current progress, lists remaining items, and provides a grounded continuation message. The extension schedules one continuation for the current `goalId`, increments `turnsUsed` to `1` only if dispatch succeeds or restores it on failure, and sends the grounded continuation message.

### Scenario 3: Do not continue while pending input exists

An active goal exists. The agent ends, but `ctx.hasPendingMessages()` is true. The extension does not schedule a continuation and does not increment `turnsUsed`.

### Scenario 4: Respect finite turn budget

An active goal has `turnBudget = 2` and `turnsUsed = 2`. The agent ends while idle. The extension marks the goal `budget_limited`, persists state, refreshes UI, and does not send another continuation. The goal is not marked complete.

### Scenario 5: Unlimited budget never budget-limits by turn count

An active goal has `turnBudget = null` and `turnsUsed = 999`. The agent ends while idle. The extension may schedule another continuation because no turn-count budget exists.

### Scenario 6: Complete through external audit

An active goal exists. The agent ends while idle. The extension invokes the external `pi -p` audit. The audit inspects the original objective, session progress, and available artifacts, then returns `decision: "complete"` with `confidence: "high"` and concrete evidence. The extension marks the goal complete, persists state, refreshes UI, records the completion summary/evidence, and prevents future continuation.

### Scenario 7: Low-confidence or invalid completion does not complete

An active goal exists. The external audit returns `decision: "complete"` with `confidence: "medium"`, returns invalid JSON, times out, or fails. The extension does not mark the goal complete. It retries within the one-hour audit cap, resuming the audit session when possible. If the audit remains unsuccessful after the cap, it sends the predefined fallback continuation template without anchored audit details. Goal state remains active unless a configured budget is exhausted.

### Scenario 8: Clear cancels stale scheduled continuation

An active goal schedules a continuation with goal id `A`. Before the dispatch fires, the user runs `/do-not-stop clear`. When the scheduled dispatch runs, it sees no matching active goal and sends nothing.

### Scenario 9: Pause/resume commands are not supported

A user runs `/do-not-stop pause` or `/do-not-stop resume`. The extension returns a clear help/error message saying pause/resume are unsupported and listing supported commands. Goal state is unchanged.

### Scenario 10: Old repeat snapshot does not auto-arm

After reload, the old runtime cache contains an `enabled=true` repeat snapshot. The new extension does not convert that into an active goal and does not schedule follow-up messages until the user explicitly creates a goal.

### Scenario 11: Conductor/checkpoint progress anchors continuation

An active goal corresponds to a workspace that contains a conductor track or auto-checkpoint progress note. The external audit reads the relevant spec/plan/resume/checkpoint artifacts, identifies completed and remaining items, and produces a continuation message that focuses on the next unfinished item instead of repeating broad completed work.

### Scenario 12: Completed goal remains visible until cleared

The external audit marks a goal complete with high confidence. The UI shows a complete goal status after the transition. Blank `/do-not-stop` shows the completed goal summary. No continuation is scheduled. The status remains visible until the user runs `/do-not-stop clear`.

### Scenario 13: Existing goal replacement requires confirmation or explicit replace

A goal already exists. In an interactive UI session, `/do-not-stop new objective` asks for confirmation before replacing the current goal. In a non-UI context, the same command fails with a clear message unless the implementation provides and receives an explicit replacement flag/command.

### Scenario 14: Repeat terminology is hard-cut

A user runs `/do-not-stop repeats 3`. The extension does not change budget or goal state. It returns help that directs the user to `/do-not-stop budget 3`.

## Evidence plan (scenario → proof)

- Scenario 1: Add/update command parsing and state tests in `test/do-not-stop*.test.mjs`; assert active state shape and unlimited default.
- Scenario 1b: Add command handler tests with a mocked running-turn/previous-user-message source; assert blank `/do-not-stop` adopts the previous user message only when no goal exists and a turn is running.
- Scenario 2: Add/update follow-up scheduling tests in `test/do-not-stop-follow-up.test.mjs`; mock the audit result and assert dispatch uses the grounded continuation message only for active goals and increments/restores turns correctly.
- Scenario 3: Add/update scheduling gate tests; assert pending messages block continuation.
- Scenario 4: Add budget transition tests; assert `budget_limited` state and no dispatch.
- Scenario 5: Add unlimited budget test; assert no budget-limited transition from turn count alone.
- Scenario 6: Add audit-result handling tests; assert high-confidence complete audit causes active → complete transition and no future dispatch.
- Scenario 7: Add audit failure/low-confidence tests; assert no completion on low-confidence complete, invalid JSON, timeout, or process failure, and assert fallback continuation after retry cap.
- Scenario 8: Add stale scheduled dispatch test; assert goal id mismatch/null goal blocks dispatch.
- Scenario 9: Add command parsing/handler tests for unsupported pause/resume commands.
- Scenario 10: Add runtime migration test in `test/do-not-stop-runtime.test.mjs`; assert old repeat snapshot does not restore as active goal.
- Scenario 11: Add continuation-message builder tests; feed conductor/checkpoint/progress-note audit output and assert completed work is preserved as “do not repeat” context while remaining items drive the next prompt.
- Scenario 12: Add UI/status state tests where feasible; assert complete state stays visible until clear and blocks continuation.
- Scenario 13: Add command handler tests for replacement confirmation/non-UI explicit replacement behavior.
- Scenario 14: Add command parsing/handler tests asserting `repeats` is rejected with budget guidance.

Expected targeted verification command from repo root:

```bash
node --test test/do-not-stop*.test.mjs
```

If `.lat-md` test specs are updated during implementation, also run the project’s local lattice check command from the extension root.

## Constraints / assumptions

- The extension must work in `~/.pi/agent/extensions/` without compiling; TypeScript is loaded by pi through Jiti.
- The extension must remain compatible with `@mariozechner/pi-coding-agent` extension APIs available in the installed version.
- The extension should prefer extension APIs (`pi.registerCommand`, `pi.registerTool`, `pi.sendMessage`, `pi.appendEntry`, event hooks) over pi core modifications.
- Unlimited budget by default is a durable product decision.
- No pause/resume support is a durable product decision for this track.
- Continuation must be grounded by a separate `pi -p` audit before dispatch when the audit succeeds.
- Audit subprocess defaults are current model, medium reasoning, and a one-hour total timeout cap.
- If audit retry still fails or times out after the cap, use the predefined fallback continuation template without anchored audit details.

## Risks

- Session-tree persistence API details may differ from the preferred design; implementation must inspect installed typings before coding.
- Sending continuation as a visible user message may pollute the transcript; sending it as a custom message may still enter LLM context because pi converts custom messages to user messages. The final continuation-message design must account for this.
- Auto-continuation can surprise users if stale state is restored incorrectly; migration must fail safe to no active goal.
- Completion relies on an external `pi -p` audit. This is less biased than active-agent self-judgment, but still heuristic and must require concrete evidence plus high confidence.
- Infinite default continuation can run indefinitely if the model never marks complete and no budget is set; UI/status and `clear` must make recovery obvious.

## Open questions

- What exact `pi -p` command, retry schedule, explicit `--session <path|id>` audit session capture, and JSON extraction strategy should the implementation use for the external audit?
- Which concrete self-checkpoint artifact paths or custom session entries should the audit prefer when checkpoint data is available?
- Through which extension hook/API should the grounded continuation message be delivered?
- What exact API/source should provide “previous user message” for blank `/do-not-stop` during a running turn?
