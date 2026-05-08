import test from "node:test";
import assert from "node:assert/strict";
import {
  brightRed,
  buildDoNotStopBorderLabel,
  formatGoalStatusSummary,
  parseDoNotStopCommand,
} from "../do-not-stop/lib/do-not-stop.ts";
import { parseAuditResult, isHighConfidenceComplete } from "../do-not-stop/lib/do-not-stop-audit.ts";
import { buildAnchoredContinuationMessage, buildFallbackContinuationMessage, buildInitialGoalMessage } from "../do-not-stop/lib/do-not-stop-continuation.ts";
import {
  createGoal,
  incrementGoalTurnsUsed,
  markGoalBudgetLimited,
  markGoalCompleteFromAudit,
  setGoalBudget,
  shouldBudgetLimitGoal,
  shouldScheduleGoalContinuation,
} from "../do-not-stop/lib/do-not-stop-state.ts";
import { buildAuditPrompt, findPreviousUserMessageForGoal } from "../do-not-stop/lib/do-not-stop-session.ts";

test("brightRed wraps text with ANSI bright-red sequence", () => {
  assert.equal(brightRed("abc"), "\x1b[91mabc\x1b[0m");
});

test("parseDoNotStopCommand handles goal command surface", () => {
  assert.deepEqual(parseDoNotStopCommand(""), { kind: "blank" });
  assert.deepEqual(parseDoNotStopCommand("status"), { kind: "status" });
  assert.deepEqual(parseDoNotStopCommand("clear"), { kind: "clear" });
  assert.deepEqual(parseDoNotStopCommand("budget 10"), { kind: "setBudget", turnBudget: 10 });
  assert.deepEqual(parseDoNotStopCommand("budget unlimited"), { kind: "setBudget", turnBudget: null });
  assert.deepEqual(parseDoNotStopCommand("replace finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: true,
  });
  assert.deepEqual(parseDoNotStopCommand("--replace finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: true,
  });
  assert.deepEqual(parseDoNotStopCommand("finish the lint cleanup"), {
    kind: "setObjective",
    objective: "finish the lint cleanup",
    replace: false,
  });
});

test("parseDoNotStopCommand rejects removed pause/resume/repeats controls", () => {
  assert.equal(parseDoNotStopCommand("pause").kind, "unsupported");
  assert.equal(parseDoNotStopCommand("resume").kind, "unsupported");
  assert.equal(parseDoNotStopCommand("on").kind, "unsupported");
  assert.equal(parseDoNotStopCommand("off").kind, "unsupported");
  assert.equal(parseDoNotStopCommand("toggle").kind, "unsupported");
  const repeats = parseDoNotStopCommand("repeats 3");
  assert.equal(repeats.kind, "unsupported");
  assert.match(repeats.guidance, /budget <n>/);
});

test("goal state helpers create, budget-limit, complete, and schedule safely", () => {
  const goal = createGoal("  finish   lint cleanup ", { nowMs: 1000, goalId: "goal-1" });
  assert.equal(goal.objective, "finish lint cleanup");
  assert.equal(goal.turnBudget, null);
  assert.equal(goal.turnsUsed, 0);
  assert.equal(goal.status, "active");
  assert.equal(buildDoNotStopBorderLabel(goal), "goal active 0/∞");

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
  assert.equal(buildDoNotStopBorderLabel(limited), "goal budget-limited 1/1");

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
    sourcePaths: ["test/do-not-stop.test.mjs"],
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
    sourcePaths: ["test/do-not-stop-runtime.test.mjs"],
    continuationMessage: "Fix the runtime test next.",
  };

  const initial = buildInitialGoalMessage(goal);
  assert.match(initial, /^Objective:\nfinish the migration/m);
  assert.match(initial, /Do not stop until everything is complete, test, and verified\. Write your findings and progress down as you go\./);
  assert.doesNotMatch(initial, /Budget\/progress/);
  assert.doesNotMatch(initial, /completion is checked by later external audits/);
  assert.doesNotMatch(initial, /budget-limited, or the user clears the goal/);

  const anchored = buildAnchoredContinuationMessage(goal, audit);
  assert.match(anchored, /Original objective:\nfinish the migration/);
  assert.match(anchored, /updated parser/);
  assert.match(anchored, /Fix the runtime test next/);
  assert.match(anchored, /Do not repeat completed work/);
  assert.doesNotMatch(anchored, /Continue the active \/do-not-stop goal/);
  assert.doesNotMatch(anchored, /Budget\/progress/);
  assert.doesNotMatch(anchored, /Audit source paths/);
  assert.doesNotMatch(anchored, /turn budget is exhausted/);
  assert.doesNotMatch(anchored, /budget-limited, or the user clears the goal/);

  const fallback = buildFallbackContinuationMessage(goal, "audit timed out");
  assert.match(fallback, /audit timed out/);
  assert.match(fallback, /Inspect the current session\/repo state/);
  assert.doesNotMatch(fallback, /Continue the active \/do-not-stop goal/);
  assert.doesNotMatch(fallback, /Budget\/progress/);
});

test("session helpers find previous user messages and build audit prompts", () => {
  const previous = findPreviousUserMessageForGoal([
    { type: "message", message: { role: "user", content: "/session" } },
    { type: "message", message: { role: "user", content: "fix the failing auth tests" } },
  ]);
  assert.equal(previous, "fix the failing auth tests");

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
