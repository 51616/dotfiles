# custom-spinner

Customizes pi's interactive working spinner label and animation.

Current behavior: randomly chooses one label per session start and agent turn, without immediately repeating the previous label. The animation copies opencode's prompt scanner: an 8-cell shaded block trail that moves left-to-right, holds at the end, moves right-to-left, then holds at the start.

This extension uses `ctx.ui.setWorkingMessage()` and `ctx.ui.setWorkingIndicator()` on `session_start` and `before_agent_start`. `setWorkingIndicator()` only affects the normal streaming working indicator; compaction and retry loaders keep their built-in styling. Active trail cells use `█ ▓ ▒ ░`; inactive cells use `⬝`. The frames use pi's accent/muted/dim theme colors to approximate opencode's per-cell color generator.

## Sensible label options

Good labels should be short, calm, and readable in a tight terminal footer. Avoid jokes that become annoying after hundreds of turns.

| Option | Feel | Note |
| --- | --- | --- |
| `Cooking...` | playful, clear | Good fit for “pi is preparing output.” |
| `Thinking...` | plain, conventional | Most literal. Slightly boring, but low-friction. |
| `Working...` | neutral | Upstream default; useful fallback. |
| `Brewing...` | cozy | Similar to cooking, a little softer. |
| `Crunching...` | technical | Fits analysis-heavy tasks, a bit corporate. |
| `Weaving...` | creative | Good for writing/synthesis, less obvious for coding. |
| `Forging...` | energetic | Good for building, may feel too dramatic. |
| `Simmering...` | calm | Nice for longer thinking, but less direct. |

The active pool is exactly the options above.

## Source note

The wave-like opencode spinner lives in `packages/opencode/src/cli/cmd/tui/ui/spinner.ts` and is used by `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`. The upstream prompt uses `createFrames({ style: "blocks", inactiveFactor: 0.6, minAlpha: 0.3 })`, `createColors(...)`, width `8`, bidirectional movement, hold-start `30`, hold-end `9`, and interval `40`ms. This extension intentionally uses `50`ms to make the movement slightly slower while keeping the wave responsive.
