#!/usr/bin/env python3
"""Regression tests for quick_validate.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import quick_validate
import render_skill_template


VALID_SKILL = """---
name: demo-skill
description: |
  Use when: validating a small demo skill.
---

# demo-skill

Use this skill when validating the validator.

## Flow

1) Read the input.
2) Check it.

## Verification

- Run the validator.
"""


class QuickValidateTests(unittest.TestCase):
    def write_skill(self, text: str) -> Path:
        root = Path(self.tmp.name) / "demo-skill"
        root.mkdir(parents=True, exist_ok=True)
        (root / "SKILL.md").write_text(text, encoding="utf-8")
        return root

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_valid_minimal_skill(self) -> None:
        root = self.write_skill(VALID_SKILL)
        fm = quick_validate.validate_skill_dir(root)
        self.assertEqual(fm.name, "demo-skill")

    def test_optional_labels_may_be_present(self) -> None:
        text = VALID_SKILL.replace(
            "Use when: validating a small demo skill.",
            "Use when: validating a small demo skill.\n  Don’t use when: doing unrelated work.\n  Outputs: a validation result.",
        )
        root = self.write_skill(text)
        fm = quick_validate.validate_skill_dir(root)
        self.assertEqual(fm.name, "demo-skill")

    def test_duplicate_frontmatter_key_is_invalid(self) -> None:
        text = VALID_SKILL.replace("description: |", "name: duplicate\ndescription: |")
        root = self.write_skill(text)
        with self.assertRaises(quick_validate.SkillValidationError) as ctx:
            quick_validate.validate_skill_dir(root)
        self.assertIn("duplicate key", str(ctx.exception))
        self.assertIn("line:", str(ctx.exception))

    def test_empty_use_when_is_invalid(self) -> None:
        text = VALID_SKILL.replace("Use when: validating a small demo skill.", "Use when:")
        root = self.write_skill(text)
        with self.assertRaises(quick_validate.SkillValidationError) as ctx:
            quick_validate.validate_skill_dir(root)
        self.assertIn("non-empty `Use when:`", str(ctx.exception))

    def test_fill_me_marker_is_invalid_with_line_context(self) -> None:
        text = VALID_SKILL.replace("Run the validator.", "__FILL_ME__: write one concrete check")
        root = self.write_skill(text)
        with self.assertRaises(quick_validate.SkillValidationError) as ctx:
            quick_validate.validate_skill_dir(root)
        message = str(ctx.exception)
        self.assertIn("__FILL_ME__", message)
        self.assertIn("line:", message)
        self.assertIn("text:", message)

    def test_todo_and_ellipsis_are_allowed(self) -> None:
        text = VALID_SKILL.replace("Run the validator.", "Mention TODO and ellipsis ... as literal documentation text.")
        root = self.write_skill(text)
        fm = quick_validate.validate_skill_dir(root)
        self.assertEqual(fm.name, "demo-skill")

    def test_rendered_template_is_rejected_until_filled(self) -> None:
        template = Path(__file__).resolve().parents[1] / "templates" / "SKILL.md.template"
        root = Path(self.tmp.name) / "rendered-skill"
        output = root / "SKILL.md"
        render_skill_template.render_skill_template(template, output, "rendered-skill")
        with self.assertRaises(quick_validate.SkillValidationError) as ctx:
            quick_validate.validate_skill_dir(root)
        self.assertIn("__FILL_ME__", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
