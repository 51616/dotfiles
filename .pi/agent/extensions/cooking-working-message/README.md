# cooking-working-message

Sets pi's interactive working message to `Cooking...` while the agent is running.

This extension uses `ctx.ui.setWorkingMessage()` on `session_start` and `before_agent_start`. It only changes the text label; spinner frames are still owned by pi-tui.
