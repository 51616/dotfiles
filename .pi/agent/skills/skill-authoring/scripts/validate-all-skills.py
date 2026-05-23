#!/usr/bin/env python3
"""Validate all pi skills under known skill roots.

Default roots:
- <current-working-directory>/.pi/skills
- ~/.pi/agent/skills

The scanner validates each unique resolved skill directory once, reports broken
symlinks, and rejects duplicate frontmatter names across distinct skill dirs.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from quick_validate import Frontmatter, validate_skill_dir  # noqa: E402


@dataclass(frozen=True)
class SkillRecord:
    root: Path
    path: Path
    resolved_path: Path
    frontmatter: Frontmatter


@dataclass(frozen=True)
class SkillFailure:
    path: Path
    message: str


def default_roots() -> list[Path]:
    candidates = [Path.cwd() / ".pi" / "skills", Path.home() / ".pi" / "agent" / "skills"]
    roots: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        expanded = candidate.expanduser()
        key = expanded.resolve() if expanded.exists() else expanded.absolute()
        if key in seen:
            continue
        seen.add(key)
        roots.append(expanded)
    return roots


def iter_skill_entries(root: Path) -> list[Path]:
    if not root.exists():
        return []
    if not root.is_dir():
        return []
    return sorted((path for path in root.iterdir() if not path.name.startswith(".")), key=lambda path: path.name)


def scan_roots(roots: list[Path]) -> tuple[list[SkillRecord], list[SkillFailure], list[Path]]:
    records: list[SkillRecord] = []
    failures: list[SkillFailure] = []
    skipped_duplicate_paths: list[Path] = []
    seen_resolved_dirs: set[Path] = set()

    for root in roots:
        for entry in iter_skill_entries(root):
            if entry.is_symlink() and not entry.exists():
                failures.append(SkillFailure(entry, "broken symlink"))
                continue
            if not entry.is_dir():
                continue

            resolved = entry.resolve()
            if resolved in seen_resolved_dirs:
                skipped_duplicate_paths.append(entry)
                continue
            seen_resolved_dirs.add(resolved)

            try:
                fm = validate_skill_dir(entry)
            except Exception as exc:
                failures.append(SkillFailure(entry, str(exc)))
                continue

            records.append(SkillRecord(root=root, path=entry, resolved_path=resolved, frontmatter=fm))

    return records, failures, skipped_duplicate_paths


def duplicate_name_failures(records: list[SkillRecord]) -> list[SkillFailure]:
    by_name: dict[str, list[SkillRecord]] = {}
    for record in records:
        by_name.setdefault(record.frontmatter.name, []).append(record)

    failures: list[SkillFailure] = []
    for name, matches in sorted(by_name.items()):
        distinct_resolved = {match.resolved_path for match in matches}
        if len(distinct_resolved) <= 1:
            continue
        paths = ", ".join(str(match.path) for match in matches)
        failures.append(SkillFailure(matches[0].path, f"duplicate skill name `{name}` across: {paths}"))
    return failures


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate all skills under one or more roots.")
    parser.add_argument(
        "roots",
        nargs="*",
        type=Path,
        help="Skill roots to scan. Defaults to ./.pi/skills and ~/.pi/agent/skills.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    roots = [root.expanduser() for root in args.roots] if args.roots else default_roots()

    records, failures, skipped_duplicate_paths = scan_roots(roots)
    failures.extend(duplicate_name_failures(records))

    print("Skill validation summary")
    print(f"  roots: {len(roots)}")
    for root in roots:
        print(f"    - {root}")
    print(f"  valid_unique_skills: {len(records)}")
    print(f"  skipped_duplicate_paths: {len(skipped_duplicate_paths)}")
    print(f"  failures: {len(failures)}")

    if skipped_duplicate_paths:
        print("\nSkipped duplicate paths (same resolved directory already validated):")
        for path in skipped_duplicate_paths:
            print(f"  - {path} -> {path.resolve()}")

    if failures:
        print("\nFailures:")
        for failure in failures:
            print(f"  - {failure.path}: {failure.message}")
        return 1

    print("\nOK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
