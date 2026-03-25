#!/usr/bin/env python3
"""Fetch AlphaXiv paper metadata + AI overview with retries.

Why this exists:
- api.alphaxiv.org can be intermittently slow (cold starts / backend load).
- this script uses conservative timeouts + retries with exponential backoff.

Usage:
  python .pi/skills/alphaxiv-paper-lookup/scripts/fetch_overview.py 2602.15902
  python .../fetch_overview.py 2602.15902v2

Output:
- Writes a single JSON blob to stdout:
  {"paper": {...}, "overview": {...}}

Exit codes:
- 0 on success
- 2 on not-found (paper not indexed)
- 1 on other errors
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class RetryConfig:
    attempts: int = 6
    base_delay_s: float = 0.8
    max_delay_s: float = 8.0


def _sleep_s(attempt_idx: int, cfg: RetryConfig) -> None:
    # attempt_idx: 0..N-1, increasing delay
    delay = min(cfg.max_delay_s, cfg.base_delay_s * (2**attempt_idx))
    time.sleep(delay)


def _should_retry(status_code: int) -> bool:
    # retry on typical transient errors
    return status_code in {408, 409, 425, 429, 500, 502, 503, 504}


def get_json_with_retries(
    client: httpx.Client,
    url: str,
    *,
    cfg: RetryConfig,
) -> dict:
    last_exc: Exception | None = None
    for i in range(cfg.attempts):
        try:
            r = client.get(url)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            if _should_retry(r.status_code):
                last_exc = RuntimeError(f"HTTP {r.status_code} for {url}")
                _sleep_s(i, cfg)
                continue
            r.raise_for_status()
            return r.json()
        except FileNotFoundError:
            raise
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError, json.JSONDecodeError) as e:
            last_exc = e
            if i == cfg.attempts - 1:
                break
            _sleep_s(i, cfg)

    assert last_exc is not None
    raise last_exc


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] in {"-h", "--help"}:
        print(__doc__.strip())
        return 0 if len(argv) == 2 else 1

    paper_id = argv[1].strip()

    # Separate connect/read timeouts. The API sometimes accepts the connection
    # quickly but delays first byte.
    timeout = httpx.Timeout(connect=5.0, read=120.0, write=20.0, pool=5.0)

    headers = {
        "accept": "application/json",
        "user-agent": "pi/alphaxiv-paper-lookup (fetch_overview.py)",
    }

    cfg = RetryConfig()

    # http2=True requires the optional 'h2' dependency; keep this script zero-dep.
    with httpx.Client(timeout=timeout, headers=headers, http2=False, follow_redirects=True) as client:
        paper_url = f"https://api.alphaxiv.org/papers/v3/{paper_id}"
        try:
            paper = get_json_with_retries(client, paper_url, cfg=cfg)
        except FileNotFoundError:
            print(json.dumps({"error": "paper_not_indexed", "paperId": paper_id}, ensure_ascii=False))
            return 2

        version_id = paper.get("versionId")
        if not version_id:
            print(json.dumps({"error": "missing_versionId", "paper": paper}, ensure_ascii=False))
            return 1

        overview_url = f"https://api.alphaxiv.org/papers/v3/{version_id}/overview/en"
        try:
            overview = get_json_with_retries(client, overview_url, cfg=cfg)
        except FileNotFoundError:
            print(json.dumps({"error": "overview_not_available", "paperId": paper_id, "versionId": version_id}, ensure_ascii=False))
            return 2

    try:
        sys.stdout.write(json.dumps({"paper": paper, "overview": overview}, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
    except BrokenPipeError:
        # Common when users pipe to `head`/`jq`/etc. Don’t treat as an error.
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
