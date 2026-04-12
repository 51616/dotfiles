---
name: gemini-stitch
description: |
  Use when: Tan wants Gemini + Stitch to act as a headless UI designer that generates or edits a polished screen, downloads the design artifacts locally, and leaves behind a reusable design-system note. Trigger on requests like "design me a dashboard/page/screen", "use Gemini Stitch", "mock up a UI", "generate a landing page and save the HTML/screenshot", or "edit this existing Stitch screen and redownload the assets".
  Don’t use when: inspecting an already-generated Stitch project without creating new artifacts (use direct file reads or the Gemini Stitch assets already on disk).
---

# gemini-stitch

Use Gemini CLI with the Stitch extension as a one-turn UI designer. Default to headless mode with full approvals, a fresh project, and a strict artifact contract. Support targeted edit mode when you already know the Stitch `projectId` and `screenId`.

## Command

```bash
bash "$PI_VAULT_ROOT/.pi/skills/gemini-stitch/scripts/gemini-stitch.sh" \
  --slug diff-dashboard \
  --project-title "Diff Dashboard" \
  "Design a diff dashboard where I can review all repo changes against HEAD. Focus on clarity, clean hierarchy, and easy navigation."
```

Targeted edit mode:

```bash
bash "$PI_VAULT_ROOT/.pi/skills/gemini-stitch/scripts/gemini-stitch.sh" \
  --mode edit \
  --project-id 12829644459820225155 \
  --screen-id 39705d57d5bd42968bdc2addd6e10388 \
  --slug diff-dashboard-v2 \
  "Tighten the typography, increase diff density, and make the file tree easier to scan. Keep the same overall dark aesthetic."
```

Default outputs:
- `.stitch/designs/<slug>.png`
- `.stitch/designs/<slug>.html`
- `.stitch/DESIGN.md`

The wrapper runs Gemini headlessly with:
- `--approval-mode yolo`
- `--output-format json`
- `-e Stitch`
- a single prompt that tells Gemini to generate, fetch, download, validate, and summarize the design in one turn

## Flow

1) Derive or accept a slug, project title, and device type. Create a fresh project by default; only enable reuse when the user wants iterative work inside an existing Stitch project. In edit mode, require explicit `projectId` and `screenId`.
2) Run the headless wrapper. Keep the prompt strict: direct Stitch MCP tools only, no delegation, preserve exact download URLs, validate outputs, return JSON only.
3) Trust the run only after local validation passes:
   - PNG exists and is non-trivial
   - HTML exists, looks like a real Stitch export, and is not a placeholder page
   - `.stitch/DESIGN.md` exists and is non-empty
4) Return the JSON result plus the important written paths.

## Options

```bash
bash "$PI_VAULT_ROOT/.pi/skills/gemini-stitch/scripts/gemini-stitch.sh" [options] "<design brief>"
```

Useful flags:
- `--slug <slug>` — filename stem under `.stitch/designs/`
- `--mode design|edit` — default `design`
- `--project-title <title>` — Stitch project title to create in design mode
- `--reuse-project` — opt into reusing an existing project title instead of always creating a fresh one
- `--project-id <id>` — required in edit mode
- `--screen-id <id>` — required in edit mode
- `--device desktop|mobile|tablet` — default `desktop`
- `--output-dir <dir>` — default `.stitch/designs`
- `--design-file <path>` — default `.stitch/DESIGN.md`
- `--model <model>` — default `gemini-3-flash-preview`
- `--fallback-model <model>` — optional model fallback, may be repeated
- `--timeout <seconds>` — default `900`
- `--attempts <n>` — retry non-deterministic backend failures, default `2`

## Supporting files

- `scripts/gemini-stitch.sh` — shell entrypoint
- `scripts/gemini-stitch.py` — prompt building, headless Gemini invocation, JSON parsing, and output validation

## Verification

```bash
timeout 900s bash "$PI_VAULT_ROOT/.pi/skills/gemini-stitch/scripts/gemini-stitch.sh" \
  --slug headless-smoke-skill \
  --project-title "Headless Stitch Smoke Test" \
  "Design a compact dark-mode dashboard for reviewing git diff stats with a small file list and summary metrics."
```

Expected result:
- the command prints JSON with `project`, `screen`, and `files`
- `.stitch/designs/headless-smoke-skill.png` exists
- `.stitch/designs/headless-smoke-skill.html` exists and is not a placeholder page
- `.stitch/DESIGN.md` exists

## Edge cases / negative examples

- If Gemini returns success but the HTML download is a placeholder page, treat the run as failed. Do not pretend it worked.
- If Gemini tries to write outside the workspace, either move the outputs back under `.stitch/` or rerun with explicit included directories. Default repo-local outputs are safer.
- If the Gemini backend returns transient `503`, `429`, model-capacity exhaustion, or Stitch MCP flakiness, retry a bounded number of times and optionally provide `--fallback-model`; do not loop forever.
- Edit mode is only safe when you already know the correct `projectId` and `screenId`. If those ids are ambiguous, inspect the existing project first instead of guessing.
