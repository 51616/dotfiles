#!/usr/bin/env python3

import argparse
import json
import shutil
import subprocess
import sys
from typing import Optional

MODEL = "gpt-5.2"
REASONING_EFFORT = "high"

PROMPT_PREAMBLE = (
    "You are acting as a critical review helper for pi. "
    "Review code, diffs, plans, specs, and implementation notes precisely and skeptically. "
    "Prioritize correctness, regressions, scope drift, missing tests, maintainability, safety, and observability. "
    "State assumptions when they matter. "
    "Prefer concise, actionable findings over long rewrites. "
    "If there are no material issues, say that explicitly.\n\n"
    "User request:\n"
)


def _require_codex_on_path() -> None:
    if shutil.which("codex") is None:
        print(
            "Error: `codex` CLI not found on PATH. Install/login Codex first (e.g. `codex login`).",
            file=sys.stderr,
        )
        raise SystemExit(127)


def _last_agent_message_from_codex_jsonl(cmd: list[str]) -> str:
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
        bufsize=1,
    )

    last_msg: Optional[str] = None

    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        if ev.get("type") != "item.completed":
            continue
        item = ev.get("item")
        if not isinstance(item, dict):
            continue
        if item.get("type") != "agent_message":
            continue
        text = item.get("text")
        if isinstance(text, str):
            last_msg = text

    rc = proc.wait()
    if rc != 0:
        raise SystemExit(rc)
    if not last_msg:
        print("Error: codex produced no agent_message in JSON output.", file=sys.stderr)
        raise SystemExit(2)

    return last_msg


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="codex-review.sh",
        add_help=True,
        description=(
            "Codex-backed review helper for pi.\n\n"
            "Usage:\n"
            "  codex-review.sh \"<prompt>\"\n\n"
            "Prints only the last agent response from Codex JSON output."
        ),
        epilog=(
            "Examples:\n"
            "  codex-review.sh \"Review the changes in src/auth.ts against conductor/tracks/<track_id>/spec.md. Focus on correctness and missing tests.\"\n\n"
            "  codex-review.sh \"Review conductor/tracks/<track_id>/{spec.md,plan.md,resume.md} for contradictions and scope drift.\"\n\n"
            "  codex-review.sh \"Review the current working tree for likely regressions. Group findings by severity.\"\n"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "prompt",
        nargs=argparse.REMAINDER,
        help="Prompt text (everything after options becomes the prompt).",
    )

    args = parser.parse_args()
    _require_codex_on_path()

    user_prompt = " ".join(args.prompt).strip()
    if not user_prompt:
        parser.print_usage(sys.stderr)
        print("error: missing prompt", file=sys.stderr)
        raise SystemExit(2)

    prompt = PROMPT_PREAMBLE + user_prompt

    cmd = [
        "codex",
        "exec",
        "-m",
        MODEL,
        "-c",
        f"model_reasoning_effort={REASONING_EFFORT}",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
    ]

    msg = _last_agent_message_from_codex_jsonl(cmd)
    sys.stdout.write(msg)
    if not msg.endswith("\n"):
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
