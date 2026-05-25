import test from "node:test";
import assert from "node:assert/strict";
import {
  brightRed,
  buildGoalBorderLabel,
  formatDurationMs,
  formatGoalCompletionStats,
  formatGoalStatusSummary,
  formatTokenCount,
  parseGoalCommand,
  validateGoalObjective,
} from "../goal/lib/goal.ts";
import { parseAuditResult, isHighConfidenceComplete } from "../goal/lib/goal-audit.ts";
import { buildAnchoredContinuationMessage, buildFallbackContinuationMessage, buildInitialGoalMessage } from "../goal/lib/goal-continuation.ts";
import {
  createGoal,
  incrementGoalTurnsUsed,
  markGoalBudgetLimited,
  markGoalCompleteFromAudit,
  setGoalBudget,
  shouldBudgetLimitGoal,
  shouldScheduleGoalContinuation,
} from "../goal/lib/goal-state.ts";
import { buildAuditPrompt, findPreviousUserMessageForGoal } from "../goal/lib/goal-session.ts";

test("brightRed wraps text with ANSI bright-red sequence", () => {
  assert.equal(brightRed("abc"), "\x1b[91mabc\x1b[0m");
});

test("goal completion stats format turns, elapsed time, and tokens", () => {
  const goal = createGoal("finish stats", { goalId: "stats", nowMs: 1_000 });
  const completed = markGoalCompleteFromAudit(
    incrementGoalTurnsUsed(incrementGoalTurnsUsed(goal, 20_000), 40_000),
    {
      decision: "complete",
      confidence: "high",
      summary: "done",
      completedItems: [],
      remainingItems: [],
      evidence: ["test"],
      sourcePaths: ["test"],
      continuationMessage: "",
    },
    66_000,
  );

  assert.equal(formatDurationMs(65_000), "1m 5s");
  assert.equal(formatTokenCount(12345), "12,345");
  assert.equal(
    formatGoalCompletionStats(completed, { totalTokens: 12345, cacheReadTokens: 67890 }),
    "2 turns, 1m 5s total time used, 12,345 total tokens used (+67,890 cache read)",
  );
});

test("parseGoalCommand handles goal command surface", () => {
  assert.deepEqual(parseGoalCommand(""), { kind: "blank" });
  assert.deepEqual(parseGoalCommand("status"), { kind: "status" });
  assert.deepEqual(parseGoalCommand("clear"), { kind: "clear" });
  assert.deepEqual(parseGoalCommand("budget 10"), { kind: "setBudget", turnBudget: 10 });
  assert.deepEqual(parseGoalCommand("budget unlimited"), { kind: "setBudget", turnBudget: null });
  assert.deepEqual(parseGoalCommand("replace finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: true,
  });
  assert.deepEqual(parseGoalCommand("--replace finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: true,
  });
  assert.deepEqual(parseGoalCommand("finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: false,
  });
});

test("validateGoalObjective rejects vague non-verifiable objectives", () => {
  assert.equal(validateGoalObjective("goal").ok, false);
  assert.match(validateGoalObjective("goal").guidance ?? "", /concrete, verifiable objective/);
  assert.equal(validateGoalObjective("do it").ok, false);
  assert.equal(validateGoalObjective("fix the failing auth tests and commit the fix").ok, true);
  assert.equal(validateGoalObjective("go to work!").ok, true);
});

test("parseGoalCommand rejects removed pause/resume/repeats controls", () => {
  assert.equal(parseGoalCommand("pause").kind, "unsupported");
  assert.equal(parseGoalCommand("resume").kind, "unsupported");
  assert.equal(parseGoalCommand("on").kind, "unsupported");
  assert.equal(parseGoalCommand("off").kind, "unsupported");
  assert.equal(parseGoalCommand("toggle").kind, "unsupported");
  const repeats = parseGoalCommand("repeats 3");
  assert.equal(repeats.kind, "unsupported");
  assert.match(repeats.guidance, /budget <n>/);
});

test("goal state helpers create, budget-limit, complete, and schedule safely", () => {
  const goal = createGoal("  finish   lint cleanup ", { nowMs: 1000, goalId: "goal-1" });
  assert.equal(goal.objective, "finish lint cleanup");
  assert.equal(goal.turnBudget, null);
  assert.equal(goal.turnsUsed, 0);
  assert.equal(goal.status, "active");
  assert.equal(buildGoalBorderLabel(goal), "⚑ goal |");

  const budgeted = setGoalBudget(goal, 1, 1100);
  assert.equal(shouldBudgetLimitGoal(budgeted), false);
  assert.equal(
    shouldScheduleGoalContinuation({ goal: budgeted, isIdle: true, hasPendingMessages: false, dispatchScheduled: false }),
    true,
  );

  const used = incrementGoalTurnsUsed(budgeted, 1200);
  assert.equal(shouldBudgetLimitGoal(used), true);
  assert.equal(
    shouldScheduleGoalContinuation({ goal: used, isIdle: true, hasPendingMessages: false, dispatchScheduled: false }),
    false,
  );

  const limited = markGoalBudgetLimited(used, 1300);
  assert.equal(limited.status, "budget_limited");
  assert.equal(buildGoalBorderLabel(limited), "⚑ goal |");

  const complete = markGoalCompleteFromAudit(goal, {
    decision: "complete",
    confidence: "high",
    summary: "lint cleanup verified",
    completedItems: ["lint cleanup"],
    remainingItems: [],
    evidence: ["npm test passed"],
    sourcePaths: ["package.json"],
    continuationMessage: "",
  }, 1500);
  assert.equal(complete.status, "complete");
  assert.equal(complete.completedAtMs, 1500);
  assert.match(formatGoalStatusSummary(complete, 1600), /completion: lint cleanup verified/);
});

