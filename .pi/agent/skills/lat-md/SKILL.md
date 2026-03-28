---
name: lat-md
description: |
  Writing and maintaining lat.md documentation — a linked markdown knowledge graph anchored to code via @lat: comments. Use when creating, editing, or reviewing files under a repo’s lat.md/ directory.
---

# lat-md

This skill covers how we use `lat.md/` in a repo: section structure, linking conventions, and the drift checks (`lat check`) that keep docs and code aligned.

This skill is about authoring and maintaining the lattice. It is not about semantic search; ignore `lat search` for now.

## Core workflow

When working in a repo that contains `lat.md/`:

1. Navigate by section name:
   - `lat locate "<query>"`
   - `lat section "<file#Heading...>"`
   - `lat refs "<file#Heading...>"` (use `--scope=md`, `--scope=code`, or `--scope=md+code`)
2. Update the relevant `lat.md/*.md` sections as you change behavior/architecture.
3. Anchor implementation back to concepts with code comments:
   - JS/TS/etc: `// @lat: [[file#Heading]]`
   - Python: `# @lat: [[file#Heading]]`
4. Run drift checks:
   - `lat check` (or `lat check md` / `lat check code-refs`)

If the lattice lives in a subproject root, run with `--dir`:

- `lat --dir path/to/subproject check`

## Section rules (enforced by `lat check`)

- Every heading must have a leading paragraph: at least one sentence immediately after the heading, before any child headings.
- The first paragraph must be ≤250 characters (wiki link syntax is ignored for the count).

## Linking

Use wiki links to connect concepts:

- `[[other-file#Section]]`
- `[[other-file#Section|alias]]`

You can also link to code symbols (validated by `lat check md`) for supported languages:

- `[[src/foo.ts#myFunction]]`
- `[[src/app.py#MyClass#method]]`

## What belongs in `lat.md/`

Write **what** and **why** (contracts, invariants, responsibilities, reasoning). Don’t duplicate code.

Good:
- architecture boundaries and invariants
- domain concepts and business rules
- protocols and contracts
- test specs (what is tested and why)

Bad:
- step-by-step code walkthroughs
- temporary TODO dumps
- tests that exist without an approved behavior/scenario backing them

## Non-goal

Do not set up or depend on `lat search` or embedding keys as part of normal work right now.
