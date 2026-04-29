---
name: codex-image-gen
description: |
  Use when: Tan wants pi to generate, edit, or concept raster images through Codex, especially frontend/UI visual design references, website/app mockups, hero images, product visuals, illustrations, sprites, or image-backed design inspiration. Trigger on requests like "generate an image", "make a mockup", "design a Catppuccin-themed web UI", "create a visual reference", or "generate a UI image then turn it into HTML".
  Don’t use when: the task is only to inspect an existing local image (use `codex-look-at`), browse online design references (use `codex-browse`), use Gemini Stitch as the primary UI designer (use `gemini-stitch`), or create/edit deterministic SVG/vector/code-native assets that should stay in the repo’s existing design system.
  Outputs: Codex CLI uses native image generation, saves verified image artifacts to a concrete output directory, and for frontend UI tasks can also produce a visual description plus a static HTML/CSS skeleton derived from the generated image.
---

# codex-image-gen

Use Codex CLI as an image-generation helper. The important default is: ask Codex to use its native image generation first, then make it verify and copy the generated bitmap into a normal filesystem path before reporting success.

This was tested before authoring the skill: Codex generated a 512×512 PNG with native image generation and saved it at `/tmp/pi-work/codex-image-gen-explore/native.png`. Treat future live runs as needing verification anyway; never claim an image exists until a file check passes.

## Script

Run the skill script directly through pi’s skill-script tool; do not rely on a `codex-image-gen` command being installed on PATH.

- Script URI: `skill://codex-image-gen/scripts/codex-image-gen`
- Interpreter: `python3`
- Default timeout: `900` seconds

Tool arguments map to the script CLI:

```text
["--timeout-seconds", "900", "--output-dir", "/tmp/pi-work/codex-image-gen/<name>", "<prompt>"]
```

The script runs:

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort=medium --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<image-generation prompt>"
```

and prints only the final Codex agent message on success.

## General image flow

1. Clarify the requested asset only when missing details materially affect the output: intended use, aspect ratio/size, style, must-include text, must-avoid items, and final destination.
2. Run `codex-image-gen` with an explicit `--output-dir`. Use `/tmp/pi-work/codex-image-gen/<short-name>` for preview work, or a project asset directory when the image is meant to be checked into a repo.
3. Require native image generation. Do not accept a code-rendered placeholder unless Tan explicitly asks for fallback behavior.
4. Check Codex’s final report for verified paths. If the generated file is project-bound, inspect the file path and dimensions before wiring it into code.
5. Report the saved image path, final prompt/spec, whether native generation was used, and any caveats.

Example tool call:

```text
run_skill_script(
  script="skill://codex-image-gen/scripts/codex-image-gen",
  interpreter="python3",
  args=[
    "--timeout-seconds", "900",
    "--output-dir", "/tmp/pi-work/codex-image-gen/catppuccin-hero",
    "--size", "16:9",
    "Generate a polished Catppuccin-themed hero image for a calm personal knowledge-base app. No readable brand text."
  ],
  timeoutSeconds=960,
)
```

## Frontend UI design flow

Use `--frontend-ui` when the generated image should guide implementation. This mode is designed for the workflow Tan described: generate a nice-looking Catppuccin-themed web UI first, then make Codex describe the image and write an HTML skeleton after the image exists.

1. Ask for the screen and product context if absent: dashboard, landing page, settings page, editor, mobile/desktop, data density, and any required components.
2. Run with `--frontend-ui`, an explicit `--output-dir`, and usually `--size 16:9` for desktop web screens.
3. The Codex sub-agent should:
   - generate the UI mockup image using native image generation;
   - copy the selected bitmap to the output directory and verify it exists;
   - describe the generated UI in implementation terms: layout, surfaces, spacing, color tokens, components, and visual hierarchy;
   - write `index.html` with dependency-free HTML/CSS approximating the generated design;
   - write `design-note.md` with the prompt, visual description, and implementation assumptions.
4. Treat the HTML skeleton as a starting point. If the target repo already has a framework/design system, port the skeleton into that system rather than dropping raw HTML into production code.

Example tool call:

```text
run_skill_script(
  script="skill://codex-image-gen/scripts/codex-image-gen",
  interpreter="python3",
  args=[
    "--timeout-seconds", "1200",
    "--frontend-ui",
    "--output-dir", "/tmp/pi-work/codex-image-gen/habit-dashboard",
    "--size", "16:9",
    "Design a beautiful Catppuccin Mocha themed habit-tracker dashboard for desktop web. Include a left sidebar, today overview, streak cards, a weekly heatmap, and a calm focus panel."
  ],
  timeoutSeconds=1260,
)
```

Expected output directory for frontend mode:

```text
/tmp/pi-work/codex-image-gen/habit-dashboard/
  <generated-ui-image>.png
  index.html
  design-note.md
```

## Prompting guidance

For image quality, include only constraints that matter:

- asset type and use: hero, dashboard mockup, empty-state illustration, product shot, icon sheet;
- aspect ratio or target viewport;
- style direction: Catppuccin Mocha/Latte/Macchiato/Frappe, soft gradients, glass panels, cozy editorial, etc.;
- exact text, if text is required; otherwise say “no readable text” to avoid garbled UI copy;
- must-include components and must-avoid elements;
- output destination.

For frontend UI, prefer prompts like:

```text
Design a polished Catppuccin Mocha themed desktop web dashboard for <product>. Use a 16:9 viewport. Include <key regions/components>. Prioritize strong visual hierarchy, readable spacing, realistic cards, tasteful accent colors, and implementation-friendly structure. Avoid tiny unreadable text and brand logos.
```

## Timeout recovery

If the script exits with code `124`, the Codex session may still be resumable.

What the script prints on timeout:
- `Session ID: <uuid>`
- `Session file: ~/.codex/sessions/YYYY/MM/DD/rollout-...-<uuid>.jsonl`
- a ready-to-run `codex exec resume <session_id> ...` command

Use that exact session identity. Do **not** use `codex resume --last`, `codex exec resume --last`, or “the newest file in `~/.codex/sessions`” when multiple jobs may be running concurrently.

## Verification

Fast script sanity check:

```text
run_skill_script(
  script="skill://codex-image-gen/scripts/codex-image-gen",
  interpreter="python3",
  args=["--help"],
  timeoutSeconds=30,
)
```

Live native-image success path:

```text
run_skill_script(
  script="skill://codex-image-gen/scripts/codex-image-gen",
  interpreter="python3",
  args=[
    "--timeout-seconds", "900",
    "--output-dir", "/tmp/pi-work/codex-image-gen/smoke-test",
    "Generate a simple 512x512 PNG of a friendly robot reading under a paper lantern. Use native image generation and verify the copied PNG exists."
  ],
  timeoutSeconds=960,
)
```

Frontend UI success path:

```text
run_skill_script(
  script="skill://codex-image-gen/scripts/codex-image-gen",
  interpreter="python3",
  args=[
    "--timeout-seconds", "1200",
    "--frontend-ui",
    "--output-dir", "/tmp/pi-work/codex-image-gen/frontend-smoke-test",
    "--size", "16:9",
    "Generate a Catppuccin-themed web UI mockup for a tiny notes dashboard, then describe it and write the HTML skeleton."
  ],
  timeoutSeconds=1260,
)
```

A successful frontend run should leave a generated image, `index.html`, and `design-note.md` in the output directory.
