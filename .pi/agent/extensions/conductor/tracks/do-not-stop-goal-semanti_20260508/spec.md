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
- Completion is determined by an explicit model-callable tool that can only mark the current goal `complete`.
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
- Do not implement the final continuation-message wording until Tan provides or approves the new continuation-message design.
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
- `complete` means the model explicitly marked the objective achieved through the restricted completion tool.
- Absence of a goal is represented as `null` / no current goal, not as a status.
- `turnBudget: null` means unlimited continuation turns.
- `turnsUsed` counts extension-scheduled continuation turns, not ordinary user turns.
- Goal replacement creates a new `goalId` and resets `turnsUsed`.

### Slash command behavior

`/do-not-stop` must behave as a goal command:

- `/do-not-stop` with no arguments shows the current goal summary when a goal exists.
- `/do-not-stop` with no arguments shows usage/help when no goal exists.
- `/do-not-stop <objective>` creates a new active goal when no goal exists.
- `/do-not-stop <objective>` replaces the existing goal. If interactive UI confirmation is feasible, ask before replacing; in non-UI contexts, replacement may proceed with clear status output.
- `/do-not-stop status` shows goal state, objective, turns used, turn budget, and elapsed time.
- `/do-not-stop clear` removes the current goal and stops future continuation.
- `/do-not-stop budget <n>` sets a positive turn budget on the current goal, preserving `turnsUsed`.
- `/do-not-stop budget unlimited` clears the configured turn budget.
- `/do-not-stop help` shows the supported command surface.
- `/do-not-stop pause` and `/do-not-stop resume` are unsupported and must return a clear error/help message.

Compatibility aliases are allowed only when they do not reintroduce the old toggle model. For example, `/do-not-stop repeats <n>` may be accepted as a deprecated alias for `/do-not-stop budget <n>` if tests and help text make the new meaning clear.

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

### Continuation message contract

The continuation-message design is intentionally not finalized in this spec. Implementation must isolate continuation-message construction behind a small function/module so Tan’s final design can be inserted without rewriting state management or command parsing.

Minimum contract for whatever continuation message is approved later:

- It must include the active objective.
- It must include current budget/progress facts: `turnsUsed` and `turnBudget` or `unlimited`.
- It must tell the model that the objective text is user-provided task data, not higher-priority instructions.
- It must tell the model to continue work when requirements remain.
- It must tell the model to call the completion tool only when the objective is actually achieved.
- It must avoid claiming completion solely because a budget is exhausted or because the model is stopping.

The exact wording, message role, display behavior, and whether to use `pi.sendUserMessage`, `pi.sendMessage`, `before_agent_start`, or `before_turn_response` remain open until Tan approves the continuation-message design.

### Completion tool

The extension must register a model-callable tool for completion, tentatively named `do_not_stop_update_goal` unless implementation discovers a better existing naming convention.

Tool behavior:

- The tool schema must only allow `{ status: "complete" }`.
- The tool must fail clearly if no current goal exists.
- The tool must fail clearly if the current goal is already `complete` or `budget_limited`, unless implementation chooses idempotent complete-on-complete with an explicit no-op result.
- The tool must mark the current active goal `complete`, set `completedAtMs`, persist state, refresh UI, and return a concise summary including objective, elapsed time, `turnsUsed`, and budget.
- The tool must not support `active`, `paused`, `resume`, `clear`, or `budget_limited` status updates.

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
- Active goals continue automatically after `agent_end` when idle and no pending messages exist.
- Continuation stops only when the goal is complete, budget-limited, cleared, or the scheduling gates fail.
- A configured turn budget moves the goal to `budget_limited` when exhausted; unlimited budget never exhausts by turn count.
- The model can only mark a goal complete through the restricted completion tool.
- There is no pause/resume status or user command in the supported command surface.
- Old repeat toggle state cannot cause unexpected continuation after reload.
- UI labels/status reflect active, budget-limited, complete, and no-goal states.
- Targeted regression tests prove command parsing, state transitions, scheduling gates, budget behavior, completion tool behavior, and migration from old repeat snapshots.

## Expected behaviors

- Creating a goal starts an active state immediately but does not interrupt a currently running turn unless the approved continuation-message design explicitly requires that behavior.
- Replacing a goal resets budget progress and creates a fresh `goalId`.
- Clearing a goal removes UI state and prevents scheduled dispatch from sending stale continuation messages.
- Budget exhaustion is runtime-owned. The model is not allowed to set `budget_limited`.
- Completion is model-owned through the restricted tool. The runtime does not infer completion from a final answer.
- Unsupported commands such as `pause` and `resume` return help instead of silently doing nothing.
- Non-UI sessions still persist state and schedule continuations according to the same gates.

## Scenario examples

### Scenario 1: Create an unlimited active goal

A user runs `/do-not-stop finish the lint cleanup`. No goal exists. The extension stores a new active goal with objective `finish the lint cleanup`, `turnBudget = null`, and `turnsUsed = 0`. The UI shows an active goal label with unlimited budget.

### Scenario 2: Continue after idle agent end

