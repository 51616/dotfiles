---
name: preference-audit-interview
description: Run a focused interview to identify outdated user preferences/info and update AGENTS.md/USER_PROFILE.md with explicit memory diffs.
---

# preference-audit-interview

## Goal

Refresh stale preferences and profile facts with minimal friction, then persist updates clearly.

## Required opening (always)

Before asking question 1, state:
1) what the interview is about (scope), and
2) how many questions are planned.

Use this pattern:
- "We’ll do a quick preference/profile audit focused on <scope>."
- "Plan: <N> questions."

If new issues emerge mid-way, ask permission before extending:
- "I found 2 more cleanup items. Want to extend to 2 extra questions?"

## Default structure

- Keep it one question at a time.
- Prefer multiple-choice with A/B/C plus "custom".
- Ask high-impact items first (stale assumptions, defaults that change behavior).
- Keep each question decision-ready (clear tradeoff, easy choice).

Suggested 10-question template:
1. Communication mode default
2. Collaboration style (options + tradeoffs vs execute)
3. Decision-framing preference
4. Daily-note rigor (artifact pointers)
5. Worker async/sync default
6. Notification surface defaults
7. Tooling/ops assumptions (stale implementation details)
8. Core identity facts (role, timezone, pronouns)
9. Open questions still unresolved?
10. Consolidation preference (removals only vs light merge)

## Write-back rules

When user confirms changes, update with minimal edits:
- `AGENTS.md` for assistant behavior rules.
- `USER_PROFILE.md` for durable user profile facts/preferences.

After each edit batch, report a memory diff:
- file path
- what changed (added/removed/updated)
- confidence label (`explicit` vs `inferred`)

## Guardrails

- Don’t rewrite voice/structure unless asked.
- Don’t add high-inference personality claims without explicit confirmation.
- If user says "remove", delete rather than reword.
- If user asks for "light consolidation", merge duplicates without behavior changes.

## Meta-lessons from the 2026-02-14 run

- Keep momentum by using fast keep/remove/update decisions first; defer wording polish to the end.
- Prioritize stale operational assumptions early (integration access, implementation-specific infra details).
- Preserve user trust with explicit memory diffs after each confirmed change.
- Keep interview cadence tight: one question, one decision, then immediate write-back.
- Separate stable defaults (`AGENTS.md`) from volatile context (`USER_PROFILE.md` or project notes).