test("audit parser accepts strict JSON and only high-confidence complete can stop", () => {
  const audit = parseAuditResult(JSON.stringify({
    decision: "complete",
    confidence: "high",
    summary: "done",
    completedItems: ["implemented"],
    remainingItems: [],
    evidence: ["tests passed"],
    sourcePaths: ["test/goal.test.mjs"],
    continuationMessage: "",
  }));
  assert.equal(isHighConfidenceComplete(audit), true);

  const medium = parseAuditResult(JSON.stringify({ decision: "complete", confidence: "medium", summary: "maybe" }));
  assert.equal(isHighConfidenceComplete(medium), false);
  const noEvidence = parseAuditResult(JSON.stringify({ decision: "complete", confidence: "high", summary: "done" }));
  assert.equal(isHighConfidenceComplete(noEvidence), false);
  assert.throws(() => parseAuditResult("not json"), /JSON object/);
  assert.throws(
    () => parseAuditResult(`The answer is ${JSON.stringify({ decision: "complete", confidence: "high", summary: "done", evidence: ["x"], sourcePaths: ["y"] })}`),
    /exactly one JSON object/,
  );
});

test("continuation messages include objective, budget, audit progress, and guardrails", () => {
  const goal = createGoal("finish the migration", { nowMs: 1000, goalId: "goal-1" });
  const audit = {
    decision: "continue",
    confidence: "high",
    summary: "tests are still failing",
    completedItems: ["updated parser"],
    remainingItems: ["fix runtime test"],
    evidence: ["node --test failed"],
    sourcePaths: ["test/goal-runtime.test.mjs"],
    continuationMessage: "Fix the runtime test next.",
  };

  const initial = buildInitialGoalMessage(goal);
  assert.match(initial, /^Objective:\nfinish the migration/m);
  assert.doesNotMatch(initial, /Do not stop until everything is complete, test, and verified/);
  assert.match(initial, /Instructions:\n- Inspect the current session and repo state before changing files\./);
  assert.doesNotMatch(initial, /Budget\/progress/);
  assert.doesNotMatch(initial, /completion is checked by later external audits/);
  assert.doesNotMatch(initial, /budget-limited, or the user clears the goal/);

  const anchored = buildAnchoredContinuationMessage(goal, audit);
  assert.match(anchored, /Original objective:\nfinish the migration/);
  assert.match(anchored, /updated parser/);
  assert.match(anchored, /Fix the runtime test next/);
  assert.match(anchored, /Do not repeat completed work/);
  assert.doesNotMatch(anchored, /Continue the active \/goal objective/);
  assert.doesNotMatch(anchored, /Budget\/progress/);
  assert.doesNotMatch(anchored, /Audit source paths/);
  assert.doesNotMatch(anchored, /turn budget is exhausted/);
  assert.doesNotMatch(anchored, /budget-limited, or the user clears the goal/);

  const fallback = buildFallbackContinuationMessage(goal, "audit timed out");
  assert.match(fallback, /audit timed out/);
  assert.match(fallback, /Inspect the current session\/repo state/);
  assert.doesNotMatch(fallback, /Continue the active \/goal objective/);
  assert.doesNotMatch(fallback, /Budget\/progress/);
});

test("session helpers find previous user messages and build audit prompts", () => {
  const previous = findPreviousUserMessageForGoal([
    { type: "message", message: { role: "user", content: "/session" } },
    { type: "message", message: { role: "user", content: "fix the failing auth tests" } },
  ]);
  assert.equal(previous, "fix the failing auth tests");

  // Regression: goal continuations start with "Original objective:\n" or "Objective:\n".
  // findPreviousUserMessageForGoal must skip them so blank /goal adopts the human-typed
  // message, not the most recent audit transcript.
  const initial = buildInitialGoalMessage(createGoal("finish the migration", { goalId: "g1", nowMs: 1000 }));
  const anchored = buildAnchoredContinuationMessage(
    createGoal("finish the migration", { goalId: "g1", nowMs: 1000 }),
    {
      decision: "continue", confidence: "high", summary: "x",
      completedItems: [], remainingItems: ["next"], evidence: ["e"],
      sourcePaths: ["p"], continuationMessage: "next concrete step",
    },
  );
  const fallback = buildFallbackContinuationMessage(
    createGoal("finish the migration", { goalId: "g1", nowMs: 1000 }),
    "audit timed out",
  );
  const skipsContinuations = findPreviousUserMessageForGoal([
    { type: "message", message: { role: "user", content: "fix the failing auth tests" } },
    { type: "message", message: { role: "user", content: initial } },
    { type: "message", message: { role: "user", content: anchored } },
    { type: "message", message: { role: "user", content: fallback } },
  ]);
  assert.equal(skipsContinuations, "fix the failing auth tests");

  const prompt = buildAuditPrompt({
    goal: createGoal("finish docs", { goalId: "goal-2", nowMs: 1000 }),
    cwd: "/repo",
    sessionFile: "/tmp/session.jsonl",
    checkpointDir: "/tmp/pi-work/checkpoints",
    conductorDir: "/repo/conductor/tracks",
  });
  assert.match(prompt, /strict JSON only/);
  assert.match(prompt, /finish docs/);
  assert.match(prompt, /Current session file: \/tmp\/session.jsonl/);
});
