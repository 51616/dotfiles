# tui-broker

Project-local pi extension that owns the interactive footer/editor surfaces and exposes a neutral contribution contract so other extensions do not replace those surfaces directly.

Behavior notes:
- keeps one canonical footer/editor owner for the interactive TUI
- collapses the footer to a single `cwd … model • effort` line and keeps the context-usage ratio on the editor bottom border
- preserves extension status lines produced via `ctx.ui.setStatus()`
- lets other extensions contribute through `lib/runtime.ts` instead of calling `ctx.ui.setFooter()` or `ctx.ui.setEditorComponent()` directly
- supports contributed footer-path labels, editor badges, editor border styles, and autocomplete-provider wrappers
- keeps current local extensions on one shared footer/editor owner by moving them onto broker contribution hooks
- keeps `pi-ssh` on the shared footer path and `pi-fff` on the shared autocomplete path without surrendering surface ownership
- includes `/tui-broker:debug` to show the active contributors

Notes:
- pi core stays unpatched; direct surface ownership is a local convention enforced by tests for the curated extension set, not a global runtime block

Test with:

```bash
node --test .pi/extensions/tui-broker/test/*.test.mjs \
  .pi/extensions/pi-ssh/test/footer.test.mjs
```
