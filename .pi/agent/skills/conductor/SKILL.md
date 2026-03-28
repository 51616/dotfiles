---
name: conductor
description: |
  Use when: the user asks to plan or start/resume a track, or when the work is large enough to benefit from a durable spec/plan/resume workflow. Trigger on phrases like "plan this", "start a track", "make a conductor track", "resume the track", or when the work clearly needs repo audit or explicit planning before implementation.
  Don’t use when: the task is a tiny one-off edit or simple Q&A (use normal repo editing instead), or when the user explicitly wants a repeated scrutiny loop with per-round `review -> trim -> implement` artifacts (use `conductor-scrutinize` instead).
---

# conductor

Conductor is a *repo-native* workflow for larger work: **Audit → Structured Context → Spec & Behaviors → Plan → Implement → Review → Completion Sync**.

If the work is explicitly a multi-round audit/scrutiny loop (review/trim/implement per round), switch to `conductor-scrutinize`.

This skill ports the Conductor ideas into pi’s world, but keeps the durable state in repo Markdown files instead of hiding the important bits in session history. Do not stop until the track implementation has been fully verified (except required manual tests). Do not resume existing tracks unless explicitly asked.

## Flow (practical)

### 1) Audit the repo first (always)

Before setup or track planning, audit the repo to infer the current reality.

If the repo contains a `lat.md/` knowledge graph, use it as the default “what is this system and why?” reference. Prefer `lat locate`, `lat section`, and `lat refs` to navigate, and update `lat.md/` when you discover drift.

When editing `lat.md/` files, defer to the `lat-md` skill for authoring rules and drift checks.
Do not rely on semantic search (`lat search`) in the Conductor flow for now.

Inspect enough to answer the important questions, preferring high-signal files first:
- `README.md` and other top-level docs
- dependency manifests / lockfiles
- source layout / major entrypoints
- test layout and test tooling
- existing `conductor/` docs if present

From the audit, infer:
- project summary / purpose
- tech stack and architecture shape
- workflow/testing conventions
- obvious doc/code mismatches
- missing or ambiguous decisions that need confirmation

Rule:
- infer first
- confirm those inferences with the user
- ask only for missing or ambiguous decisions

Do **not** pretend the repo is blank if the code already tells us what it is.

### 2) Setup project context (once per repo)

1. Run scaffolding script (from anywhere):
   - `bash "$PI_VAULT_ROOT/.pi/skills/conductor/scripts/setup.sh" --root /path/to/repo`
2. Use the audit to draft/fill:
   - `conductor/project.md`
   - `conductor/project-guidelines.md` (optional, but useful for user-facing projects)
   - `conductor/tech-stack.md`
   - `conductor/workflow.md`
3. Confirm inferred answers with the user, then ask only for missing/ambiguous decisions.
4. Ensure `conductor/index.md` and `conductor/tracks.md` exist.

This is a structured intake, not a vague “interview briefly”.

### 3) Create a track (spec first, then plan)

1. Infer track description from the user's request.
2. Create a **spec** first. The spec must define the behavior contract before implementation.
3. `spec.md` must include:
   - context / goal / non-goals
   - requirements
   - **acceptance criteria**
   - **expected behaviors**
   - **scenario examples** (plain language, not Gherkin)
   - constraints / assumptions / risks / open questions
4. Propose a balanced set of scenarios by default:
   - happy path
   - key validation failures
   - important edge cases
   - ambiguity checks where needed
5. **Require approval** of `spec.md` unless Tan explicitly says to skip approval. Return to the user before moving on.
6. Draft a **plan** from the approved spec + behaviors:
   - phases → tasks → subtasks
   - `[ ]` checkboxes everywhere
   - behavior-driven implementation slices
   - tests-first steps when feasible
   - verification + completion sync tasks
