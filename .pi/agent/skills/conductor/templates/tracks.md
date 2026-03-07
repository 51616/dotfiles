# Project Tracks

This file tracks major units of work (**tracks**). Each track has its own folder under `conductor/tracks/` with:
- `spec.md` (approved requirements + behavior contract)
- `plan.md` (phases/tasks checklist)
- `resume.md` (read first when resuming / compacting)
- `metadata.json`

By default, a track should not move into implementation until both `spec.md` and `plan.md` are approved. Skip that only when Tan explicitly asks to skip approval.

A track is not complete until it passes implementation, verification, review, and completion sync.

## Track entry format

Append one section per track, separated by `---`.

Example (kept uppercase here so simple status parsers do not count the example as a real track entry):

```markdown
---

- [ ] **TRACK: Add dark mode toggle**
  *Link: [./tracks/add-dark-mode-toggle_20260216/](./tracks/add-dark-mode-toggle_20260216/)*
```
