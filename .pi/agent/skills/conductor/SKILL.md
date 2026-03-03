---
name: conductor
description: |
  Use when: the user asks to plan or start/resume a track. When the user says "good luck" is also a good sign that you have a lot of work ahead and should use this skill.
  Don’t use when: the task is a tiny one-off edit or simple Q&A (use normal repo editing instead), or when the user explicitly wants a repeated scrutiny loop with per-round `review -> trim -> implement` artifacts (use `conductor-scrutinize` instead).
---

# conductor

Conductor is a *repo-native* agent workflow: **Context → Spec & Plan → Implement**.

If the work is explicitly a multi-round audit/scrutiny loop (review/trim/implement per round), switch to `conductor-scrutinize`.

This skill ports the Conductor ideas (from the Google Developers blog + the Gemini CLI Conductor extension) into pi’s world: we keep durable context in Markdown files in the repo, and we drive implementation from `plan.md` checklists. Do not stop until the track implementation has been fully verified (except required manual tests). Do not resume existing tracks unless explicitly asked.


## Flow (practical)

### 0) Decide if Conductor is worth it

Use this when the task is complex enough that you’ll benefit from:
- a written spec you can review
- an explicit plan with checkboxes
- resumability across sessions/machines

If it’s “change two lines”, don’t spin up a track.

### 1) Setup project context (once per repo)

1. Run scaffolding script (from anywhere):
   - `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/setup.sh" --root /path/to/repo`
2. Interview the user briefly to fill in:
   - `conductor/product.md`
   - `conductor/product-guidelines.md` (optional, but useful for user-facing products)
   - `conductor/tech-stack.md`
   - `conductor/workflow.md` (defaults are OK; customize if needed)
3. Ensure `conductor/index.md` and `conductor/tracks.md` exist.

### 2) Create a track (spec + plan)

1. Ask for a track description (or infer from the user's request).
2. Create a **spec** first (what/why, constraints, acceptance criteria).
3. Draft a **plan** with:
   - phases → tasks → subtasks
   - `[ ]` checkboxes everywhere
   - TDD-first implementation steps (red → green → refactor) for feature/bug phases
   - one final “manual verification” meta-task per phase (if relevant)
4. Create/maintain a **resume** (`resume.md`) with:
   - current state + what’s in progress
   - the next 1–3 concrete steps
   - exact verification commands
   (This is what checkpoint notes should link to, and what a fresh `/new` session should read first.)
4. Create the track artifacts:
   - `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/new-track.sh" --root /path/to/repo --desc "..." --type feature`

### 3) Implement from the plan

Loop tasks in `conductor/tracks/<track_id>/plan.md`:
- when starting a work session (especially after `/new`), read `conductor/tracks/<track_id>/resume.md` first
- mark the current task `[~]` before starting
- implement + tests per `conductor/workflow.md`
- mark `[x]` when done (optionally append a short commit SHA)
- when stopping, update `resume.md` with the new current state + next steps

Update `conductor/tracks.md` track status:
- `[ ]` → `[~]` when starting implementation
- `[~]` → `[x]` when complete

### 4) Status / review / revert (optional)

- Quick overview: `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/status.sh" --root /path/to/repo`
- Review: compare what was built vs spec+plan and recommend fixes.
- Revert: if you want Conductor-style logical reverts, you’ll need additional tooling; this skill only provides the file structure and protocol.

## Supporting files

Templates (copied by scripts):
- `templates/product.md`
- `templates/product-guidelines.md`
- `templates/tech-stack.md`
- `templates/workflow.md`
- `templates/index.md`
- `templates/tracks.md`
- `templates/track/spec.md`
- `templates/track/plan.md`
- `templates/code_styleguides/*.md`

Scripts:
- `scripts/setup.sh`
- `scripts/new-track.sh`
- `scripts/status.sh`

## Verification

In any scratch repo:
1. `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/setup.sh" --root /path/to/repo`
2. `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/new-track.sh" --root /path/to/repo --desc "Test track" --type chore`
3. `bash "$PI_VAULT_ROOT/agents/skills/conductor/scripts/status.sh" --root /path/to/repo`

You should see:
- `conductor/index.md`, `conductor/tracks.md`
- `conductor/tracks/<track_id>/{spec.md,plan.md,resume.md,metadata.json,index.md}`


based on: https://developers.googleblog.com/conductor-introducing-context-driven-development-for-gemini-cli/
