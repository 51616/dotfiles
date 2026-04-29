# Extensions

This lattice maps the extension entrypoints exposed through `.pi/extensions/`.

## activity-block

Owns the bounded live-activity widget, transcript suppression, and turn-scoped status rendering used while the agent is working.

See also [[activity-block]].

Entrypoint: [[activity-block/index.ts]].

## command-palette

Owns the slash-command overlay opened with `ctrl+shift+p` and `/palette`, including fuzzy filtering, direct prompt-template insertion, and literal slash-command insertion back into the main editor.

See also [[command-palette]].

Entrypoint: [[command-palette/index.ts]].

## command-context-for-tools

Exposes session-control helpers on plain tool contexts so extensions and tools can trigger shared session actions safely.

See also [[command-context-for-tools]].

Entrypoint: [[command-context-for-tools/index.ts]].

## Working spinner customization

Owns the custom working-indicator word list and spinner renderer used while pi is actively processing a turn.

Entrypoint: [[custom-spinner/index.ts]].

## do-not-stop

Owns the bounded autonomous follow-up loop, its persisted runtime state, and the editor-border affordance that shows loop progress.

See also [[do-not-stop]].

Entrypoint: [[do-not-stop/index.ts]].

## git-state

Owns the live Git working-tree meter that contributes to the `tui-broker` editor top-right border slot.

See also [[git-state]].

Entrypoint: [[git-state/index.ts]].

## pi-diff-review-tui

Owns the interactive diff-review overlay and related TUI surfaces for human-in-the-loop patch review.

See also [[pi-diff-review-tui]].

Entrypoint: [[pi-diff-review-tui/index.ts]].

## pi-diff-review-turn-tracker

Captures per-turn diff-review evidence by diffing start-vs-end synthetic workspace trees, so review sessions stay inspectable and SSH turn startup does not depend on remote file crawling.

See also [[pi-diff-review-turn-tracker]].

Entrypoint: [[pi-diff-review-turn-tracker/index.ts]].

## pi-instance-manager

Owns session-scoped coordination with the instance-manager service, including queue/status signaling and compaction interlocks.

See also [[pi-instance-manager]].

Entrypoint: [[pi-instance-manager/index.ts]].

## pi-slash

Owns slash-command execution and confirmation rules that mirror pi-discord-bot session controls.

See also [[pi-slash]].

Entrypoint: [[pi-slash/index.ts]].

## pi-ssh

Owns remote-SSH tool delegation, remote prompt context, and SSH-specific UI status/reporting behavior.

See also [[pi-ssh]].

Entrypoint: [[pi-ssh/index.ts]].

## self-checkpointing

Owns the full auto-checkpointing flow: threshold-driven auto-kick orchestration, footer detection, compaction, resume pings, and optional autotest/debug helpers.

See also [[self-checkpointing]].

Entrypoint: [[self-checkpointing/index.ts]].

## tests

Links the proving tests that anchor extension behavior which is easy to regress and expensive to rediscover from code.

See also [[tests]].

## tui-broker

Owns the canonical footer/editor surface broker and its shared contribution registry for interactive TUI chrome.

See also [[tui-broker]].

Entrypoint: [[tui-broker/index.ts]].
