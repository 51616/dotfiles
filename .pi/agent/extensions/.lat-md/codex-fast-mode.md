# Codex fast mode

This extension owns the user-visible toggle for OpenAI Codex fast-preferred service behavior inside pi.

## Responsibilities

`codex-fast-mode/index.ts` registers `/fast`, `/normal`, and `/codex-fast-mode [on|off|toggle|status]`.

When enabled, it modifies only active `openai-codex` provider requests by adding a Responses API `service_tier`, defaulting to `"priority"`, in `before_provider_request`. Other providers remain unchanged even if the mode is enabled.

Codex CLI exposes a user-facing `fast` speed tier for some models, but the active OpenAI Codex provider path used by pi rejects literal `service_tier: "fast"`. This extension keeps `/fast` and the footer ` (fast)` as the UX label while sending only documented Responses API tier values: `auto`, `default`, `flex`, or `priority`.

The mode persists as `{ "enabled": boolean }` in `codex-fast-mode.json` under `PI_AGENT_DIR` or `~/.pi/agent`.

## UI contract

The extension does not own the footer directly.

It contributes a `fast` model-effort suffix through [[tui-broker/lib/runtime.ts]] when the mode is enabled and the active provider is `openai-codex`. `tui-broker` renders this as ` (fast)` beside the reasoning effort, for example `󰚩 GPT-5.4 · 󰧑 High (fast)`.

## Invariants

Fast mode is a Codex service-tier toggle, not a model switch and not a reasoning-effort shortcut.

`/fast` enables the persisted toggle. `/normal` disables it. `/codex-fast-mode status` reports whether the current model will receive a service tier, which public tier is configured, how many requests have been injected since load, and the last observed provider response status.

Provider payload mutation must stay narrow: non-object payloads are ignored, existing `service_tier` values are overwritten only for enabled OpenAI Codex requests, and non-Codex providers never receive `service_tier` from this extension. `PI_CODEX_FAST_MODE_SERVICE_TIER` may override the default, but it must be one of the documented Responses API values.

## Verification

`codex-fast-mode/test/index.test.mjs` proves the persisted state contract, Codex-only payload mutation, `/fast` and `/normal` command behavior, and footer suffix contribution through `tui-broker`.
