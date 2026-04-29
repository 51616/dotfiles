# startup-screen

Small removable extension for a startup-screen style header in pi.

## Behavior

- replaces the startup header with a dashboard
- shows prompt files that affect startup context (`SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`, `CLAUDE.md`)
- keeps the skills/extensions inventory in a compact dashboard style
- keeps the footer rows out of the header version
- marks each item as project (`[P]`) and/or user-global (`[U]`)
- registers `/startup-screen` to refresh the dashboard header
- registers `/startup-screen-off` to restore the built-in startup header
- registers `/startup-screen-on` to re-enable the custom dashboard header

## Remove

Delete the folder and reload pi:

```bash
rm -rf ~/.pi/agent/extensions/startup-screen
/reload
```
