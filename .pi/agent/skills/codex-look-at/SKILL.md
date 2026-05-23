---
name: codex-look-at
description: |
  Use when: pi needs a visual read of common local raster images such as PNG, JPG/JPEG, WEBP, or GIF screenshots/photos/figures, including describing visible content, reading text in an image, identifying UI/layout details, or comparing a small set of image files.
  Outputs: Codex CLI is run with attached image file(s) using `gpt-5.5` and medium reasoning, and pi reports the visual findings with the image paths and any uncertainty.
---

# codex-look-at

Use Codex CLI as a vision helper for local raster images.

## Flow

1) Confirm the target is a local raster image (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) and the visual question is clear enough.
2) If the image is sensitive and Tan did not explicitly provide it for analysis, ask before sending it to Codex.
3) Run `codex exec` with `gpt-5.5`, medium reasoning, read-only sandboxing, and one or more `--image` attachments.
4) Report Codex’s findings in pi’s own words, including the image path(s), visible evidence, and uncertainty when the image is low-resolution or ambiguous.

## Commands

Single image:

```bash
codex exec --skip-git-repo-check --sandbox read-only \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="medium"' \
  --image /path/to/image.png \
  -- "Describe the visible content. Focus on observable details; do not infer private identity."
```

Multiple images:

```bash
codex exec --skip-git-repo-check --sandbox read-only \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="medium"' \
  --image /path/to/first.png \
  --image /path/to/second.jpg \
  -- "Compare these images and list the visible differences."
```

Use `--` before the prompt. The Codex CLI image flag accepts multiple values, so the separator prevents the prompt from being parsed as another image path.

For long-running or uncertain calls, wrap the command with a timeout:

```bash
timeout 180s codex exec --skip-git-repo-check --sandbox read-only \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="medium"' \
  --image /path/to/image.png \
  -- "Answer the visual question in concise bullets."
```

## Prompting notes

- Ask for observable facts first: text, objects, layout, colors, UI labels, charts, equations, or visible changes.
- For OCR-like tasks, ask Codex to preserve line breaks and mark uncertain text as `[unclear]`.
- For screenshots, ask for actionable UI state rather than a generic caption.
- For diagrams/figures, ask for the visual structure and any readable labels before interpretation.
- Avoid identity, emotion, age, medical, or other sensitive inferences unless Tan explicitly asks and the answer can be grounded in visible non-sensitive evidence.

## Verification

Use a known image sample and require a short observable answer:

```bash
timeout 180s codex exec --skip-git-repo-check --sandbox read-only \
  -m gpt-5.5 \
  -c 'model_reasoning_effort="medium"' \
  --image "$HOME/vault/personal/Pasted image 20240108174420.png" \
  -- "Describe this image in one concise sentence. Do not infer private identity; focus only on visible content."
```

A successful run prints `model: gpt-5.5`, `reasoning effort: medium`, and a concise description of the attached image.
