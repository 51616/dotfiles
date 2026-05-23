#!/usr/bin/env python3
"""Render a new SKILL.md from the skill-authoring template."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DRAFT_MARKER = "__FILL_ME__"

REPLACEMENTS: dict[str, str] = {
    "<concrete trigger(s), scope boundaries, and preconditions>": f"{DRAFT_MARKER}: describe concrete trigger(s), scope boundaries, and preconditions",
    "<one-sentence scope statement>": f"{DRAFT_MARKER}: write a one-sentence scope statement",
    "<first action>": f"{DRAFT_MARKER}: write the first action",
    "<second action>": f"{DRAFT_MARKER}: write the second action",
    "<verification or handoff action>": f"{DRAFT_MARKER}: write the verification or handoff action",
    "<copy/paste starting points, if needed>": f"{DRAFT_MARKER}: list templates or delete this line",
    "<worked outputs, if needed>": f"{DRAFT_MARKER}: list examples or delete this line",
    "<deterministic helpers or smoke tests, if needed>": f"{DRAFT_MARKER}: list scripts or delete this line",
    "<one concrete command or observable check>": f"{DRAFT_MARKER}: write one concrete command or observable check",
}


def render_skill_template(template_path: Path, output_path: Path, skill_name: str) -> None:
    if not SKILL_NAME_RE.fullmatch(skill_name):
        raise ValueError("skill name must be hyphen-case without leading/trailing/doubled hyphens")

    template = template_path.read_text(encoding="utf-8")
    text = template.replace("<skill-name>", skill_name)
    for old, new in REPLACEMENTS.items():
        text = text.replace(old, new)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Render SKILL.md from a skill-authoring template.")
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()

    render_skill_template(args.template, args.output, args.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
