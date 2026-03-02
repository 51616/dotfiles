export function buildResumeSelfPing(checkpointPath: string): string {
  return (
    `We just auto-checkpointed and compacted context. Resume using checkpoint: ${checkpointPath}.\n` +
    `Continue from the Next steps section in that checkpoint. If anything is missing due to compaction, open the checkpoint file and continue from there.`
  );
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
    "2) Verify the tool result includes the context stamp and the checkpoint-required marker (threshold forced low for test).",
    "3) Immediately execute the checkpointing protocol: create a checkpoint note under work/log/checkpoints/ with a detailed, reconstructable report.",
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
    "2) Confirm the tool result output includes the context stamp and the checkpoint-required marker (threshold is forced low for the test).",
    "3) Immediately run the checkpointing protocol: create a new checkpoint note under work/log/checkpoints/ with a detailed, reconstructable report.",
    "4) In that checkpoint note, explicitly record: what commands/settings you changed for the test, what you observed, and how to verify success after compaction.",
    "5) End your assistant message with the compaction-instruction block (focus compaction summary on current work/milestones/goals) and the final completion footer line containing the checkpoint path.",
  ].join("\n");
}

export function buildAutockptDirectiveMessage(): string {
  return [
    "[autockpt] Context is about to overflow. Write a checkpoint NOW. Stop the main task for the moment. Read the `checkpointing` skill.",
    "After you finish the checkpoint note + footer, STOP. I will compact context and then send you a resume prompt automatically.",
    "",
    "   Follow these steps immediately (in order):",
    "   1) Create a checkpoint note under work/log/checkpoints/ (JST filename: YYYY-MM-DD_HHMM_<slug>.md).",
    "   2) Make it reconstructable: objective/spec, current implementation state, decisions, open questions/risks, artifact pointers, next steps + verification commands.",
    "   3) End THIS assistant message with the compaction footer (raw text, NOT inside a code block):",
    "      __pi_compact_instructions_begin__",
    "      <what the compaction summary must preserve/emphasize>",
    "      __pi_compact_instructions_end__",
    "      __pi_autocheckpoint_done__ path=<checkpoint_path>",
    "",
    "   Hard requirements:",
    "   - Do not do any other work until the checkpoint note + footer are complete.",
    "   - The footer must be the last non-whitespace content in the message.",
  ].join("\n");
}
