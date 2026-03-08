---
name: brave-search
description: "Read and extract web pages (articles/blog posts/docs) and do web search via Brave Search API. Trigger when Tan pastes a URL or says: read this link/article/post, summarize this page, what does this blog say, discuss this online post." 
---

# Brave Search

Web search and content extraction using the official Brave Search API. No browser required.

## Setup

Requires a Brave Search API account with a free subscription. A credit card is required to create the free subscription (you won't be charged).

1. Create an account at https://api-dashboard.search.brave.com/register
2. Create a "Free AI" subscription
3. Create an API key for the subscription
4. Add to your shell profile (`~/.profile` or `~/.zprofile` for zsh):
   ```bash
   export BRAVE_API_KEY="your-api-key-here"
   ```
5. Install dependencies (run once):
   ```bash
   cd {baseDir}
   npm install
   ```

## Search

```bash
{baseDir}/search.js "query"                         # Basic search (5 results)
{baseDir}/search.js "query" -n 10                   # More results (max 20)
{baseDir}/search.js "query" --content               # Include page content as markdown
{baseDir}/search.js "query" --freshness pw          # Results from last week
{baseDir}/search.js "query" --freshness 2024-01-01to2024-06-30  # Date range
{baseDir}/search.js "query" --country DE            # Results from Germany
{baseDir}/search.js "query" -n 3 --content          # Combined options
```

### Options

- `-n <num>` - Number of results (default: 5, max: 20)
- `--content` - Fetch and include page content as markdown
- `--country <code>` - Two-letter country code (default: US)
- `--freshness <period>` - Filter by time:
  - `pd` - Past day (24 hours)
  - `pw` - Past week
  - `pm` - Past month
  - `py` - Past year
  - `YYYY-MM-DDtoYYYY-MM-DD` - Custom date range

## Extract Page Content

```bash
{baseDir}/content.js https://example.com/article
```

Fetches a URL and extracts readable content as markdown.

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Age: 2 days ago
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## When to Use

Use this skill whenever Tan wants you to **read something online**.

Common triggers:
- Tan pastes a URL (https://…)
- “read this link / article / blog post”
- “summarize this page” / “what does this post say?”
- “extract the key points / quotes from this webpage”

Also useful for:
- Searching for documentation or API references (non-GitHub sources)
- Looking up facts or current information
- Fetching content from specific URLs (articles, blogs, docs sites)
- Any task requiring web search without interactive browsing

### Preference Note (GitHub)

If the user provides a **GitHub repo / tree / blob URL**, prefer the `gitingest` skill to ingest the repo/subdir and read the file content from git directly. Use Brave Search only when gitingest can’t access the content or when the target is not really a repo (e.g., general web pages).
