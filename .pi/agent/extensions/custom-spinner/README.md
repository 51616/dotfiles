# custom-spinner

Customizes pi's interactive working spinner label and animation.

Current behavior: randomly chooses one label per session start and agent turn, without immediately repeating the previous label. The animation copies opencode's interactive `spinner.Pulse` animation: `█ → ▓ → ▒ → ░` at 125ms per frame.

This extension uses `ctx.ui.setWorkingMessage()` and `ctx.ui.setWorkingIndicator()` on `session_start` and `before_agent_start`. `setWorkingIndicator()` only affects the normal streaming working indicator; compaction and retry loaders keep their built-in styling. The frames are rendered with pi's accent color and bold styling to match opencode's primary-color, bold treatment.

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

opencode's interactive chat list uses `spinner.Pulse` from Charm Bubbles. In `github.com/charmbracelet/bubbles v0.21.0`, `spinner.Pulse` is defined as `█`, `▓`, `▒`, `░` with `time.Second / 8` FPS, which is 125ms per frame.
