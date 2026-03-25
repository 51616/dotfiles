---
name: alphaxiv-paper-lookup
description: |
  Look up any arxiv paper on alphaxiv.org to get a structured AI-generated overview.
  This is faster and more reliable than trying to read a raw PDF.
  Use when:
  - User shares an arxiv URL (e.g. `arxiv.org/abs/2401.12345`)
  - User mentions a paper ID (e.g. `2401.12345`)
  - User asks you to explain, summarize, or analyze a research paper
  - User shares an alphaxiv URL (e.g. `alphaxiv.org/overview/2401.12345`)
---

# AlphaXiv Paper Lookup

Look up any arxiv paper on alphaxiv.org to get a structured AI-generated overview. This is faster and more reliable than trying to read a raw PDF.

## Workflow

### Step 1: Extract the paper ID

Parse the paper ID from whatever the user provides:

| Input                                      | Paper ID       |
| ------------------------------------------ | -------------- |
| `https://arxiv.org/abs/2401.12345`         | `2401.12345`   |
| `https://arxiv.org/pdf/2401.12345`         | `2401.12345`   |
| `https://alphaxiv.org/overview/2401.12345` | `2401.12345`   |
| `2401.12345v2`                             | `2401.12345v2` |
| `2401.12345`                               | `2401.12345`   |

### Step 2: Resolve the paper

AlphaXiv’s API can be intermittently slow (e.g. cold starts). Use **explicit timeouts + retries**.

```bash
curl -sS --connect-timeout 5 --max-time 60 \
  --retry 6 --retry-all-errors --retry-delay 1 \
  "https://api.alphaxiv.org/papers/v3/{PAPER_ID}"
```

Extract `versionId` from the JSON response. This is the UUID needed for the next call.

If this returns 404, the paper hasn't been indexed on alphaxiv yet.

### Step 3: Fetch the AI overview

```bash
curl -sS --connect-timeout 5 --max-time 120 \
  --retry 6 --retry-all-errors --retry-delay 1 \
  "https://api.alphaxiv.org/papers/v3/{VERSION_ID}/overview/en"
```

The response contains:

- **`intermediateReport`** — the machine-readable report (structured text, best for LLM consumption)
- **`overview`** — the full markdown blog post (human-readable)
- **`summary`** — structured summary with fields: `summary`, `originalProblem`, `solution`, `keyInsights`, `results`
- **`citations`** — list of cited papers with titles and justifications

**Prefer `intermediateReport`** when available — it's specifically formatted for machine consumption. Fall back to `summary` fields if `intermediateReport` is null.

### Step 4: If you need more detail, fetch the full text

If the `intermediateReport`, `summary`, and `overview` fields don't contain the specific information the user is asking about (e.g. a particular equation, table, or section), fetch the full paper text:

```bash
curl -s "https://alphaxiv.org/abs/{PAPER_ID}.md"
```

This returns the full extracted text of the paper as markdown. Only use this as a fallback — the overview and intermediate report are usually sufficient.

If this returns 404, the full text hasn't been processed yet. As a last resort, direct the user to the PDF at `https://arxiv.org/pdf/{PAPER_ID}`.

## Error Handling

- **Timeouts / hangs**: AlphaXiv can accept TLS but delay the first byte. Increase read timeouts and retry.
  - `curl`: add `--max-time 120` (or more) + `--retry-all-errors`.
  - Python: use separate connect/read timeouts (e.g. `timeout=(5, 120)`) and retries/backoff.
- **404 on Step 2**: Paper not indexed. Tell the user it's not available on alphaxiv yet.
- **404 on Step 3**: Overview not generated for this paper.
- **5xx / 429**: Treat as transient; retry with backoff.
- **`intermediateReport` is null**: Use `summary` and `overview` fields instead.

## Optional: one-shot robust fetch script

For reliable automation inside the vault, use:

```bash
python .pi/skills/alphaxiv-paper-lookup/scripts/fetch_overview.py {PAPER_ID} > /tmp/alphaxiv.json
```

It prints a single JSON object containing both `paper` and `overview`, with retries/backoff.

## Notes

- No authentication required — these are public endpoints.
- AlphaXiv currently appears to be **IPv4-only** (no AAAA). Avoid `curl -6`.
- Replace `en` with a language code (`fr`, `de`, `es`, `zh`, `ja`, `ar`, `hi`, `pt`) for translated overviews.

