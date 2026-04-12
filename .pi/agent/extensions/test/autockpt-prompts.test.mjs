import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAutockptDirectiveMessage,
  buildCommandAutotestKickoffMessage,
  buildCompactionInstructions,
  buildFlagAutotestKickoffMessage,
  buildResumeSelfPing,
} from "../lib/autockpt/autockpt-prompts.ts";

test("buildResumeSelfPing returns the fixed self-kickstart message", () => {
  const text = buildResumeSelfPing("work/log/checkpoints/a.md");
  assert.equal(text, "We just auto-checkpointed and compacted context. Please continue your work.");
});

test("buildCompactionInstructions merges extra instructions and fallback summary", () => {
  const text = buildCompactionInstructions({
    checkpointPath: "work/log/checkpoints/a.md",
    extraInstructions: "Keep milestones.",
  });

  assert.match(text, /Compaction focus \(from assistant\):/);
  assert.match(text, /Keep milestones\./);
  assert.match(text, /Preserve checkpoint path \(work\/log\/checkpoints\/a\.md\)/);
});

test("autotest kickoff prompts contain required checkpoints", () => {
  const flagPrompt = buildFlagAutotestKickoffMessage();
  const commandPrompt = buildCommandAutotestKickoffMessage();

  assert.match(flagPrompt, /\[autotest\]/);
  assert.match(flagPrompt, /work\/log\/checkpoints\//);
  assert.match(commandPrompt, /Steps:/);
  assert.match(commandPrompt, /final completion footer line/);
});

test("directive prompt returns the fixed reminder text", () => {
  const directive = buildAutockptDirectiveMessage();

  assert.equal(
    directive,
    "[autockpt] Context is about to overflow. Write a checkpoint NOW. Stop the main task for the moment. Read the `checkpointing` skill. After you finish the checkpoint note + footer, STOP. I will compact context and then send you a resume prompt automatically.",
  );
});
