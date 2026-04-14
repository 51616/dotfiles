# Project Definition

## Summary
This workspace contains Tan’s live pi extensions. It adds behavior on top of `@mariozechner/pi-coding-agent`, with a strong bias toward extension-level composition instead of pi core forks. The main users are Tan and pi itself during interactive coding sessions, including SSH-backed and long-running workflows.

## Users
- Primary users:
  - Tan, operating pi interactively in the TUI
  - pi extensions that need shared runtime contracts inside the extension workspace
- User needs / jobs-to-be-done:
  - add new session, tool, and TUI behaviors without touching pi core
  - keep remote workflows, checkpointing, slash commands, and review flows reliable
  - expose shared runtime contracts clearly enough that new extensions can reuse them safely

## Goals
- Keep extension behavior modular and explicit
- Prefer one canonical contract for shared runtime state
- Preserve current session UX while making extension coupling easier to reason about
- Maintain strong regression coverage for fragile cross-extension behavior

## Non-goals
- Replacing pi core internals from this workspace
- Carrying long-lived compatibility shims for stale internal extension contracts unless they are clearly needed

## Key features (high level)
- tool interception and delegation
- remote SSH-backed workspace execution
- automatic self-checkpointing and compaction orchestration
- shared TUI/footer/runtime helpers
- slash-command and review workflows

## Constraints
- Extensions live under `~/.pi/agent/extensions/` and are tracked via Tan’s bare dotfiles repo
- Extension code runs directly via TypeScript/Jiti; no build step is assumed for local iteration
- Cross-extension behavior needs to work in both local and SSH-backed sessions
- Existing session/test behavior is the main compatibility target

## Quality bar
- Reliability: cross-extension contracts should fail clearly and be regression-tested
- Performance: no unnecessary extra remote round-trips on hot paths
- UX: local vs remote behavior should stay predictable and visible

## Notes / references
- `package.json`
- `lat-md/extensions.md`
- `lat-md/tests.md`
- `pi-ssh/README.md`
- `skill-uri/README.md`
- `self-checkpointing/SPEC.md`
