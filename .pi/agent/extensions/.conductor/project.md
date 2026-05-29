# Project Definition

## Summary

This repository is Tan's system-wide pi extension workspace. It contains TypeScript extensions that add tools, session behavior, and TUI surfaces to pi without forking the coding-agent runtime.

The canonical implementation path is `~/.pi/agent/extensions/`. Vault-facing `.pi/extensions/` paths may be symlinks into this workspace, but this workspace owns the live extension code.

## Users

- Primary users: Tan, plus pi agents operating in Tan's terminal sessions.
- User needs / jobs-to-be-done:
  - Keep pi's live TUI useful during long agent turns.
  - Add local workflow automation without changing upstream pi core whenever an extension seam is enough.
  - Preserve durable session behavior across `/resume`, `/tree`, compaction, SSH sessions, and reloads.

## Goals

- Keep extension behavior explicit, tested, and easy to reload with `/reload`.
- Prefer strict TypeScript contracts and small module boundaries.
- Preserve high-signal UI: useful status surfaces, low transcript noise, and no stale or duplicated widgets.
- Keep `.lat-md/` lattice docs aligned with code behavior that is hard to rediscover.

## Non-goals

- This workspace does not replace upstream pi core.
- This workspace should not hide required pi core seams. If an extension depends on patched core behavior, that dependency must be documented near the extension.
- This workspace should not carry compatibility shims for abandoned local conventions unless Tan explicitly asks for them.

## Key features (high level)

- `activity-block/`: bounded live activity summary and transcript-ownership behavior.
- `pi-ssh/`: remote SSH tool delegation and prompt-context injection.
- `pi-slash.ts`: slash-command bridge for agent-driven session commands.
- `self-checkpointing/`: checkpoint lifecycle and resume blocking.
- `pi-instance-manager/`: session coordination and queue behavior.
- `pi-diff-review-*`: turn tracking and review TUI workflows.
- `tui-broker/`: shared editor/footer surface coordination.

## Constraints

- Extensions are loaded dynamically by pi from `~/.pi/agent/extensions/`.
- Runtime extension changes require `/reload` to take effect in the current pi session.
- Some activity-block behavior depends on local pi core extension seams documented under `activity-block/README.md` and `activity-block/patches/`.
- The repo is tracked as part of Tan's bare dotfiles git setup using `git --git-dir=$HOME/.dotfiles --work-tree=$HOME`.

## Quality bar

- Reliability: no stale live widgets, no duplicate transcript surfaces, no silent fallback when an extension seam is missing.
- Performance: live UI updates must stay bounded and avoid unbounded transcript/render growth.
- UX: terminal rendering must stay width-safe, height-bounded, and easy to scan while pi is working.

## Notes / references

- Lattice root: `.lat-md/index.md`.
- Activity-block contract: `.lat-md/activity-block.md`.
- Test-spec lattice: `.lat-md/tests.md`.
