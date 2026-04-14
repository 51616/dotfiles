# Tech Stack

## Languages
- TypeScript
- JavaScript for tests (`.mjs`)
- small shell scripts for helper workflows

## Frameworks / runtime
- Node.js
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

## Data storage
- session/runtime state in pi-managed JSONL and state files under `~/.pi/agent/`
- local extension docs/specs in markdown

## Tooling
- Package manager: npm (`package-lock.json`)
- Formatter: none enforced at repo root; preserve existing style
- Linter: none enforced at repo root
- Test runner: `node --test`
- Type checker: TypeScript types via extension runtime usage; no dedicated repo-wide typecheck script is currently documented

## CI / build
- No dedicated build pipeline in this workspace; extensions are loaded directly by pi
- Verification is primarily targeted `node --test` runs plus relevant runtime checks

## Observability
- Logging: extension-specific debug logs and stderr traces (for example `PI_SSH_DEBUG`, `PI_SKILL_URI_DEBUG`, self-checkpoint debug JSONL)
- Metrics: minimal; status/footer/UI state is used more than formal metrics

## Environment / deployment
- Canonical live workspace: `~/.pi/agent/extensions/`
- Git tracking via `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`
- SSH-backed runtime available through the `pi-ssh` extension

## Conventions
- Naming: descriptive extension folders and helper modules; strict schemas and explicit contracts preferred
- Project layout:
  - `*/index.ts` for extension entrypoints
  - `*/lib/*.ts` for internal modules
  - `*/test/*.mjs` and `test/*.mjs` for regression coverage
  - `lat-md/*.md` for architecture/test lattice docs
