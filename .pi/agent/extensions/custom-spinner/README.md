# custom-spinner

Customizes pi's interactive working spinner label.

Current label: `Cooking...`

This extension uses `ctx.ui.setWorkingMessage()` on `session_start` and `before_agent_start`. It only changes the text beside the loader; spinner frames are still owned by pi-tui and are not currently exposed through the extension API.

## Sensible label options

Good labels should be short, calm, and readable in a tight terminal footer. Avoid jokes that become annoying after hundreds of turns.

| Option | Feel | Note |
| --- | --- | --- |
| `Cooking...` | playful, clear | Current default. Good fit for “pi is preparing output.” |
| `Thinking...` | plain, conventional | Most literal. Slightly boring, but low-friction. |
| `Working...` | neutral | Upstream default; useful fallback. |
| `Brewing...` | cozy | Similar to cooking, a little softer. |
| `Crunching...` | technical | Fits analysis-heavy tasks, a bit corporate. |
| `Weaving...` | creative | Good for writing/synthesis, less obvious for coding. |
| `Forging...` | energetic | Good for building, may feel too dramatic. |
| `Simmering...` | calm | Nice for longer thinking, but less direct. |

Recommended defaults:

1. `Cooking...` — best balance of personality and clarity.
2. `Thinking...` — safest conventional option.
3. `Brewing...` — softer variant if `Cooking...` feels too cute.
