---
name: codex-review
description: |
  Use when: Tan wants a Codex-powered second opinion on code, diffs, plans, specs, or implementation quality in a local repo. Trigger on requests like "review this", "have codex review it", "get a second opinion", "critique this diff", "look for bugs / regressions / scope drift", or when Conductor reaches its review gate and a critical external review would help.
  Typical uses:
  - review the current repo state or a set of touched files
  - review a diff / patch / PR summary
  - review `spec.md`, `plan.md`, `resume.md`, and change evidence for contradictions or gaps
  - look for correctness, maintainability, safety, observability, and test coverage issues

    Outputs:
  - a concise review from Codex with concrete findings, assumptions, and suggested fixes
  - optional severity grouping when the prompt asks for it
---

# codex-review

Use Codex CLI as a local review helper. This is for critical second-opinion review of code, plans, specs, diffs, and implementation slices. The reviewer agent can run for a long time (more than ten minutes if the code is large.) Default to 20 minutes timeout.

## Command

```bash
codex-review.sh "<prompt>"
```

The helper runs:

```bash
codex exec -m gpt-5.2 -c model_reasoning_effort=high --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

and prints only the final agent message.

## Prompting guidance

Give it the minimum context needed to review precisely:
- repo/subsystem being reviewed
- relevant paths
- spec / plan / acceptance criteria
- diff summary or code snippets
- what kind of review you want (bugs, regressions, scope drift, missing tests, maintainability, etc.)

Examples:

```bash
codex-review.sh "Review the changes in src/auth.ts and src/auth.test.ts against conductor/tracks/<track_id>/spec.md. Focus on correctness, missing edge cases, and test gaps."
```

```bash
codex-review.sh "Review conductor/tracks/<track_id>/{spec.md,plan.md,resume.md} for contradictions, ambiguous acceptance criteria, and scope drift."
```

```bash
codex-review.sh "Review the current working tree for likely regressions. Return findings grouped by severity, then list the top 3 fixes."
```

## Verification

```bash
codex-review.sh "Respond with exactly: hello"
```
