#!/usr/bin/env python3
"""Validate a pi skill directory without external YAML dependencies.

Checks:
- SKILL.md exists.
- YAML frontmatter exists and can be parsed with the supported subset.
- Frontmatter has only: name, description.
- name is strict hyphen-case and <= 64 chars.
- description is a string, <= 4096 chars, and contains a concrete `Use when:` clause.
- Generated `__FILL_ME__` draft markers are not left in SKILL.md.
- The body mentions a Verification step or section.

Supported YAML subset:
- Top-level mapping only.
- Scalars: `name: foo`, `description: bar`.
- Block scalar: `description: |` (or `|-`) followed by indented lines.

Usage:
  python quick_validate.py <path/to/skill-dir>

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
DRAFT_MARKER = "__FILL_ME__"
REQUIRED_DESCRIPTION_LABELS = ("Use when:",)
OPTIONAL_DESCRIPTION_LABELS = ("Don’t use when:", "Don't use when:", "Outputs:")


@dataclass(frozen=True)
class Frontmatter:
    name: str
    description: str


class SkillValidationError(ValueError):
    """Validation failure with optional source location context."""

    def __init__(self, message: str, *, path: Path | None = None, line: int | None = None, text: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.path = path
        self.line = line
        self.text = text

    def __str__(self) -> str:
        parts = [self.message]
        if self.path is not None:
            parts.append(f"  file: {self.path}")
        if self.line is not None:
            parts.append(f"  line: {self.line}")
        if self.text is not None:
            parts.append(f"  text: {self.text}")
        return "\n".join(parts)


_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")
_VERIFICATION_RE = re.compile(r"^(?:##\s+Verification\s*$|\d+\)\s+\*\*Verification\*\*)", re.MULTILINE)


def _unquote_scalar(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s


def _line_context(content: str, needle: str) -> tuple[int, str] | None:
    index = content.find(needle)
    if index == -1:
        return None

    line_no = content.count("\n", 0, index) + 1
    line_text = content.splitlines()[line_no - 1].strip()
    return line_no, line_text


def parse_frontmatter_yaml_subset(frontmatter_text: str, *, line_offset: int = 1) -> dict[str, str]:
    """Parse a tiny YAML subset sufficient for SKILL.md frontmatter.

    `line_offset` is the 1-indexed line number of the first frontmatter line in
    the source file. For SKILL.md this is usually 2 because line 1 is `---`.
    """

    lines = frontmatter_text.splitlines()
    i = 0
    out: dict[str, str] = {}

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip("\n")
        source_line = line_offset + i

        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue

        m = _KEY_RE.match(line)
        if not m:
            raise SkillValidationError(
                "unsupported YAML line; expected `key: value`",
                line=source_line,
                text=raw,
            )

        key = m.group(1)
        rest = m.group(2)

        if key in out:
            raise SkillValidationError(f"duplicate key in frontmatter: {key}", line=source_line, text=raw)

        rest_stripped = rest.strip()

        if rest_stripped in {"|", "|-"}:
            i += 1
            block_lines: list[str] = []
            indent: int | None = None

            while i < len(lines):
                current = lines[i]

                if current.strip() == "":
                    block_lines.append("")
                    i += 1
                    continue

                m_indent = re.match(r"^(\s+)(.*)$", current)
                if not m_indent:
                    break

                ind = len(m_indent.group(1))
                if indent is None:
                    indent = ind
                if ind < indent:
                    break

                block_lines.append(current[indent:])
                i += 1

            out[key] = "\n".join(block_lines).rstrip("\n")
            continue

        out[key] = _unquote_scalar(rest)
        i += 1

    return out


def split_frontmatter_and_body(skill_md: Path) -> tuple[dict[str, str], str, str]:
    content = skill_md.read_text(encoding="utf-8", errors="ignore")
    if not content.startswith("---\n"):
        raise SkillValidationError("no YAML frontmatter found; file must start with `---`", path=skill_md, line=1)

    m = _FRONTMATTER_RE.match(content)
    if not m:
        raise SkillValidationError("invalid frontmatter format; expected `--- ... ---`", path=skill_md, line=1)

    try:
        fm = parse_frontmatter_yaml_subset(m.group(1), line_offset=2)
    except SkillValidationError as exc:
        raise SkillValidationError(exc.message, path=skill_md, line=exc.line, text=exc.text) from exc

    body = content[m.end() :]
    return fm, body, content


def _label_body(description: str, label: str) -> str:
    start = description.find(label)
    if start == -1:
        return ""

    start += len(label)
    next_positions = [
        pos
        for candidate in REQUIRED_DESCRIPTION_LABELS + OPTIONAL_DESCRIPTION_LABELS
        if candidate != label
        for pos in [description.find(candidate, start)]
        if pos != -1
    ]
    end = min(next_positions) if next_positions else len(description)
    return description[start:end].strip()


def _validate_description(description: str) -> None:
    if len(description) == 0:
        raise SkillValidationError("description must not be empty")
    if len(description) > MAX_DESCRIPTION_LENGTH:
        raise SkillValidationError(f"description too long ({len(description)} > {MAX_DESCRIPTION_LENGTH})")

    for label in REQUIRED_DESCRIPTION_LABELS:
        if not _label_body(description, label):
            raise SkillValidationError(f"description must include a non-empty `{label}` clause")

    for label in OPTIONAL_DESCRIPTION_LABELS:
        if label in description and not _label_body(description, label):
            raise SkillValidationError(f"description has an empty optional `{label}` clause")


def _validate_no_draft_marker(skill_md: Path, content: str) -> None:
    context = _line_context(content, DRAFT_MARKER)
    if context is None:
        return

    line_no, line_text = context
    raise SkillValidationError(
        f"unresolved generated draft marker found: {DRAFT_MARKER}",
        path=skill_md,
        line=line_no,
        text=line_text,
    )


def validate_skill_dir(skill_dir: Path) -> Frontmatter:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        raise SkillValidationError("SKILL.md not found", path=skill_md)

    fm, body, content = split_frontmatter_and_body(skill_md)

    extra = set(fm.keys()) - ALLOWED_KEYS
    if extra:
        raise SkillValidationError(
            f"unexpected key(s) in frontmatter: {', '.join(sorted(extra))}. "
            f"Allowed: {', '.join(sorted(ALLOWED_KEYS))}.",
            path=skill_md,
        )

    if "name" not in fm:
        raise SkillValidationError("missing `name` in frontmatter", path=skill_md)
    if "description" not in fm:
        raise SkillValidationError("missing `description` in frontmatter", path=skill_md)

    name = fm["name"]
    if not isinstance(name, str):
        raise SkillValidationError("name must be a string", path=skill_md)
    name = name.strip()

    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise SkillValidationError("name must be hyphen-case without leading/trailing/doubled hyphens", path=skill_md)
    if len(name) > MAX_SKILL_NAME_LENGTH:
        raise SkillValidationError(f"name too long ({len(name)} > {MAX_SKILL_NAME_LENGTH})", path=skill_md)

    desc = fm["description"]
    if not isinstance(desc, str):
        raise SkillValidationError("description must be a string", path=skill_md)
    desc = desc.strip()
    try:
        _validate_description(desc)
    except SkillValidationError as exc:
        context = _line_context(content, "description:")
        line_no = context[0] if context else None
        raise SkillValidationError(exc.message, path=skill_md, line=line_no) from exc

    _validate_no_draft_marker(skill_md, content)

    if not re.search(rf"^#\s+{re.escape(name)}\s*$", body, re.MULTILINE):
        raise SkillValidationError(f"body must include an H1 heading: # {name}", path=skill_md)
    if not _VERIFICATION_RE.search(body):
        raise SkillValidationError("body must include a Verification step or section", path=skill_md)

    return Frontmatter(name=name, description=desc)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Usage: python quick_validate.py <path/to/skill-dir>")
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
