#!/usr/bin/env python3
"""quick_validate.py

Minimal skill validation for this vault, without external YAML dependencies.

Checks:
- SKILL.md exists
- YAML frontmatter exists and can be parsed (supported subset)
- frontmatter has only: name, description
- name is hyphen-case and <= 64 chars
- description is a string and <= 4096 chars

Supported YAML subset:
- Top-level mapping only
- Scalars: `name: foo`, `description: bar`
- Block scalar: `description: |` (or `|-`) followed by indented lines

Usage:
  python3 quick_validate.py <path/to/skill-dir>

Exit codes:
- 0 valid
- 1 invalid
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 4096
ALLOWED_KEYS = {"name", "description"}


@dataclass(frozen=True)
class Frontmatter:
    name: str
    description: str


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")


def _unquote_scalar(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s


def parse_frontmatter_yaml_subset(frontmatter_text: str) -> dict[str, str]:
    """Parse a tiny YAML subset sufficient for our SKILL.md frontmatter.

    Intentionally rejects complex YAML features (lists, nested mappings, anchors).
    """

    lines = frontmatter_text.splitlines()
    i = 0
    out: dict[str, str] = {}

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip("\n")

        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue

        m = _KEY_RE.match(line)
        if not m:
            raise ValueError(f"Unsupported YAML line (expected key: value): {raw!r}")

        key = m.group(1)
        rest = m.group(2)

        if key in out:
            raise ValueError(f"Duplicate key in frontmatter: {key}")

        rest_stripped = rest.strip()

        # Block scalar (| or |-) for multi-line description.
        if rest_stripped in {"|", "|-"}:
            i += 1
            block_lines: list[str] = []
            indent: int | None = None

            while i < len(lines):
                l = lines[i]

                # Empty lines are allowed inside blocks; preserve as empty.
                if l.strip() == "":
                    block_lines.append("")
                    i += 1
                    continue

                m_indent = re.match(r"^(\s+)(.*)$", l)
                if not m_indent:
                    # Non-indented line => end of block scalar.
                    break

                ind = len(m_indent.group(1))
                if indent is None:
                    indent = ind
                if ind < indent:
                    break

                block_lines.append(l[indent:])
                i += 1

            out[key] = "\n".join(block_lines).rstrip("\n")
            continue

        # Plain scalar.
        out[key] = _unquote_scalar(rest)
        i += 1

    return out


def read_frontmatter(skill_md: Path) -> dict[str, str]:
    content = skill_md.read_text(encoding="utf-8", errors="ignore")
    if not content.startswith("---\n"):
        raise ValueError("No YAML frontmatter found (must start with ---)")

    m = _FRONTMATTER_RE.match(content)
    if not m:
        raise ValueError("Invalid frontmatter format (expected --- ... ---)")

    fm_text = m.group(1)
    fm = parse_frontmatter_yaml_subset(fm_text)

    if not isinstance(fm, dict):
        raise ValueError("Frontmatter must be a mapping")

    return fm


def validate_skill_dir(skill_dir: Path) -> Frontmatter:
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
        raise ValueError(f"name must be a string")
    name = name.strip()

    if not re.match(r"^[a-z0-9-]+$", name):
        raise ValueError("name must be hyphen-case (lowercase letters, digits, hyphens)")
    if name.startswith("-") or name.endswith("-") or "--" in name:
        raise ValueError("name cannot start/end with '-' or contain '--'")
    if len(name) > MAX_SKILL_NAME_LENGTH:
        raise ValueError(f"name too long ({len(name)} > {MAX_SKILL_NAME_LENGTH})")

    desc = fm["description"]
    if not isinstance(desc, str):
        raise ValueError("description must be a string")
    desc = desc.strip()

    if len(desc) == 0:
        raise ValueError("description must not be empty")
    if len(desc) > MAX_DESCRIPTION_LENGTH:
        raise ValueError(f"description too long ({len(desc)} > {MAX_DESCRIPTION_LENGTH})")

    return Frontmatter(name=name, description=desc)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python3 quick_validate.py <path/to/skill-dir>")
        return 1

    skill_dir = Path(argv[1]).expanduser().resolve()

    try:
        fm = validate_skill_dir(skill_dir)
    except Exception as e:
        print(f"INVALID: {e}")
        return 1

    print("OK")
    print(f"  name: {fm.name}")
    print(f"  description_length: {len(fm.description)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
