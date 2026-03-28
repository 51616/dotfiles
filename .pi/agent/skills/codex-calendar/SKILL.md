---
name: codex-calendar
description: |
  Use when: you want to read or modify Tan’s Google Calendar via the Codex CLI “apps” connector (codex_apps.google calendar_* tools).
  Typical triggers:
  - “what’s on my calendar today/tomorrow/this week?”
  - “fetch my calendar” / “show my agenda”
  - “create a placeholder event at …” / “block 30 minutes …”
  - “delete/remove this event” (when you have an event id/link)

  Don’t use when:
  - The user gives you an ICS file or wants local/offline calendar parsing. Use normal shell/Python parsing instead.
  - The task is general web browsing/research. Use `codex-browse`.

  Outputs:
  - Read operations: a timezone-correct agenda listing (title, start/end, transparency, and event link when available).
  - Write operations: created/deleted event id + link, plus a verification query showing it appeared/disappeared.
---

# codex-calendar

Use Codex CLI as a Google Calendar helper. This wraps `codex exec --json` and prints only the final agent message.

Important: creating/deleting events may require `--dangerously-bypass-approvals-and-sandbox` in exec mode (we observed the connector otherwise errors with `request_user_input is not supported in exec mode`). That flag is powerful; only use it when the user explicitly asked for calendar writes.

## Commands

### Agenda (read-only)

```bash
codex-calendar agenda --date 2026-03-27 --tz Asia/Tokyo
```

Options:
- `--date YYYY-MM-DD` (or `today`)
- `--tz <IANA tz>` (default `Asia/Tokyo`)
- `--calendar-id <id>` (default `primary`)

### Create (writes calendar)

```bash
codex-calendar create \
  --title "PLACEHOLDER (pi test)" \
  --start "2026-03-28T09:00:00+09:00" \
  --end   "2026-03-28T09:15:00+09:00" \
  --tz Asia/Tokyo \
  --transparent \
  --description "Created by pi as a test placeholder; safe to delete."
```

### Delete (writes calendar)

```bash
codex-calendar delete --event-id <event_id> --calendar-id primary
```

### Raw prompt (escape hatch)

```bash
codex-calendar raw "Fetch my calendar events for today in JST."
```

## Supporting files

- `scripts/codex-calendar` — CLI wrapper around Codex JSONL output

## Verification

- Basic (no network/tools):
  ```bash
  codex-calendar --help
  ```

- Optional live smoke test (reads calendar):
  ```bash
  codex-calendar agenda --date today --tz Asia/Tokyo
  ```
