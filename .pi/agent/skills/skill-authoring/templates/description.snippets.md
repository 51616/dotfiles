## Description snippets (routing-grade)

The `description` field is the routing boundary. Keep it concrete.

Practical tip: use a YAML block scalar (`description: |`) so colons don’t break parsing.

### Minimal

Use when: <concrete trigger>
Don’t use when: <common confusion> (use <other-skill> instead)

### With negative examples

Use when:
- <trigger 1>
- <trigger 2>

Don’t use when:
- <confusable case 1> → use <other-skill>
- <confusable case 2> → do <alternative>

### Example (good)

Use when: creating standardized incident debrief notes from raw logs.
Don’t use when: you just need a quick summary in chat (answer directly).
