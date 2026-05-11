# Codex fast mode

This extension owns the user-visible toggle for OpenAI Codex fast service tier inside pi.

## Responsibilities

`codex-fast-mode/index.ts` registers `/fast`, `/normal`, and `/codex-fast-mode [on|off|toggle|status]`.

When enabled, it modifies only active `openai-codex` provider requests by adding `service_tier: "fast"` in `before_provider_request`. Other providers remain unchanged even if the mode is enabled.

The mode persists as `{ "enabled": boolean }` in `codex-fast-mode.json` under `PI_AGENT_DIR` or `~/.pi/agent`.

## UI contract

The extension does not own the footer directly.

It contributes a `fast` model-effort suffix through [[tui-broker/lib/runtime.ts]] when the mode is enabled and the active provider is `openai-codex`. `tui-broker` renders this as ` (fast)` beside the reasoning effort, for example `󰚩 GPT-5.4 · 󰧑 High (fast)`.

## Invariants

Fast mode is a Codex service-tier toggle, not a model switch and not a reasoning-effort shortcut.

`/fast` enables the persisted toggle. `/normal` disables it. `/codex-fast-mode status` reports whether the current model will actually receive the fast service tier.

Provider payload mutation must stay narrow: non-object payloads are ignored, existing `service_tier` values are overwritten only for enabled OpenAI Codex requests, and non-Codex providers never receive `service_tier` from this extension.

## Verification

`codex-fast-mode/test/index.test.mjs` proves the persisted state contract, Codex-only payload mutation, `/fast` and `/normal` command behavior, and footer suffix contribution through `tui-broker`.
