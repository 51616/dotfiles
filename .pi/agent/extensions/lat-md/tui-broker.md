# TUI broker

This extension is the canonical owner of the interactive footer/editor surfaces and the contract boundary for extensions that need to affect those surfaces.

## Responsibilities

It renders the lean footer layout, the editor-bottom context meter, and the shared editor top-border badge area.

It exposes a neutral contribution registry in [[tui-broker/lib/runtime.ts]] so other extensions can contribute:
- footer path labels
- editor badges
- autocomplete-provider wrappers
- footer refresh requests
- editor reinstall requests

When the broker is active in the local extension stack, non-broker extensions should not call `ctx.ui.setFooter()` or `ctx.ui.setEditorComponent()` directly for steady-state ownership. They should register contributions instead. That rule is currently enforced by local tests over the curated extension set, not by a pi-core runtime hook.

The canonical implementation lives in [[tui-broker/index.ts]]. Shared formatting helpers live in [[tui-broker/lib/layout.ts]].

## Contracts

The footer keeps the cwd / git-branch / session-name line and preserves extension status lines from `ctx.ui.setStatus()`. It intentionally drops cumulative token, cache, and dollar stats from the footer.

The editor override subclasses `CustomEditor` and decorates the final rendered border lines rather than replacing core editing behavior. It forces the user editor border to the active theme's orange slot (`mdHeading`) so core thinking-level updates cannot change the input border color.

The context-meter label format is `12.2%/272k` or `?/272k` when the percentage is unknown.

Current contributors:
- `do-not-stop` contributes the repeat badge
- `snippets` contributes the active snippet badge
- `pi-ssh` contributes the footer path label while SSH is active
- `pi-fff` contributes an autocomplete-provider wrapper instead of taking editor ownership

## Boundaries

`tui-broker` is the only extension that should directly own the shared footer/editor surfaces in normal interactive use.

Direct surface ownership outside the broker is treated as a regression in the local extension stack and should be caught by the broker ownership guard tests.

`tui-broker` is the only surface-owner contract that new local extension work should target.
