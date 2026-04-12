---
description: Update docs and lattices so they match the current code
---
Update the project documentation and lattice docs so they reflect the code as it exists now.

Scope: $@

Rules:
- Read the relevant code first. Do not guess from old docs.
- Update only the docs that are actually stale.
- When touching `lat-md/` or `@lat:` anchors, use the `lat-md` skill.
- Prefer one canonical current-state description. Remove stale or misleading docs instead of preserving old behavior unless explicitly asked not to.
- Keep edits minimal, accurate, and specific.
- If code and docs disagree, treat code as source of truth unless there is clear evidence the code is wrong.
- Verify any lattice updates with the shared lattice verification helper.
- End with:
  - files changed
  - assumptions made
  - verification run
  - remaining doc debt, if any
  - ambiguities that require user judegment, if any
