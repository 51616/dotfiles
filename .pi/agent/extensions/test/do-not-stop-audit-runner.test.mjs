import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAuditCommandArgs, runDoNotStopAudit } from "../do-not-stop/lib/do-not-stop-audit-runner.ts";

test("buildAuditCommandArgs uses print mode, current model, medium thinking, and explicit session", () => {
  const args = buildAuditCommandArgs({
    prompt: "audit prompt",
    model: { provider: "openai", id: "gpt-test" },
    auditSessionPath: "/tmp/audit-session.jsonl",
  });

  assert.deepEqual(args, [
    "-p",
    "--model",
    "openai/gpt-test",
    "--thinking",
    "medium",
    "--session",
    "/tmp/audit-session.jsonl",
    "audit prompt",
  ]);
  assert.equal(args.includes("-c"), false);
  assert.equal(args.includes("--continue"), false);
});

test("buildAuditCommandArgs carries pi-ssh target without using continue", () => {
  const args = buildAuditCommandArgs({
    prompt: "audit prompt",
    auditSessionPath: "/tmp/audit-session.jsonl",
    ssh: { remote: "gpu-box", port: 2222, remoteCwd: "/remote/worktree" },
  });

  assert.deepEqual(args, [
    "-p",
    "--ssh",
    "gpu-box:/remote/worktree",
    "--ssh-port",
    "2222",
    "--thinking",
    "medium",
    "--session",
    "/tmp/audit-session.jsonl",
    "audit prompt",
  ]);
  assert.equal(args.includes("-c"), false);
  assert.equal(args.includes("--continue"), false);
});

test("runDoNotStopAudit retries with the same explicit session and parses JSON", async () => {
  const calls = [];
  let now = 0;
  const auditDir = join(tmpdir(), `do-not-stop-audit-test-${process.pid}-${Date.now()}`);
  const auditSessionPath = join(auditDir, "audit-session.jsonl");
  rmSync(auditDir, { recursive: true, force: true });
  const outcome = await runDoNotStopAudit({
    prompt: "audit prompt",
    cwd: "/repo",
    model: { provider: "anthropic", id: "claude-test" },
    auditSessionPath,
    maxTotalMs: 1000,
    perAttemptMaxMs: 500,
    retryDelayMs: 10,
    nowMs: () => now,
    waitMs: async (ms) => {
      now += ms;
    },
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      now += 100;
      if (calls.length === 1) {
        return { stdout: "", stderr: "boom", code: 1, killed: false };
      }
      return {
        stdout: JSON.stringify({
          decision: "continue",
          confidence: "high",
          summary: "not done",
          completedItems: ["planned"],
          remainingItems: ["implement"],
          evidence: ["plan.md"],
          sourcePaths: ["conductor/tracks/x/plan.md"],
          continuationMessage: "Implement next.",
        }),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(existsSync(auditDir), true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.audit.decision, "continue");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "pi");
    assert.equal(call.args.includes("--session"), true);
    assert.equal(call.args[call.args.indexOf("--session") + 1], auditSessionPath);
    assert.equal(call.args.includes("-c"), false);
    assert.equal(call.args.includes("--continue"), false);
  }
});

test("runDoNotStopAudit returns fallback after timeout cap without completion", async () => {
  let now = 0;
  const outcome = await runDoNotStopAudit({
    prompt: "audit prompt",
    cwd: "/repo",
    auditSessionPath: "/tmp/audit-session.jsonl",
    maxTotalMs: 250,
    perAttemptMaxMs: 100,
    retryDelayMs: 25,
    nowMs: () => now,
    waitMs: async (ms) => {
      now += ms;
    },
    exec: async () => {
      now += 100;
      return { stdout: "not json", stderr: "", code: 0, killed: false };
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.audit.decision, "unknown");
  assert.equal(outcome.audit.confidence, "low");
  assert.match(outcome.failureReason, /JSON object/);
});
