# Quota footer

This extension owns the compact Codex quota meter shown in the interactive footer.

## Responsibilities

It reads recent Codex session JSONL logs for cheap `rate_limits` snapshots. When those snapshots are missing or stale, it explicitly asks Codex app-server for `account/rateLimits/read`.

It normalizes both snake_case and camelCase payloads, identifies the 5-hour and weekly windows by their reported durations, and formats them as fixed-width bars. Codex may temporarily return only one standard window; the available window remains visible and the missing one is labeled `n/a` instead of suppressing the whole meter.

The canonical parser and formatter live in [[quota-footer/lib/quota-footer.ts]]. The extension entrypoint lives in [[quota-footer/index.ts]].

## Contracts

The visible footer label is `5h ━━━━━━ 100% · weekly ━━━━━━ 100%` with no leading `q` prefix or brackets.

The percentage and filled bar cells show quota still available. The bars use one horizontal glyph with light gray available cells and dark gray consumed cells, and stay fixed-width so the footer can reserve a stable right-aligned slot.

When `tui-broker` is installed, `quota-footer` contributes through the broker footer right-status registry and explicitly clears its `ctx.ui.setStatus()` slot to avoid duplicate quota text. Without the broker, it falls back to the normal `ctx.ui.setStatus("quota-footer", text)` path.

Every reported window must be fresh before rendering live quota bars. Expired session-log snapshots trigger an explicit app-server refresh before falling back to `quota stale`, so old bars are not mistaken for current usage. A fresh single-window app-server snapshot is valid because current Codex versions can omit an inactive or unavailable standard window.
