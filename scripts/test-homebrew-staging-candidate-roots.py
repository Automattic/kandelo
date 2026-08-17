#!/usr/bin/env python3
"""Focused generic candidate-root tests for real pour/provenance paths."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parent


def load(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CandidateRootTests(unittest.TestCase):
    def test_provenance_and_runtime_use_the_same_generic_candidate_base(self) -> None:
        provenance = load("candidate_provenance", "homebrew-dependency-provenance.py")
        runtime = load("candidate_runtime", "homebrew-bottle-runtime-evidence.py")
        for module in (provenance, runtime):
            with self.subTest(module=module.__name__):
                self.assertTrue(
                    hasattr(module, "selected_bottle_root_url"),
                    "candidate root selection is absent",
                )
                self.assertEqual(
                    module.selected_bottle_root_url(
                        "kandelo-dev/homebrew-tap-core", None
                    ),
                    "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
                )
                self.assertEqual(
                    module.selected_bottle_root_url(
                        "kandelo-dev/homebrew-tap-core", 8
                    ),
                    (
                        "https://ghcr.io/v2/kandelo-dev/"
                        "homebrew-tap-core-abi-8-candidates"
                    ),
                )
                with self.assertRaises(Exception):
                    module.selected_bottle_root_url(
                        "kandelo-dev/homebrew-tap-core", 0
                    )

    def test_runtime_accepts_per_formula_metadata_under_candidate_base(self) -> None:
        runtime = load("candidate_runtime_metadata", "homebrew-bottle-runtime-evidence.py")
        digest = "a" * 64
        candidate_base = (
            "https://ghcr.io/v2/example/homebrew-tools-abi-8-candidates"
        )
        document = {
            "mini-tool": {
                "bottle": {
                    "cellar": "any",
                    "rebuild": 0,
                    "root_url": f"{candidate_base}/mini-tool",
                    "tags": {"wasm32_kandelo": {"sha256": digest}},
                },
                "formula": {
                    "name": "mini-tool",
                    "path": "Formula/mini-tool.rb",
                    "pkg_version": "1.0",
                },
            }
        }
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bottle.json"
            path.write_text(json.dumps(document), encoding="utf-8")
            args = SimpleNamespace(
                arch="wasm32",
                bottle_json=str(path),
                bottle_root_url=candidate_base,
                bottle_sha256=digest,
                formula="mini-tool",
                staging_candidate_abi=8,
            )
            version, tag, rebuild, filename = runtime.canonical_bottle(args)
        self.assertEqual(
            (version, tag, rebuild, filename),
            ("1.0", "wasm32_kandelo", 0, "mini-tool--1.0.wasm32_kandelo.bottle.tar.gz"),
        )


if __name__ == "__main__":
    unittest.main()
