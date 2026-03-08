---
name: skill-authoring
description: |
  Use when: creating a new skill or significantly revising an existing skill (routing text, workflow, templates/scripts/examples).
  Don’t use when: you’re just executing an existing workflow (use that workflow’s skill instead).
  Outputs: an updated skill folder with routing-grade frontmatter + a short SKILL.md + any needed templates/examples/scripts + at least one verification step.
---

# skill-authoring

Use this skill when you (pi) are about to create or significantly revise another skill.

## Core principles (a.k.a. “skill creator” rules)

Be concise in workflow/body sections, but be explicit in routing. Context is scarce, yet unclear `Use when` clauses are more expensive than a few extra lines.

Match constraints to fragility:
- High freedom: text guidance when many approaches are OK.
- Low freedom: scripts/templates when mistakes are expensive.

Design for progressive disclosure:
- `description` routes.
- `SKILL.md` is the minimal workflow + links.
- Heavy stuff lives in `templates/`, `examples/`, `scripts/`.

## Authoring checklist

1) **Name + scope**
- Use a stable, specific, hyphen-case name.
- Decide the success artifacts (files created/edited, commands run, outputs produced).

2) **Frontmatter (routing)**
- Only include `name` and `description` in YAML frontmatter.
- Write `description` as a routing contract:
  - Use when … *(be elaborate: triggers, phrases Tan might say, scope boundaries, preconditions)*
  - Don’t use when … *(name nearby alternatives and where to route instead)*
  - Outputs … *(concrete artifacts + success criteria)*
- Be explicit enough that another agent can route without guessing. Model it after strong examples like `conductor` and `pi-architecture`.

3) **Body (workflow)**
- Keep SKILL.md short: template + flow.
- Use imperative phrasing.
- Link to supporting files instead of embedding long content.

4) **Split supporting material**
- `templates/`: starting points to copy/paste
- `examples/`: worked outputs
- `scripts/`: deterministic helpers + smoke tests

Avoid dumping extra docs into the skill folder (README/quickref/changelog). Put only what’s needed to execute.

5) **Verification**
- Add at least one concrete verification step (command or observable check).

## Start here

- Skill skeleton: `templates/SKILL.md.template`
- Description snippets: `templates/description.snippets.md`

## Scripts

- Create a new skill folder from templates:
  - `bash scripts/init-skill.sh <skill-name> [--shared|--vault]`
  - By default it prefers `~/.pi/agent/skills/<skill-name>` and then symlinks into `$PI_VAULT_ROOT/.pi/skills/<skill-name>` when possible.

- Validate a skill’s frontmatter quickly (no external YAML deps):
  - `python3 scripts/quick_validate.py <path/to/skill-dir>`
