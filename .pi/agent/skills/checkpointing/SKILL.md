---
name: checkpointing
description: |
  Use when: work is multi-step/long-horizon, interruption risk is high, OR when the [autockpt] directive appears.
---

# checkpointing

## Flow

1) Create a checkpoint note file under `/tmp/pi-work/checkpoints/`.
- Filename: `YYYY-MM-DD_HHMM_<slug>.md` (JST)

2) Fill it using the template:
- `templates/checkpoint.template.md`

3) Make it resumable:
- include a **Conversation overview** (high-signal, current goal + constraints + key decisions)
- include the **last 3 user messages** (verbatim, most recent first)
  - if a message is extremely long, paste it in a fenced block; only truncate as a last resort and mark it clearly
- link to concrete artifacts (paths, commands, job ids, commits)
- write next steps + how to verify/resume

4) If you’re working from a Conductor track, keep the repo-native resume up to date:
- update `conductor/tracks/<track_id>/resume.md` with the current state + next steps
- keep it consistent with the checkpoint information (artifacts/pointers/next steps)

5) If this checkpoint was triggered by the **[autockpt]** directive, end your *assistant message* with the compaction footer (raw text, not inside a fenced code block):

__pi_compact_instructions_begin__
Preserve/emphasize:
- the conversation overview (why we’re here + what “done” means)
- the last 3 user messages (verbatim if possible)
- current state, key decisions/constraints, and any open questions
- concrete artifacts (paths/branches/commits/commands/logs) needed to resume
- next steps + verification
__pi_compact_instructions_end__
__pi_autocheckpoint_done__ path=<checkpoint_path>

## Script

For a consistent filename + template copy, run the helper script from this skill directory:

```bash
bash scripts/new-checkpoint.sh <slug>
```

## Verification

- Confirm the checkpoint file exists and includes resume context, concrete artifacts, next steps, and verification instructions.
- If the checkpoint came from a Conductor track, confirm `conductor/tracks/<track_id>/resume.md` matches the checkpoint state.