7. **Require approval** of `plan.md` unless Tan explicitly says to skip approval. Return to the user before moving on.
8. Create/maintain a **resume** (`resume.md`) with:
   - current state
   - active phase/task
   - last completed step
   - behaviors currently in scope
   - blockers / risks / deviations
   - the next 1–3 concrete steps
   - exact verification commands
9. Create the track artifacts:
   - `bash "$PI_VAULT_ROOT/.pi/skills/conductor/scripts/new-track.sh" --root /path/to/repo --desc "..." --type feature`

The script scaffolds files. The agent still owns the thinking and should replace the template content with the approved spec/plan/resume state.
These files should be *detailed enough so that a new team member can pick the task up easily*. Adding references is helpful for future validation and double checking.

### 4) Explicit user return points

Keep the workflow tight. Return to the user only at these checkpoints:

1. **After repo audit**
   - purpose: confirm inferred project reality and resolve missing/ambiguous decisions before drafting context docs
2. **After project-context drafts**
   - purpose: approve or correct `project.md`, `project-guidelines.md`, `tech-stack.md`, and `workflow.md`
3. **After `spec.md` draft**
   - purpose: approve or revise acceptance criteria, expected behaviors, and scenario examples
4. **After `plan.md` draft**
   - purpose: approve or revise the execution plan
5. **After review + track completion**
   - purpose: summarize implementation, verification, review findings/fixes, and best-effort project doc sync

Do **not** return during implementation to ask ad hoc behavior or scope questions. If anything is still ambiguous, resolve it before implementation starts.

The review stage is also non-interactive by default. The agent should fix straightforward review findings itself, rerun review/verification as needed, and only return early if the review exposes a real contradiction or missing decision that should have been resolved during planning.

### 5) Implement from the plan

Implementation should be non-interactive once it starts.

Loop tasks in `conductor/tracks/<track_id>/plan.md`:
- when starting a work session (especially after `/new`), read `conductor/tracks/<track_id>/resume.md` first
- map the current task back to the approved behaviors/scenarios in `spec.md`
- mark the current task `[~]` before starting
- write tests first **when feasible**, using the approved behaviors/scenarios as the source of truth
- do not write tests “for the sake of testing”: every new/changed test must directly prove one of the approved behaviors/scenarios in `spec.md` (if it doesn’t map, delete or rewrite it)
- if the repo uses `lat.md/`, keep it in sync during implementation; defer to the `lat-md` skill for the exact conventions and required checks
- if tests-first is not feasible, record why and define another verification method before coding
- implement the smallest code change that satisfies the approved behavior
- run the smallest meaningful verification command(s)
- update the `plan.md` **Change evidence** section with touched paths + minimal snippets that map back to the approved scenarios
- mark `[x]` when done
- after each meaningful work chunk (and always before stopping / at each user return point), update `resume.md` with the new current state + decisions + next steps + exact verification commands

#### Evidence (optional, milestone-only): Showboat

If the track benefits from **reproducible proof-of-work** (especially for tricky CLI workflows, ops changes, or anything you’ll want to re-check later), maintain a Showboat demo doc inside the track:

- `conductor/tracks/<track_id>/evidence/showboat.md`

Use the `showboat-demo` skill.

Default (Option A): capture **key checkpoints only** (don’t try to record every command):
- baseline/setup established
- problem reproduced (failing test / failing command output)
- fix applied (the smallest commands that prove the change)
- final verification (tests/lint/build + any relevant manual checks)

Treat `showboat verify` as part of Phase 3 (Verification) when the demo exists.

Keep progress and track status **continuously** updated (not just at the end):

- `conductor/tracks.md` is the repo-level dashboard. Update it whenever the track changes state:
  - `[ ]` → `[~]` as soon as you start work on the track (**spec drafting counts**)
  - keep `[~]` during planning + implementation + review fixups
  - `[~]` → `[x]` only after verification **and** completion sync are done
