# Tech Stack

## Languages

- TypeScript for live pi extensions.
- JavaScript / ESM `.mjs` for tests and small test fixtures.
- Markdown for extension docs, patch notes, lattice docs, and Conductor tracks.

## Frameworks / runtime

- Node.js ESM runtime.
- pi loads extension TypeScript dynamically from `~/.pi/agent/extensions/`.
- TUI components use `@mariozechner/pi-tui` / `@earendil-works/pi-tui` APIs exposed through `@mariozechner/pi-coding-agent` / `@earendil-works/pi-coding-agent` depending on installed package lineage.

## Data storage

- Extension state is usually persisted in pi session entries via custom entries (`pi.appendEntry`) or tool-result details.
- Activity-block session state uses custom transcript messages plus `activity-block-state` entries.
- Test and docs state lives directly in the extension workspace.

## Tooling

- Package manager: npm (`package-lock.json` is present).
- Formatter: no repository-wide formatter script is declared in `package.json`.
- Linter: no repository-wide lint script is declared in `package.json`.
- Test runner: Node's built-in `node --test` runner.
- Type checker: TypeScript dependency is installed, but no repository-wide typecheck script is declared in `package.json`.

## CI / build

- No workspace CI config was found during the initial Conductor audit.
- Verification is currently done with targeted `node --test ...` commands and any extension-specific smoke checks documented near the touched code.

## Observability

- Logging: extension-specific; no central logging framework is declared for this workspace.
- Metrics: extension-specific; activity-block derives live token counts from `ctx.getContextUsage()`.
- UI diagnostics: pi TUI can emit render logs with `PI_TUI_WRITE_LOG=/tmp/tui-ansi.log pi` when needed.

## Environment / deployment

- Live extension root: `~/.pi/agent/extensions/`.
- Runtime reload: run `/reload` inside pi after changing extension code, lattice docs that affect skills/extensions, or AGENTS-style runtime instructions.
- Git tracking: use `git --git-dir=$HOME/.dotfiles --work-tree=$HOME` for this workspace.

## Conventions

- Naming: extension folders use lowercase hyphenated names; test files use behavior-oriented names ending in `.test.mjs`.
- Project layout: each substantial extension owns its implementation folder and may have local tests; cross-extension tests live under `test/`.
- Documentation: `.lat-md/` documents durable behavior boundaries and should be updated when behavior ownership changes.
