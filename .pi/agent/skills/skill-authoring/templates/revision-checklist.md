# Skill revision checklist

Use this when significantly revising an existing skill.

1. Read the current `SKILL.md` and identify the routing boundary that changed.
2. Check nearby skills for overlap, especially `Use when:` clauses that could now conflict.
3. Update every supporting file that encodes the old contract:
   - `templates/`
   - `examples/`
   - `scripts/`
4. Replace generated `__FILL_ME__` markers or remove draft-only sections.
5. Run focused validation:
   - `python scripts/quick_validate.py <path/to/skill-dir>`
6. Run broad validation:
   - `python scripts/validate-all-skills.py`
7. Run any script tests or smoke tests that apply.
8. Reload pi after skill changes:
   - `/reload`
