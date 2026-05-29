# Project Guidelines

## Extension design

- Prefer extension seams over pi core patches. If core changes are unavoidable, document the exact files, patch target, and runtime dependency near the extension.
- Keep each extension's ownership boundary clear. A TUI surface should have one owner at a time.
- Persist only durable state. Live-only UI state should clear on completion, abort, error, session switch, and shutdown.
- Prefer one canonical current-state code path. Avoid parallel legacy behavior unless Tan explicitly asks for compatibility.

## TUI design

- Every component line returned by `render(width)` must fit within `width`.
- Live widgets must be height-bounded and readable in narrow terminals.
- Use status slots for small persistent state, widgets for visible non-blocking state, and custom/overlay UI only when input should be focused or blocked.
- Avoid stale widgets. Any widget created for an active run needs explicit cleanup on all terminal lifecycle paths.

## Testing

- Tests should prove durable behavior, not implementation trivia.
- Activity-block tests should cover lifecycle boundaries, transcript suppression, rendering bounds, and resume behavior because those regressions are expensive to diagnose manually.
- Add or update `.lat-md/tests.md` when a new proving behavior is introduced.

## Documentation

- Keep `.lat-md/` docs aligned with runtime behavior and exact test files.
- Keep activity-block patch notes aligned with its real pi core dependencies.
- Track docs should be self-contained enough for a future agent to resume without chat history.

## Operations

- Use `git --git-dir=$HOME/.dotfiles --work-tree=$HOME` for git status, staging, and commits in this workspace.
- Run `/reload` after changing live extension code.
- Do not push unless Tan explicitly asks.
