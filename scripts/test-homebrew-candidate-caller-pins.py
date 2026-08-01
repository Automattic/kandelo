#!/usr/bin/env python3
"""Regression tests for candidate caller rendering and pins."""

from __future__ import annotations

import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts/homebrew-candidate-caller-pins.py"
TEMPLATE = ROOT / "homebrew/homebrew-tap-core"


class CallerPinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.base = "a" * 40
        self.merge = "b" * 40
        self.output = self.root / "rendered"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def render(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(TOOL),
                "render",
                "--template-root",
                str(TEMPLATE),
                "--base-sha",
                self.base,
                "--merge-sha",
                self.merge,
                "--out",
                str(self.output),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def validate(self, mode: str, sha: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(TOOL),
                "validate",
                "--tap-root",
                str(self.output),
                "--mode",
                mode,
                "--kandelo-sha",
                sha,
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def test_rendered_callers_pin_base_and_merge_exactly(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        for mode, sha in (
            ("campaign", self.base),
            ("bottle", self.base),
            ("promotion", self.merge),
        ):
            validated = self.validate(mode, sha)
            self.assertEqual(validated.returncode, 0, validated.stderr)

    def test_wrong_expected_commit_is_rejected(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        rejected = self.validate("bottle", self.merge)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("must pin exactly", rejected.stderr)

    def test_unrendered_template_is_not_deployable(self) -> None:
        self.output = TEMPLATE
        rejected = self.validate("campaign", self.base)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("must pin exactly", rejected.stderr)

    def test_mutable_ref_is_rejected_even_with_the_exact_pin(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        caller = self.output / ".github/workflows/candidate-bottles.yml"
        caller.write_text(caller.read_text() + "# forbidden @main ref\n")
        rejected = self.validate("bottle", self.base)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("mutable or unresolved", rejected.stderr)

    def test_extra_reusable_workflow_call_is_rejected(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        caller = self.output / ".github/workflows/candidate-bottles.yml"
        caller.write_text(
            caller.read_text()
            + "  uses: Automattic/kandelo/.github/workflows/extra.yml@"
            + self.base
            + "\n"
        )
        rejected = self.validate("bottle", self.base)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("must pin exactly", rejected.stderr)

    def test_render_requires_exact_lowercase_commit_shas(self) -> None:
        self.base = "A" * 40
        rejected = self.render()
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("exact lowercase commit SHA", rejected.stderr)

    def test_render_does_not_replace_an_existing_output(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        rejected = self.render()
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("already exists", rejected.stderr)

    def test_validate_rejects_a_symlinked_caller(self) -> None:
        result = self.render()
        self.assertEqual(result.returncode, 0, result.stderr)
        caller = self.output / ".github/workflows/candidate-campaign.yml"
        target = self.root / "caller.yml"
        caller.rename(target)
        caller.symlink_to(target)
        rejected = self.validate("campaign", self.base)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("must be a regular file", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
