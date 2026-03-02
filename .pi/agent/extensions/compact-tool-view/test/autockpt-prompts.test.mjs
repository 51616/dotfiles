import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommandAutotestKickoffMessage,
  buildCompactionInstructions,
  buildFlagAutotestKickoffMessage,
  buildResumeSelfPing,
} from "../lib/autockpt/autockpt-prompts.ts";

test("buildResumeSelfPing includes checkpoint path", () => {
  const text = buildResumeSelfPing("work/log/checkpoints/a.md");
  assert.match(text, /Resume using checkpoint: work\/log\/checkpoints\/a\.md/);
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