An active unlimited goal exists with `turnsUsed = 0`. The agent ends, `ctx.isIdle()` is true, and there are no pending messages. The extension schedules one continuation for the current `goalId`, increments `turnsUsed` to `1` only if dispatch succeeds or restores it on failure, and sends the approved continuation message.

### Scenario 3: Do not continue while pending input exists

An active goal exists. The agent ends, but `ctx.hasPendingMessages()` is true. The extension does not schedule a continuation and does not increment `turnsUsed`.

### Scenario 4: Respect finite turn budget

An active goal has `turnBudget = 2` and `turnsUsed = 2`. The agent ends while idle. The extension marks the goal `budget_limited`, persists state, refreshes UI, and does not send another continuation. The goal is not marked complete.

### Scenario 5: Unlimited budget never budget-limits by turn count

An active goal has `turnBudget = null` and `turnsUsed = 999`. The agent ends while idle. The extension may schedule another continuation because no turn-count budget exists.

### Scenario 6: Complete through restricted tool

An active goal exists. The model calls `do_not_stop_update_goal` with `{ "status": "complete" }`. The extension marks the goal complete, persists state, refreshes UI, returns a completion summary, and prevents future continuation.

### Scenario 7: Reject unsupported completion-tool statuses

The model tries to call the completion tool with `{ "status": "paused" }` or `{ "status": "budget_limited" }`. Schema validation or handler validation rejects the call. Goal state is unchanged.

### Scenario 8: Clear cancels stale scheduled continuation

An active goal schedules a continuation with goal id `A`. Before the dispatch fires, the user runs `/do-not-stop clear`. When the scheduled dispatch runs, it sees no matching active goal and sends nothing.

### Scenario 9: Pause/resume commands are not supported

A user runs `/do-not-stop pause` or `/do-not-stop resume`. The extension returns a clear help/error message saying pause/resume are unsupported and listing supported commands. Goal state is unchanged.

### Scenario 10: Old repeat snapshot does not auto-arm

After reload, the old runtime cache contains an `enabled=true` repeat snapshot. The new extension does not convert that into an active goal and does not schedule follow-up messages until the user explicitly creates a goal.

## Evidence plan (scenario → proof)

- Scenario 1: Add/update command parsing and state tests in `test/do-not-stop*.test.mjs`; assert active state shape and unlimited default.
- Scenario 2: Add/update follow-up scheduling tests in `test/do-not-stop-follow-up.test.mjs`; assert dispatch occurs only for active goals and increments/restores turns correctly.
- Scenario 3: Add/update scheduling gate tests; assert pending messages block continuation.
- Scenario 4: Add budget transition tests; assert `budget_limited` state and no dispatch.
- Scenario 5: Add unlimited budget test; assert no budget-limited transition from turn count alone.
- Scenario 6: Add completion tool handler tests; assert active → complete transition and no future dispatch.
- Scenario 7: Add schema/handler validation tests; assert unsupported statuses fail without mutation.
- Scenario 8: Add stale scheduled dispatch test; assert goal id mismatch/null goal blocks dispatch.
- Scenario 9: Add command parsing/handler tests for unsupported pause/resume commands.
- Scenario 10: Add runtime migration test in `test/do-not-stop-runtime.test.mjs`; assert old repeat snapshot does not restore as active goal.

Expected targeted verification command from repo root:

```bash
node --test test/do-not-stop*.test.mjs
```

If `lat-md` test specs are updated during implementation, also run the project’s local lattice check command from the extension root.

## Constraints / assumptions

- The extension must work in `~/.pi/agent/extensions/` without compiling; TypeScript is loaded by pi through Jiti.
- The extension must remain compatible with `@mariozechner/pi-coding-agent` extension APIs available in the installed version.
- The extension should prefer extension APIs (`pi.registerCommand`, `pi.registerTool`, `pi.sendMessage`, `pi.appendEntry`, event hooks) over pi core modifications.
- Unlimited budget by default is a durable product decision.
- No pause/resume support is a durable product decision for this track.
- Exact continuation-message content and injection mechanism are not approved yet.

## Risks

- Session-tree persistence API details may differ from the preferred design; implementation must inspect installed typings before coding.
- Sending continuation as a visible user message may pollute the transcript; sending it as a custom message may still enter LLM context because pi converts custom messages to user messages. The final continuation-message design must account for this.
- Auto-continuation can surprise users if stale state is restored incorrectly; migration must fail safe to no active goal.
- Completion relies on the model calling the tool after an evidence audit; the extension can restrict the status transition but cannot independently prove the task is complete.
- Infinite default continuation can run indefinitely if the model never marks complete and no budget is set; UI/status and `clear` must make recovery obvious.

## Open questions

- What exact continuation message should be injected, and through which extension hook/API should it be delivered?
- Should `/do-not-stop <objective>` replace an existing goal immediately in non-UI contexts, or should it fail and require `/do-not-stop clear` first?
- Should `/do-not-stop repeats <n>` remain as a deprecated alias for `/do-not-stop budget <n>`, or should old repeat terminology be hard-cut from the command surface?
- Should a completed goal remain visible in status until cleared, or should completion automatically hide the editor badge after notifying the user?
