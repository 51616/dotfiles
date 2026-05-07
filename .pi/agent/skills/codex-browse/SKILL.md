---
name: codex-browse
description: |
  Use when: Tan wants you (pi) to use the public internet: web research, reading an article, extracting main content from a URL, summarizing online docs/posts, gathering citations/links, or doing any browsing-style task where a normal answer requires checking current web sources.
  Typical triggers:
  - Tan pastes a URL (https://…)
  - “read this link / article / blog post”
  - “summarize this page” / “extract the main content”
  - “search the web for …” / “find sources for …” / “give me a list of links about …”
  Don’t use when:
  - The target is a GitHub repo/tree/blob (prefer the `read-git-repo` skill).
  - Offline answers are sufficient and do not require verification against web sources.
  Outputs: runs Codex CLI with native web search and returns a cited answer or a concrete `/tmp/pi-work/codex-browse/...` artifact path when extraction/download output is requested.
---

# codex-browse

Use Codex CLI with native web search as an internet/browsing helper.

Use a shell `timeout` of 300 seconds by default. Increase it for broad research tasks. Save long outputs under `/tmp/pi-work/codex-browse/` so the path is easy to report back.

## Commands

### Prompt mode (general)

```bash
mkdir -p /tmp/pi-work/codex-browse
timeout 300s codex --search exec --skip-git-repo-check \
  --output-last-message /tmp/pi-work/codex-browse/last-response.md \
  "<prompt>"
```

Examples:
- Get links only:
  ```bash
  timeout 300s codex --search exec --skip-git-repo-check \
    "Find 5 high-quality sources about X. Return only a bullet list of URLs."
  ```
- Summarize a topic with citations:
  ```bash
  timeout 300s codex --search exec --skip-git-repo-check \
    "Research X and summarize in 10 bullets. Include source URLs."
  ```
- Ask it to save a long artifact:
  ```bash
  mkdir -p /tmp/pi-work/codex-browse
  timeout 300s codex --search exec --skip-git-repo-check \
    --output-last-message /tmp/pi-work/codex-browse/research.md \
    "Research X deeply. Return a structured Markdown report with source URLs."
  ```

### Content extraction mode (URL → markdown file)

```bash
mkdir -p /tmp/pi-work/codex-browse
url="https://example.com/article"
out="/tmp/pi-work/codex-browse/extracted-$(date +%Y%m%d-%H%M%S).md"
timeout 300s codex --search exec --skip-git-repo-check \
  --output-last-message "$out" \
  "Open $url. Extract the main article content as Markdown. Include the title, canonical URL, publication date if visible, and source URL. Exclude navigation, ads, comments, and unrelated page chrome. If extraction fails, explain why."
echo "$out"
```

## Verification

```bash
mkdir -p /tmp/pi-work/codex-browse
timeout 60s codex --search exec --skip-git-repo-check \
  --output-last-message /tmp/pi-work/codex-browse/verify.txt \
  "Respond with exactly: hello"
cat /tmp/pi-work/codex-browse/verify.txt
```
