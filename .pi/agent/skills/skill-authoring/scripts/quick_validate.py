#!/usr/bin/env python3
"""quick_validate.py

Minimal skill validation for this vault.

Checks:
- SKILL.md exists
- YAML frontmatter parses
- frontmatter has only: name, description
- name is hyphen-case and <= 64 chars
- description is a string and <= 1024 chars

Usage:
  python3 quick_validate.py <path/to/skill-dir>

Exit codes:
- 0 valid
- 1 invalid
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

MAX_SKILL_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
ALLOWED_KEYS = {"name", "description"}


def read_frontmatter(skill_md: Path) -> dict:
    content = skill_md.read_text(errors="ignore")
    if not content.startswith("---\n"):
        raise ValueError("No YAML frontmatter found (must start with ---)")

    m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if not m:
        raise ValueError("Invalid frontmatter format (expected --- ... ---)")

    fm_text = m.group(1)
    try:
        fm = yaml.safe_load(fm_text)
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML in frontmatter: {e}") from e

    if not isinstance(fm, dict):
        raise ValueError("Frontmatter must be a YAML mapping/dictionary")

    return fm


def validate_skill_dir(skill_dir: Path) -> None:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        raise ValueError("SKILL.md not found")

    fm = read_frontmatter(skill_md)

    extra = set(fm.keys()) - ALLOWED_KEYS
    if extra:
        raise ValueError(
            f"Unexpected key(s) in frontmatter: {', '.join(sorted(extra))}. "
            f"Allowed: {', '.join(sorted(ALLOWED_KEYS))}."
        )

    if "name" not in fm:
        raise ValueError("Missing 'name' in frontmatter")
    if "description" not in fm:
        raise ValueError("Missing 'description' in frontmatter")

    name = fm["name"]
    if not isinstance(name, str):
        raise ValueError(f"name must be a string, got {type(name).__name__}")
    name = name.strip()
    if not re.match(r"^[a-z0-9-]+$", name):
        raise ValueError("name must be hyphen-case (lowercase letters, digits, hyphens)")
    if name.startswith("-") or name.endswith("-") or "--" in name:
        raise ValueError("name cannot start/end with '-' or contain '--'")
    if len(name) > MAX_SKILL_NAME_LENGTH:
        raise ValueError(
            f"name too long ({len(name)} > {MAX_SKILL_NAME_LENGTH})"
        )

    desc = fm["description"]
    if not isinstance(desc, str):
        raise ValueError(f"description must be a string, got {type(desc).__name__}")
    desc = desc.strip()
    if len(desc) > MAX_DESCRIPTION_LENGTH:
        raise ValueError(
            f"description too long ({len(desc)} > {MAX_DESCRIPTION_LENGTH})"
        )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python3 quick_validate.py <path/to/skill-dir>")
        return 1

    skill_dir = Path(argv[1]).expanduser().resolve()
    try:
        validate_skill_dir(skill_dir)
    except Exception as e:
        print(f"INVALID: {e}")
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
