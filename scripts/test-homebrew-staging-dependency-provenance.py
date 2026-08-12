#!/usr/bin/env python3
"""Focused tests for binding staged dependency layers to poured bottles."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = REPO_ROOT / "scripts/homebrew-dependency-provenance.py"
DIGEST = "a" * 64
OTHER_DIGEST = "b" * 64
TAP_REPOSITORY = "example/homebrew-tools"
TAP_NAME = "example/tools"
ABI = 8


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


def expected_layers() -> dict[str, object]:
    reference = (
        "ghcr.io/example/homebrew-tools-abi-8-candidates/mini-base@sha256:"
        + DIGEST
    )
    return {
        "architecture": "wasm32",
        "dependency_layers": [
            {
                "artifact": {
                    "bytes": 128,
                    "immutable_reference": reference,
                    "sha256": DIGEST,
                },
                "formula": "mini-base",
            }
        ],
        "kind": "kandelo-abi-staging-dependency-layers",
        "schema": 1,
        "tap_repository": TAP_REPOSITORY,
        "target_abi": ABI,
    }


def poured_provenance() -> dict[str, object]:
    root = "https://ghcr.io/v2/example/homebrew-tools-abi-8-candidates"
    return {
        "arch": "wasm32",
        "bottle_root_url": root,
        "bottle_tag": "wasm32_kandelo",
        "dependencies": [
            {
                "archive": {
                    "bytes": 128,
                    "cache_basename": "unused-by-staging-binding",
                    "sha256": DIGEST,
                },
                "bottle": {
                    "cellar": "any",
                    "rebuild": 0,
                    "sha256": DIGEST,
                    "tag": "wasm32_kandelo",
                    "url": f"{root}/mini-base/blobs/sha256:{DIGEST}",
                },
                "declared_directly": True,
                "formula": {"path": "Formula/mini-base.rb", "sha256": OTHER_DIGEST},
                "full_name": f"{TAP_NAME}/mini-base",
                "install_log": {"pour": ["Pouring mini-base"], "source_build_absent": True},
                "name": "mini-base",
                "receipt": {
                    "built_as_bottle": True,
                    "homebrew_version": "fixture",
                    "installed_on_request": False,
                    "path": "Cellar/mini-base/1.0/INSTALL_RECEIPT.json",
                    "poured_from_bottle": True,
                    "sha256": OTHER_DIGEST,
                    "source_tap": TAP_NAME,
                    "source_tap_git_head": "c" * 40,
                },
                "version": "1.0",
            }
        ],
        "formula": "mini-tool",
        "schema": 6,
        "tap_checkout_commit": "c" * 40,
        "tap_commit": "c" * 40,
        "tap_name": TAP_NAME,
        "tap_repository": TAP_REPOSITORY,
    }


class StagingDependencyProvenanceTests(unittest.TestCase):
    def run_validator(
        self, expected: dict[str, object], actual: dict[str, object]
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            expected_path = root / "expected.json"
            actual_path = root / "actual.json"
            write_json(expected_path, expected)
            write_json(actual_path, actual)
            return subprocess.run(
                [
                    "python3",
                    str(VALIDATOR),
                    "validate-staging",
                    "--expected",
                    str(expected_path),
                    "--actual",
                    str(actual_path),
                ],
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

    def test_accepts_exact_candidate_layers_proven_by_the_pour(self) -> None:
        result = self.run_validator(expected_layers(), poured_provenance())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_a_poured_layer_that_differs_from_the_protected_contract(self) -> None:
        actual = poured_provenance()
        actual["dependencies"][0]["archive"]["sha256"] = OTHER_DIGEST
        actual["dependencies"][0]["bottle"]["sha256"] = OTHER_DIGEST
        actual["dependencies"][0]["bottle"]["url"] = (
            "https://ghcr.io/v2/example/homebrew-tools-abi-8-candidates/"
            f"mini-base/blobs/sha256:{OTHER_DIGEST}"
        )
        result = self.run_validator(expected_layers(), actual)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("staged dependency layers differ", result.stderr)

    def test_rejects_a_mutable_or_wrong_candidate_reference(self) -> None:
        expected = expected_layers()
        expected["dependency_layers"][0]["artifact"]["immutable_reference"] = (
            "ghcr.io/example/homebrew-tools-abi-8-candidates/mini-base:latest"
        )
        result = self.run_validator(expected, poured_provenance())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("immutable reference", result.stderr)


if __name__ == "__main__":
    unittest.main()