- `conductor/tracks/<track_id>/plan.md`: keep one active item marked `[~]`, tick `[x]` as tasks complete
- `conductor/tracks/<track_id>/resume.md`: keep it current enough that a fresh session can resume without rereading chat history
- `conductor/tracks/<track_id>/metadata.json` (optional but recommended): update `status` + `updated_at` when state changes


### 6) Review before completion sync

After implementation is done, run a lightweight review gate before marking the track complete.

Use `codex-review` explicitly as the default second-opinion reviewer for this stage. Give it the minimum high-signal context needed to review precisely: the relevant `spec.md`, `plan.md`, `resume.md`, the touched paths, and the `plan.md` Change evidence snippets.

Example:
- `codex-review.sh "Review conductor/tracks/<track_id>/{spec.md,plan.md,resume.md} plus the touched files and Change evidence. Look for correctness issues, scope drift, tests that don’t map to approved behaviors/scenarios, missing tests where behaviors lack proof, and weak verification."`

The review should be driven by the approved `spec.md` and `plan.md`, not by random style nitpicking. Check:
- behavior/spec compliance
- plan compliance / scope drift
- whether tests and verification actually prove the approved behavior
- whether every new/changed test maps to an approved behavior/scenario (no “testing for its own sake”)
- if the repo uses `lat.md/`, that `lat check` passes for the relevant project root(s)
- whether `plan.md` contains sufficient **Change evidence** (paths + snippets) for precise review
- obvious correctness, maintainability, safety, and observability issues
- which docs now need sync

Review outcomes:
- **pass** → proceed to completion sync
- **pass with minor notes** → fix the cheap issues, rerun the review if needed, then proceed.
- **fail** → return to implementation with explicit findings captured in `resume.md` (and `plan.md` if the plan itself needs correction)

Keep this stage mostly agent-driven and non-interactive. The user should see the review result in the final handoff summary unless the review reveals a real contradiction that requires replanning.

### 7) Completion sync

At track completion, do a best-effort sync so the repo does not lie about current reality.

Review and update as needed:
- `conductor/project.md`
- `conductor/tech-stack.md`
- `conductor/workflow.md` (only if process assumptions materially changed)
- the track docs for final consistency
- `resume.md` so the terminal state is clear
- if the repo uses `lat.md/`, update the relevant sections and ensure `lat check` passes (defer to the `lat-md` skill)

Keep this practical. The goal is to leave accurate docs behind, not to create ritual.

## Supporting files

Templates (copied by scripts):
- `templates/project.md`
- `templates/project-guidelines.md`
- `templates/tech-stack.md`
- `templates/workflow.md`
- `templates/index.md`
- `templates/tracks.md`
- `templates/track/spec.md`
- `templates/track/plan.md`
- `templates/track/resume.md`
- `templates/code_styleguides/*.md`

Scripts:
- `scripts/setup.sh`
- `scripts/new-track.sh`
- `scripts/status.sh`

## Verification

In any scratch repo:
1. `bash "$PI_VAULT_ROOT/.pi/skills/conductor/scripts/setup.sh" --root /path/to/repo`
2. `bash "$PI_VAULT_ROOT/.pi/skills/conductor/scripts/new-track.sh" --root /path/to/repo --desc "Test track" --type chore`
3. Inspect `conductor/project.md`, `conductor/tracks.md`, and `conductor/tracks/<track_id>/{spec.md,plan.md,resume.md}` to confirm the new sections are present.
4. `bash "$PI_VAULT_ROOT/.pi/skills/conductor/scripts/status.sh" --root /path/to/repo`

You should see:
- `conductor/index.md`, `conductor/tracks.md`, `conductor/project.md`, `conductor/tech-stack.md`, `conductor/workflow.md`
- `conductor/tracks/<track_id>/{spec.md,plan.md,resume.md,metadata.json,index.md}`

based on: https://developers.googleblog.com/conductor-introducing-context-driven-development-for-gemini-cli/
