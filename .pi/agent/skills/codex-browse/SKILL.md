---
name: codex-browse
description: |
  Use when: Tan wants you (pi) to use the public internet: web research, reading an article, extracting main content from a URL, summarizing online docs/posts, gathering citations/links, or doing any browsing-style task where a normal answer requires checking current web sources.
  Typical triggers:
  - Tan pastes a URL (https://…)
  - “read this link / article / blog post”
  - “summarize this page” / “extract the main content”
  - “search the web for …” / “find sources for …” / “give me a list of links about …”
  - “download/save the content somewhere and give me a path”
  Don’t use when:
  - The target is a GitHub repo/tree/blob (prefer the `gitingest` skill).
  - The task requires interactive UI testing or clicking through web apps (use `browser-tools`).
  - Offline answers are sufficient and do not require verification against web sources.
---

# codex-browse

Use Codex CLI as an internet/browsing helper.

## Commands

### Prompt mode (general)

```bash
codex-browser "<prompt>"
```

Examples:
- Get links only:
  ```bash
  codex-browser "Find 5 high-quality sources about X. Return only a bullet list of URLs."
  ```
- Summarize a topic with citations:
  ```bash
  codex-browser "Research X and summarize in 10 bullets. Include source URLs."
  ```
- Ask it to save a long artifact:
  ```bash
  codex-browser "Download the PDF at <url> and save it under /tmp. Reply with the path only."
  ```

### Content extraction mode (URL → markdown file)

```bash
codex-browser --extract-content https://example.com/article
```

This uses a fixed prompt template to extract main content, format as markdown, and save under `/tmp`.

## Verification

```bash
codex-browser "Respond with exactly: hello"
```
