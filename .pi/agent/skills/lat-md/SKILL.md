---
name: lat-md
description: |
  Use when: creating, editing, or reviewing a repo’s `.lat-md/` lattice docs or `@lat:` anchors. Also use when a refactor, new entrypoint, new artifact contract, or new legacy/deprecated boundary has made the lattice vague or stale and you want it brought back in sync with the code.
  Outputs: updated `.lat-md/` docs in the correct owning directory or thin root `.lat-md/`, updated `@lat:` anchors when behavior or ownership changed, exact wiki links that resolve, and a verification step using the shared `scripts/run-lat.sh` helper.
---

# lat-md

This skill covers how we use `.lat-md/` in a repo: section structure, link conventions, and the drift checks that keep docs and code aligned.

Lattices should be distributed under owning directories. Put local docs next to the code or docs they describe, such as `src/.lat-md/`, `scripts/.lat-md/`, `tests/.lat-md/`, `docs/.lat-md/`, or `webui/.lat-md/`. Keep the root `.lat-md/` thin and limited to cross-cutting repo concepts like top-level maps and workflows.

Wiki links resolve logically across nested lattices. For example, `[[src/index#Package boundaries]]` should resolve to `src/.lat-md/index.md`, and `[[workflows#Training workflow]]` should resolve to `.lat-md/workflows.md`.

## Write tight lattices

Audit the code first, then write the lattice. Do not paraphrase stale lattice text back into the repo.

For each touched section:
- name the canonical file or entrypoint exactly
- say what it owns and what boundary it hands off to
- state the contract or invariant other code relies on
- mention legacy or brittle paths only when they materially affect routing or user expectations
- stay concrete; avoid filler like “handles various things” or “contains utilities” unless you immediately name the specific contract

Good lattice prose is short and sharp. It should help a later session answer “where is the real boundary?” without re-reading the code.

## Core workflow

When working in a repo that contains one or more `.lat-md/` directories:

1. Audit the owning code first.
   - Read the current lattice file.
   - Inspect the real entrypoints, exports, and docstrings in the owning directory.
   - Search for existing `@lat:` anchors before changing headings that code references.
2. Update the relevant `.lat-md/*.md` files in the owning directory.
3. Keep the root `.lat-md/` thin. Only add cross-cutting repo docs there.
4. Preserve or deliberately migrate heading names that existing `@lat:` anchors depend on.
5. Anchor implementation back to concepts when needed:
   - JS/TS/etc: `// @lat: [[file#Heading]]`
   - Python: `# @lat: [[file#Heading]]`
6. Use the shared helper script.
   - The canonical helper is `.pi/skills/lat-md/scripts/run-lat.sh`. Repo-local wrappers may delegate to it.
   - Start with `bash .pi/skills/lat-md/scripts/run-lat.sh --help` or `bash .pi/skills/lat-md/scripts/run-lat.sh check --help`.
   - `owner-root` is optional and defaults to `.`.
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] check [all|md|code-refs|index|sections]`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] locate <query>`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] section <query>`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] refs <query> [--scope md|code|md+code]`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] expand --stdin`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh gen <router|section>`
   - `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] init [--force]`
7. Verify link and anchor drift.
   - Run explicit checks that every `[[...]]` target exists and every `@lat: [[...]]` heading resolves

## Precision checklist

Before finishing, check these failure modes:
- stale file paths after refactors
- vague section text that does not name a concrete boundary
- root lattice swallowing subsystem detail that belongs in an owning lattice
- headings changed without updating `@lat:` anchors
- docs claiming a capability that code now gates, deprecates, or fails fast
- omission of artifact contracts that downstream tools depend on

## Section rules

- Every heading must have a leading paragraph: at least one sentence immediately after the heading, before any child headings.
- The first paragraph should stay short and direct.

## Linking

Use wiki links to connect concepts:

- `[[other-file#Section]]`
- `[[other-file#Section|alias]]`

Prefer logical repo links like `[[src/data#Processing orchestration]]` over brittle relative-path variants.

You can also link to code symbols for supported languages:

- `[[src/foo.ts#myFunction]]`
- `[[src/app.py#MyClass#method]]`

## What belongs in `.lat-md/`

Write what and why: responsibilities, boundaries, invariants, ownership, artifact contracts, and fail-fast behavior. Do not duplicate code.

Good:
- architecture boundaries and invariants
- domain concepts and business rules
- protocols and contracts
- test specs that explain what is protected and why
- thin root workflow or map docs that connect owning lattices without swallowing them

Bad:
- code walkthroughs
- TODO dumps
- vague summaries that do not name the canonical implementation
- stacking subsystem docs under root `.lat-md/` when they belong under an owning directory
- tests without an approved behavior or scenario backing them

## Verification

- Run `bash .pi/skills/lat-md/scripts/run-lat.sh [owner-root] check all` for the touched owner root, or the closest available `check` subset when a full check is not applicable.
- Confirm wiki links resolve and every changed `@lat:` anchor points to an existing heading.

