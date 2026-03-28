---
name: showboat-demo
description: |
  Use when: you want a runnable, markdown "proof-of-work" artifact using Showboat (notes + executable code blocks + captured output), usually as evidence for a Conductor track.
  Common triggers: "capture evidence", "make a demo doc", "record the repro", "prove it", "runnable transcript", "show the commands and outputs".

  Don’t use when: the work is better captured as normal Conductor artifacts only (`spec.md` / `plan.md` / `resume.md` + tests). Don’t use as a full command-by-command session log.

  Outputs: a Showboat demo doc (default: `conductor/tracks/<track_id>/evidence/showboat.md`) that can be re-run with `showboat verify` to confirm outputs still match.
---

# showboat-demo

Showboat creates Markdown docs that mix commentary, executable code blocks, and captured output, with a verifier that re-runs the blocks and diffs outputs.

For detailed CLI usage, defer to:
- `uvx showboat --help` (recommended one-shot)

## Conductor placement (default)

Option A (milestone-only): update the demo doc only at key checkpoints:
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied (smallest commands that prove the change)
- final verification (tests/lint/build + any relevant manual checks)

Treat `showboat verify` as part of the Conductor Phase 3 (Verification).

## Flow

1) Pick the demo doc location
- Conductor default: `conductor/tracks/<track_id>/evidence/showboat.md`

2) Initialize the document
- `uvx showboat init conductor/tracks/<track_id>/evidence/showboat.md "<title>"`

3) Append milestone notes + commands
- Add commentary: `uvx showboat note <file> "..."`
- Run commands and capture output: `uvx showboat exec <file> bash "..."`
  - Use `python`/`python3` blocks when that’s clearer than shell.

4) Keep it short and re-runnable
- Prefer stable commands (pinned versions, deterministic flags, explicit working directory).
- Use `showboat pop <file>` to remove a bad/accidental entry.

5) Verify
- `uvx showboat verify conductor/tracks/<track_id>/evidence/showboat.md`

## Verification (skill)

- `uvx showboat --help`
