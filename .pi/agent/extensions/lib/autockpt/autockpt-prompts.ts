const CHECKPOINT_DIR = "/tmp/pi-work/checkpoints/";

export function buildResumeSelfPing(_checkpointPath: string): string {
  return "We just auto-checkpointed and compacted context. Please continue your work.";
}

export function buildCompactionInstructions(options: {
  checkpointPath: string;
  extraInstructions?: string;
}): string {
  const extra = options.extraInstructions?.trim();
  return [
    extra ? `Compaction focus (from assistant):\n${extra}` : undefined,
    `Preserve checkpoint path (${options.checkpointPath}). Preserve current work state, milestones, goals, decisions, and next steps.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildFlagAutotestKickoffMessage(): string {
  return [
    "[autotest] Run the auto-checkpoint end-to-end test now.",
    "",
    "Do this in-order:",
    "1) Call a trivial tool (bash: echo something) so a tool result is produced.",
    "2) Context threshold is forced low for this test. As soon as the auto-checkpoint directive appears, stop normal work and follow it.",
    `3) Immediately execute the checkpointing protocol: create a checkpoint note under ${CHECKPOINT_DIR} with a detailed, reconstructable report.`,
    "   - Include what you changed/tested, and how to verify success after compaction.",
    "4) End with the compaction-instruction block + completion footer line (with checkpoint path).",
  ].join("\n");
}

export function buildCommandAutotestKickoffMessage(): string {
  return [
    "Run the auto-checkpoint end-to-end test now.",
    "",
    "Steps:",
    "1) Call a trivial tool (bash: echo something) so a tool result is produced.",
    "2) Threshold is forced low for this test. As soon as the auto-checkpoint directive appears, stop normal work and follow it.",
    `3) Immediately run the checkpointing protocol: create a new checkpoint note under ${CHECKPOINT_DIR} with a detailed, reconstructable report.`,
    "4) In that checkpoint note, explicitly record: what commands/settings you changed for the test, what you observed, and how to verify success after compaction.",
    "5) End your assistant message with the compaction-instruction block (focus compaction summary on current work/milestones/goals) and the final completion footer line containing the checkpoint path.",
  ].join("\n");
}

export function buildAutockptDirectiveMessage(): string {
  return "[autockpt] Context is about to overflow. Write a checkpoint NOW. Stop the main task for the moment. Read the `checkpointing` skill. After you finish the checkpoint note + footer, STOP. I will compact context and then send you a resume prompt automatically.";
}
