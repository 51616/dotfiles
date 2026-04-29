# Index

This directory is the root router for the Pi extensions lattice and maps the high-level extension concepts exposed through this repo’s `.pi/extensions/` facade.

Installable extension folders under `.pi/extensions/` are expected to be symlinks into `~/.pi/agent/extensions/`. Canonical lattice content lives in `lat-md/`, with `index.md` as the root document. Do not check in legacy `lat.md` aliases. Use `bash lat-local.sh .pi/extensions ...` or the shared skill helpers when the current [lat.md](https://www.npmjs.com/package/lat.md) CLI still expects them. It should stay in sync with implementation via `@lat:` references.

- [[index]] — canonical root router for this lattice
- [[extensions]] — extension entrypoints and responsibilities
- [[activity-block]] — bounded live activity widget plus live-transcript suppression contract
- [[command-palette]] — slash-command overlay with fuzzy filtering and editor insertion behavior
- [[command-context-for-tools]] — session-control hooks exposed on plain tool contexts
- [[do-not-stop]] — bounded autonomous follow-up loop behavior
- [[git-state]] — live Git working-tree meter for the editor top-right border
- [[pi-diff-review-tui]] — interactive diff-review overlay entrypoint
- [[pi-diff-review-turn-tracker]] — per-turn capture for diff-review evidence
- [[pi-instance-manager]] — coordination invariants for session-scoped runtime state
- [[pi-slash]] — canonical slash-command execution and confirmation rules
- [[pi-ssh]] — remote-SSH tool delegation and prompt-context rules
- [[self-checkpointing]] — automatic checkpoint lifecycle and recovery rules
- [[tests]] — proving tests for extension contracts that matter across sessions
- [[tui-broker]] — canonical footer/editor surface broker and contribution contract
