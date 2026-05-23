## Description snippets (routing-grade)

The `description` field is the routing boundary. Keep it concrete enough that another agent can decide whether to load the skill without opening the whole file.

Practical tip: use a YAML block scalar (`description: |`) so colons don’t break parsing.

### Required minimum

Use when: <concrete trigger(s), scope boundaries, and preconditions>

### With exclusions

Use when: <concrete trigger(s), scope boundaries, and preconditions>
Don’t use when: <nearby case that should route somewhere else> (use <other-skill> or <alternative> instead).

### With expected outputs

Use when: <concrete trigger(s), scope boundaries, and preconditions>
Outputs: <one sentence describing the concrete artifacts and success criteria>.

### Full routing contract

Use when: <concrete trigger(s), scope boundaries, and preconditions>.
Don’t use when: <nearby case that should route somewhere else> (use <other-skill> or <alternative> instead).
Outputs: <one sentence describing the concrete artifacts and success criteria>.

### Example (good)

Use when: creating standardized incident debrief notes from raw logs after an outage, crash, data loss event, or failed automation run.
Don’t use when: you just need a quick summary in chat (answer directly).
Outputs: a filled incident note is written to the expected location and includes the required timeline, root cause, and follow-up sections.
