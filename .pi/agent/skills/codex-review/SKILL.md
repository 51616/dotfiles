---
name: codex-review
description: |
  Use when: Tan wants a Codex-powered second opinion on code, diffs, plans, specs, or implementation quality in a local repo. Trigger on requests like "review this", "have codex review it", "get a second opinion", "critique this diff", "look for bugs / regressions / scope drift", or when Conductor reaches its review gate and a critical external review would help.
  Typical uses:
  - review the current repo state or a set of touched files
  - review a diff / patch / PR summary
  - review `spec.md`, `plan.md`, `resume.md`, and change evidence for contradictions or gaps
  - look for correctness, maintainability, safety, observability, and test coverage issues
  Outputs: the skill script runs Codex CLI with `gpt-5.5` and high reasoning, then returns a concise review with concrete findings, assumptions, and suggested fixes.
---

# codex-review

Use Codex CLI as a local review helper. This is for critical second-opinion review of code, plans, specs, diffs, and implementation slices. The reviewer agent can run for a long time. Use the skill script’s built-in timeout instead of wrapping it with shell `timeout` unless you intentionally want a shorter outer cap.

## Script

Run the skill script directly through pi’s skill-script tool; do not rely on a `codex-review` command being installed on PATH.

- Script URI: `skill://codex-review/scripts/codex-review`
- Interpreter: `python3`
- Default timeout: 60 minutes (`3600` seconds)

Tool arguments map to the script CLI. You only need `--timeout-seconds` when overriding the 60-minute default:

```text
["--timeout-seconds", "3600", "<prompt>"]
```

The script runs:

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort=high --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

and prints only the final agent message on success.

## Prompting guidance

Give it the minimum context needed to review precisely:
- repo/subsystem being reviewed
- relevant paths
- spec / plan / acceptance criteria
- diff summary or code snippets
- what kind of review you want: bugs, regressions, scope drift, missing tests, maintainability, safety, observability, etc.

Example tool calls:

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["Review the changes in src/auth.ts and src/auth.test.ts against conductor/tracks/<track_id>/spec.md. Focus on correctness, missing edge cases, and test gaps."],
  timeoutSeconds=3700,
)
```

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["Review conductor/tracks/<track_id>/{spec.md,plan.md,resume.md} for contradictions, ambiguous acceptance criteria, and scope drift."],
  timeoutSeconds=3700,
)
```

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["Review the current working tree for likely regressions. Return findings grouped by severity, then list the top 3 fixes."],
  timeoutSeconds=3700,
)
```

## Timeout recovery

If the script exits with code `124`, the review session still exists and is resumable.

What the script prints on timeout:
- `Session ID: <uuid>`
- `Session file: ~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl`
- a ready-to-run `codex exec resume <uuid> ...` command

Use that exact session identity. Do **not** use `codex resume --last`, `codex exec resume --last`, or “the newest file in `~/.codex/sessions`” when multiple reviews may be running concurrently. That is how you resume the wrong review.

Recovery procedure:
1. Read the exact `Session file:` path printed by the script. That JSONL file is the durable record for this review thread.
2. Inspect the tail of that exact file if you need to see how far the review got. The file contains `session_meta`, `response_item`, and `event_msg` entries. Assistant/user messages are stored as JSON objects, not plain text logs.
3. Resume the same non-interactive review with the exact `Session ID:` printed by the script:

```bash
codex exec resume <session_id> "Continue and finish the interrupted review. Reuse the existing context from this session. Return only the final review."
```

4. If you resume it, Codex appends the new turn to the **same** session file. It does not create a second session file for that same thread.

A precise file-inspection pattern:

```bash
python3 -c "from pathlib import Path; import json; p=Path('~/.codex/sessions/.../rollout-...-<session_id>.jsonl').expanduser();
for line in p.read_text().splitlines()[-40:]:
    obj=json.loads(line)
    print(obj.get('type'), obj.get('payload', {}).get('type'))"
```

If you need the last assistant text from that exact session file, extract `response_item` entries where `payload.type == "message"` and `payload.role == "assistant"`.

## Verification

Fast script sanity check:

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["--help"],
  timeoutSeconds=30,
)
```

Live Codex success path:

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["Respond with exactly: hello"],
  timeoutSeconds=120,
)
```

Timeout/recovery path:

```text
run_skill_script(
  script="skill://codex-review/scripts/codex-review",
  interpreter="python3",
  args=["--timeout-seconds", "1", "Review the current repo thoroughly and keep searching before responding."],
  timeoutSeconds=30,
)
```

On the timeout check, stderr should include the exact `Session ID`, the exact `Session file` under `~/.codex/sessions/...`, and a `codex exec resume <session_id> ...` command.
