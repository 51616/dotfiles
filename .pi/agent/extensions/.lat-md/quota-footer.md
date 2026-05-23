# Quota footer

This extension owns the compact Codex quota meter shown in the interactive footer.

## Responsibilities

It scans recent Codex session JSONL logs for `rate_limits` snapshots, normalizes both snake_case and camelCase payloads, and formats the primary 5-hour and secondary weekly windows as fixed-width ASCII bars.

The canonical parser and formatter live in [[quota-footer/lib/quota-footer.ts]]. The extension entrypoint lives in [[quota-footer/index.ts]].

## Contracts

The visible footer label is `5h ━━━━━━━━━━ 100% · weekly ━━━━━━━━━━ 100%` with no leading `q` prefix or brackets.

The percentage and filled bar cells show quota still available. The bars use one horizontal glyph with light gray available cells and dark gray consumed cells, and stay fixed-width so the footer can reserve a stable right-aligned slot.

When `tui-broker` is installed, `quota-footer` contributes through the broker footer right-status registry and explicitly clears its `ctx.ui.setStatus()` slot to avoid duplicate quota text. Without the broker, it falls back to the normal `ctx.ui.setStatus("quota-footer", text)` path.

Snapshots must be fresh before rendering live quota bars. Expired or incomplete snapshots render nothing, except stale complete snapshots render `quota stale` so old bars are not mistaken for current usage.
