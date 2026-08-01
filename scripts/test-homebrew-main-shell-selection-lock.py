#!/usr/bin/env python3
"""Adversarial tests for the main-shell closed-selection lock."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_module(name: str, path: pathlib.Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


LOCK = load_module(
    "homebrew_main_shell_selection_lock_tested",
    ROOT / "scripts/homebrew-main-shell-selection-lock.py",
)
EXECUTOR = load_module(
    "homebrew_prefix_campaign_executor_for_lock_tests",
    ROOT / "scripts/homebrew-prefix-campaign-executor.py",
)


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(LOCK.pretty_json(value))


class Fixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="homebrew-main-shell-selection-lock-test-"
        )
        self.root = pathlib.Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        (self.root / "crates/shared/src").mkdir(parents=True)
        (self.root / "homebrew").mkdir()
        (self.root / "scripts/homebrew-brewfile-selection.rb").write_text(
            "require 'json'\n"
            "puts JSON.generate({schema: 1, "
            "kind: 'kandelo-static-brewfile-v1', "
            "packages: ['alpha']})\n"
        )
        (self.root / "crates/shared/src/lib.rs").write_text(
            "pub const ABI_VERSION: u32 = 42;\n"
        )
        (self.root / "homebrew/main-shell.Brewfile").write_text(
            'tap "kandelo-dev/tap-core"\n'
            'brew "kandelo-dev/tap-core/alpha"\n'
        )
        self.source_commit = "b" * 40
        write_json(
            self.root / "homebrew/kandelo-guest-layout.json",
            {
                "kind": "kandelo-homebrew-guest-layout",
                "prefix": "/opt/kandelo/homebrew",
                "schema": 1,
            },
        )
        write_json(
            self.root / "homebrew/main-shell-migration-lock.json",
            {
                "catalog": {"tap_commit": self.source_commit},
                "formula_closure": ["kandelo-dev/tap-core/alpha"],
                "tap_name": "kandelo-dev/tap-core",
                "tap_repository": "kandelo-dev/homebrew-tap-core",
            },
        )
        write_json(
            self.root
            / "homebrew/main-shell-homebrew-runtime-support.json",
            {
                "activation": {
                    "bootstrap_package": {"name": "gamma"}
                },
                "additional_formula_order": [
                    "kandelo-dev/tap-core/beta"
                ],
                "catalog": {
                    "tap_commit": self.source_commit,
                    "tap_name": "kandelo-dev/tap-core",
                    "tap_repository": (
                        "kandelo-dev/homebrew-tap-core"
                    ),
                },
                "formula_roots": [
                    {"package": "kandelo-dev/tap-core/beta"}
                ],
            },
        )
        self.pending = LOCK.create_pending(self.root)
        self.selection = self.root / "selection"
        tap = self.selection / "tap"
        (tap / "Formula").mkdir(parents=True)
        (tap / "Kandelo").mkdir()
        for name in ("alpha", "beta", "gamma"):
            (tap / f"Formula/{name}.rb").write_text(
                f"class {name.title()} < Formula\nend\n"
            )
        formulae = [
            {
                "archive": {"bytes": 1, "sha256": "d" * 64},
                "formula": name,
                "handoff": {
                    "manifest_sha256": (
                        f"{position:x}" * 64
                    )[:64],
                    "tag": (
                        "homebrew-prefix-handoff-sha256-"
                        + (f"{position:x}" * 64)[:64]
                    ),
                },
                "version": "1.0",
            }
            for position, name in enumerate(
                ("alpha", "beta", "gamma"), start=1
            )
        ]
        write_json(
            tap / "Kandelo/metadata.json",
            {
                "kandelo_abi": 42,
                "kandelo_commit": "a" * 40,
                "packages": [
                    {
                        "bottles": [
                            {
                                "arch": "wasm32",
                                "bytes": record["archive"]["bytes"],
                                "kandelo_abi": 42,
                                "sha256": record["archive"]["sha256"],
                                "status": "success",
                            }
                        ],
                        "dependencies": [],
                        "full_name": (
                            "kandelo-dev/tap-core/"
                            f"{record['formula']}"
                        ),
                        "name": record["formula"],
                        "version": record["version"],
                    }
                    for record in formulae
                ],
                "schema": 1,
                "tap_commit": self.source_commit,
                "tap_name": "kandelo-dev/tap-core",
                "tap_repository": "kandelo-dev/homebrew-tap-core",
            },
        )
        tree = EXECUTOR.filesystem_git_tree_oid(tap, "fixture tap")
        selection_value = {
            "arch": "wasm32",
            "campaign": {
                "guest_layout_sha256": self.pending["inputs"][
                    "guest_layout"
                ]["sha256"],
                "kandelo_commit": "a" * 40,
                "sha256": "c" * 64,
                "tag": f"homebrew-prefix-campaign-sha256-{'c' * 64}",
            },
            "formulae": formulae,
            "kandelo_abi": 42,
            "kind": "kandelo-homebrew-closed-selection-candidate",
            "roots": ["alpha", "beta", "gamma"],
            "schema": 1,
            "tap": {
                "name": "kandelo-dev/tap-core",
                "path": "tap",
                "prepared_tree_git_oid": tree,
                "repository": "kandelo-dev/homebrew-tap-core",
                "source_commit": self.source_commit,
                "source_tree_git_oid": "e" * 40,
            },
        }
        write_json(self.selection / "selection.json", selection_value)

    def close(self) -> None:
        self.temporary.cleanup()

    def loaded_inputs(self) -> dict[str, tuple[dict[str, Any], bytes]]:
        _lock, loaded = LOCK.validate_lock(self.pending, self.root)
        return loaded


class MainShellSelectionLockTests(unittest.TestCase):
    def test_rejects_substituted_bottle_and_unrelated_formula(self) -> None:
        bottle_fixture = Fixture()
        self.addCleanup(bottle_fixture.close)
        loaded = bottle_fixture.loaded_inputs()
        metadata_path = (
            bottle_fixture.selection / "tap/Kandelo/metadata.json"
        )
        metadata = json.loads(metadata_path.read_text())
        metadata["packages"][0]["bottles"][0]["sha256"] = "f" * 64
        write_json(metadata_path, metadata)
        selection_path = bottle_fixture.selection / "selection.json"
        selection = json.loads(selection_path.read_text())
        selection["tap"]["prepared_tree_git_oid"] = (
            EXECUTOR.filesystem_git_tree_oid(
                bottle_fixture.selection / "tap", "substituted bottle tap"
            )
        )
        write_json(selection_path, selection)
        with self.assertRaisesRegex(
            LOCK.LockError, "bottle provenance differs for alpha"
        ):
            LOCK.verify_selection(
                root=bottle_fixture.root,
                lock=bottle_fixture.pending,
                inputs=loaded,
                selection_root=bottle_fixture.selection,
                receipt=None,
                allow_pending=True,
            )

        extra_fixture = Fixture()
        self.addCleanup(extra_fixture.close)
        extra_loaded = extra_fixture.loaded_inputs()
        extra_tap = extra_fixture.selection / "tap"
        (extra_tap / "Formula/delta.rb").write_text(
            "class Delta < Formula\nend\n"
        )
        extra_metadata_path = extra_tap / "Kandelo/metadata.json"
        extra_metadata = json.loads(extra_metadata_path.read_text())
        extra_metadata["packages"].append(
            {
                "bottles": [
                    {
                        "arch": "wasm32",
                        "bytes": 1,
                        "kandelo_abi": 42,
                        "sha256": "9" * 64,
                        "status": "success",
                    }
                ],
                "dependencies": [],
                "full_name": "kandelo-dev/tap-core/delta",
                "name": "delta",
                "version": "1.0",
            }
        )
        write_json(extra_metadata_path, extra_metadata)
        extra_selection_path = extra_fixture.selection / "selection.json"
        extra_selection = json.loads(extra_selection_path.read_text())
        extra_selection["formulae"].append(
            {
                "archive": {"bytes": 1, "sha256": "9" * 64},
                "formula": "delta",
                "handoff": {
                    "manifest_sha256": "8" * 64,
                    "tag": (
                        "homebrew-prefix-handoff-sha256-" + "8" * 64
                    ),
                },
                "version": "1.0",
            }
        )
        extra_selection["tap"]["prepared_tree_git_oid"] = (
            EXECUTOR.filesystem_git_tree_oid(
                extra_tap, "unrelated Formula tap"
            )
        )
        write_json(extra_selection_path, extra_selection)
        with self.assertRaisesRegex(
            LOCK.LockError, "not the exact dependency closure"
        ):
            LOCK.verify_selection(
                root=extra_fixture.root,
                lock=extra_fixture.pending,
                inputs=extra_loaded,
                selection_root=extra_fixture.selection,
                receipt=None,
                allow_pending=True,
            )

        dependency_fixture = Fixture()
        self.addCleanup(dependency_fixture.close)
        dependency_loaded = dependency_fixture.loaded_inputs()
        dependency_tap = dependency_fixture.selection / "tap"
        (dependency_tap / "Formula/delta.rb").write_text(
            "class Delta < Formula\nend\n"
        )
        dependency_metadata_path = dependency_tap / "Kandelo/metadata.json"
        dependency_metadata = json.loads(
            dependency_metadata_path.read_text()
        )
        dependency_metadata["packages"][2]["dependencies"] = [
            {
                "full_name": "kandelo-dev/tap-core/delta",
                "name": "delta",
            }
        ]
        dependency_metadata["packages"].append(
            {
                "bottles": [
                    {
                        "arch": "wasm32",
                        "bytes": 1,
                        "kandelo_abi": 42,
                        "sha256": "9" * 64,
                        "status": "success",
                    }
                ],
                "dependencies": [],
                "full_name": "kandelo-dev/tap-core/delta",
                "name": "delta",
                "version": "1.0",
            }
        )
        write_json(dependency_metadata_path, dependency_metadata)
        dependency_selection_path = (
            dependency_fixture.selection / "selection.json"
        )
        dependency_selection = json.loads(
            dependency_selection_path.read_text()
        )
        dependency_selection["formulae"].insert(
            2,
            {
                "archive": {"bytes": 1, "sha256": "9" * 64},
                "formula": "delta",
                "handoff": {
                    "manifest_sha256": "8" * 64,
                    "tag": (
                        "homebrew-prefix-handoff-sha256-" + "8" * 64
                    ),
                },
                "version": "1.0",
            },
        )
        dependency_selection["tap"]["prepared_tree_git_oid"] = (
            EXECUTOR.filesystem_git_tree_oid(
                dependency_tap, "dependency-only Formula tap"
            )
        )
        write_json(dependency_selection_path, dependency_selection)
        dependency_report = LOCK.verify_selection(
            root=dependency_fixture.root,
            lock=dependency_fixture.pending,
            inputs=dependency_loaded,
            selection_root=dependency_fixture.selection,
            receipt=None,
            allow_pending=True,
        )
        self.assertEqual(dependency_report["formula_count"], 4)

    def test_pending_requires_review_and_sealed_binds_public_readback(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        loaded = fixture.loaded_inputs()
        with self.assertRaisesRegex(
            LOCK.LockError, "not a publishable shell input"
        ):
            LOCK.verify_selection(
                root=fixture.root,
                lock=fixture.pending,
                inputs=loaded,
                selection_root=fixture.selection,
                receipt=None,
                allow_pending=False,
            )
        report = LOCK.verify_selection(
            root=fixture.root,
            lock=fixture.pending,
            inputs=loaded,
            selection_root=fixture.selection,
            receipt=None,
            allow_pending=True,
        )
        self.assertEqual(report["formula_count"], 3)

        prepared = fixture.root / "prepared-release"
        EXECUTOR.prepare_selection_release(
            selection_root=fixture.selection, output=prepared
        )
        manifest = json.loads(
            (prepared / "release-manifest.json").read_text()
        )
        assets = {
            record["name"]: {
                "bytes": record["bytes"],
                "sha256": record["sha256"],
            }
            for record in manifest["assets"]
        }
        selection_payload = (
            fixture.selection / "selection.json"
        ).read_bytes()
        receipt = LOCK.validate_receipt(
            {
                "arch": "wasm32",
                "assets": assets,
                "formula_count": 3,
                "kind": "kandelo-homebrew-closed-selection-readback",
                "prepared_tree_git_oid": report[
                    "prepared_tree_git_oid"
                ],
                "release_id": 7,
                "repository": "kandelo-dev/homebrew-tap-core",
                "roots": report["roots"],
                "schema": 1,
                "selection_manifest_sha256": LOCK.sha256_bytes(
                    selection_payload
                ),
                "tag": manifest["tag"],
                "target_commitish": fixture.source_commit,
                "visibility": "public-anonymous-readback",
            }
        )
        sealed = dict(fixture.pending)
        sealed["state"] = "sealed"
        sealed["release"] = LOCK.release_from_receipt(receipt)
        sealed, sealed_inputs = LOCK.validate_lock(sealed, fixture.root)
        verified = LOCK.verify_selection(
            root=fixture.root,
            lock=sealed,
            inputs=sealed_inputs,
            selection_root=fixture.selection,
            receipt=receipt,
            allow_pending=False,
        )
        self.assertEqual(verified["state"], "sealed")

        substituted = json.loads(json.dumps(receipt))
        substituted["prepared_tree_git_oid"] = "f" * 40
        with self.assertRaisesRegex(
            LOCK.LockError, "differs from its sealed lock"
        ):
            LOCK.verify_selection(
                root=fixture.root,
                lock=sealed,
                inputs=sealed_inputs,
                selection_root=fixture.selection,
                receipt=substituted,
                allow_pending=False,
            )

    def test_lock_derives_roots_and_rejects_input_or_formula_omission(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        _lock, loaded = LOCK.validate_lock(fixture.pending, fixture.root)
        roots, required, _tap, _abi, _commit = (
            LOCK.derive_roots_and_required_formulae(fixture.root, loaded)
        )
        self.assertEqual(roots, ["alpha", "beta", "gamma"])
        self.assertEqual(required, {"alpha", "beta", "gamma"})

        selection_path = fixture.selection / "selection.json"
        selection = json.loads(selection_path.read_text())
        selection["formulae"] = selection["formulae"][:-1]
        write_json(selection_path, selection)
        with self.assertRaisesRegex(
            LOCK.LockError,
            "roots are outside|omits required main-shell Formulae",
        ):
            LOCK.verify_selection(
                root=fixture.root,
                lock=fixture.pending,
                inputs=loaded,
                selection_root=fixture.selection,
                receipt=None,
                allow_pending=True,
            )

        migration = fixture.root / "homebrew/main-shell-migration-lock.json"
        migration.write_bytes(migration.read_bytes() + b"\n")
        with self.assertRaisesRegex(
            LOCK.LockError, "differs from its lock"
        ):
            LOCK.validate_lock(fixture.pending, fixture.root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
