#!/usr/bin/env python3
"""Regression tests for validate-all-skills.py."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("validate_all_skills", SCRIPT_DIR / "validate-all-skills.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load validate-all-skills.py")
validate_all_skills = importlib.util.module_from_spec(SPEC)
sys.modules["validate_all_skills"] = validate_all_skills
SPEC.loader.exec_module(validate_all_skills)


VALID_SKILL = """---
name: {name}
description: |
  Use when: validating {name}.
---

# {name}

## Verification

- Run validation.
"""


class ValidateAllSkillsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "skills"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write_skill(self, dirname: str, name: str) -> Path:
        skill_dir = self.root / dirname
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(VALID_SKILL.format(name=name), encoding="utf-8")
        return skill_dir

    def test_scan_valid_root(self) -> None:
        self.write_skill("one-skill", "one-skill")
        records, failures, skipped = validate_all_skills.scan_roots([self.root])
        self.assertEqual(len(records), 1)
        self.assertEqual(failures, [])
        self.assertEqual(skipped, [])

    def test_duplicate_names_are_failures(self) -> None:
        self.write_skill("first-skill", "same-name")
        self.write_skill("second-skill", "same-name")
        records, failures, skipped = validate_all_skills.scan_roots([self.root])
        failures.extend(validate_all_skills.duplicate_name_failures(records))
        self.assertEqual(len(skipped), 0)
        self.assertEqual(len(failures), 1)
        self.assertIn("duplicate skill name", failures[0].message)

    def test_broken_symlink_is_failure(self) -> None:
        (self.root / "broken-skill").symlink_to(self.root / "missing-skill")
        records, failures, skipped = validate_all_skills.scan_roots([self.root])
        self.assertEqual(records, [])
        self.assertEqual(skipped, [])
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].message, "broken symlink")

    def test_hidden_entries_are_ignored(self) -> None:
        hidden = self.root / ".bak"
        hidden.mkdir()
        records, failures, skipped = validate_all_skills.scan_roots([self.root])
        self.assertEqual(records, [])
        self.assertEqual(failures, [])
        self.assertEqual(skipped, [])


if __name__ == "__main__":
    unittest.main()
