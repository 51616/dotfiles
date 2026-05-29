# Project Workflow

## Guiding principles

1. **Approved behavior first.** For non-trivial extension changes, `spec.md` defines the behavior contract before implementation begins.
2. **Keep live pi safe.** Prefer extension-only changes. If a pi core seam is required, document the dependency and patch target explicitly before changing runtime code.
3. **No duplicate UI surfaces.** Live widgets, transcript messages, status slots, and editor/footer decorations must have one canonical owner at a time.
4. **Width safety is mandatory.** Every TUI-rendered line must stay within the width passed to `render(width)`.
5. **Bound live surfaces.** Live UI must stay height-bounded and must clear on terminal states such as completion, abort, error, session switch, and shutdown.
6. **Tests prove behavior.** Add or change tests only when they map to an approved scenario or a documented regression risk.
7. **Keep the repo honest.** Update `.lat-md/` and track docs when behavior ownership, lifecycle, or verification changes.
8. **Reload after runtime changes.** After extension runtime code changes, run `/reload` in pi so the current session uses the new code.

## Status markers

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Task lifecycle

For each implementation task:

1. Read the relevant track `resume.md`, `spec.md`, and `plan.md`.
2. Map the task to approved acceptance criteria and scenario examples.
3. Mark the task `[~]` before editing code.
4. Write or update the smallest meaningful regression test when feasible.
5. Implement the smallest code change that satisfies the approved behavior.
6. Run targeted verification for the touched extension.
7. Update `plan.md` change evidence and `resume.md` before pausing.
8. Update `.lat-md/` if behavior ownership or proving tests changed.

## Verification expectations

Common commands for activity-block work:

- `node --test test/activity-block-index.test.mjs`
- `node --test test/activity-block-widget.test.mjs`
- `node --test test/activity-block-state.test.mjs`
- `node --test test/activity-block-view-mode.test.mjs test/activity-block-thinking-visibility.test.mjs`

Before marking behavior-delivery work complete, verify:

- [ ] The behavior matches the approved spec.
- [ ] Targeted `node --test` checks pass for the touched extension.
- [ ] Rendered TUI components remain width-safe and height-bounded.
- [ ] Runtime UI state clears on terminal/session lifecycle paths.
- [ ] `.lat-md/tests.md` links to any new or changed proving tests.
- [ ] `/reload` is run after live extension code changes.

## Coding style contract

- Prefer explicit TypeScript types over loose objects.
- Keep reducer/state transitions separate from rendering.
- Keep UI placement/lifecycle code in extension entrypoints rather than widget formatting modules.
- Avoid fallback behavior that hides a missing pi core seam; fail clearly or document reduced behavior.
- Keep files below 800 LOC when feasible; split behavior into helper modules when a file grows past that.

## Review gate

After implementation and verification, run a review against:

- the approved track spec
- the implementation plan and change evidence
- touched extension files
- touched tests and `.lat-md/` docs

Fix straightforward findings before completion. If review exposes an unresolved design decision, return to planning instead of improvising.

## Track completion

Before marking a track complete:

- ensure `spec.md`, `plan.md`, and `resume.md` reflect final reality
- sync `.lat-md/activity-block.md` and `.lat-md/tests.md` if activity-block behavior changed
- run targeted verification
- run `/reload` if runtime extension code changed
- update `.conductor/tracks.md` from `[~]` to `[x]`
