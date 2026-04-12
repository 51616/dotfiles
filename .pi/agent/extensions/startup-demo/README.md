# startup-demo

Small removable demo extension for a startup-page style overlay in pi.

## Behavior

- replaces the startup header with a dashboard
- uses the same two-column content as the old overlay: skills and extensions
- keeps the footer rows out of the header version
- marks each item as project (`[P]`) and/or user-global (`[U]`)
- registers `/startup-demo` to refresh the dashboard header
- registers `/startup-demo-off` to restore the built-in startup header
- registers `/startup-demo-on` to re-enable the custom dashboard header

## Remove

Delete the folder and reload pi:

```bash
rm -rf ~/.pi/agent/extensions/startup-demo
/reload
```
