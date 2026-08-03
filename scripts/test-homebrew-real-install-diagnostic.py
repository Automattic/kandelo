#!/usr/bin/env python3

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/homebrew-real-install-diagnostic.py"
SPEC = importlib.util.spec_from_file_location(
    "homebrew_real_install_diagnostic", SCRIPT
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load diagnostic validator")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DiagnosticContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contract_path = ROOT / "homebrew/real-install-diagnostic.json"
        self.contract = json.loads(self.contract_path.read_text())

    def test_static_contract_is_explicitly_smaller_than_product(self) -> None:
        report = MODULE.check_static(self.contract_path)
        self.assertEqual(report["selection_formula_count"], 25)
        self.assertEqual(report["vfs_formula_count"], 24)
        self.assertFalse(report["product_lock_used"])
        self.assertEqual(
            set(self.contract["selection"]["formula_order"])
            - set(self.contract["vfs"]["formula_order"]),
            {"homebrew-bootstrap"},
        )

    def test_contract_cannot_claim_product_status(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["diagnostic_only"] = False
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "explicitly diagnostic-only"
        ):
            self.read_changed_contract(changed)

    def test_contract_roots_must_derive_every_formula(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["selection"]["roots"].remove("bzip2")
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "do not derive the exact Formula closure"
        ):
            self.read_changed_contract(changed)

    def test_contract_order_must_follow_dependencies(self) -> None:
        changed = copy.deepcopy(self.contract)
        order = changed["selection"]["formula_order"]
        order.remove("libcxx")
        order.insert(order.index("ncurses") + 1, "libcxx")
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "not dependency-first at ncurses"
        ):
            self.read_changed_contract(changed)

    def test_compatibility_package_must_stay_in_vfs(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["compatibility"]["aliases"][0]["package"] = (
            "kandelo-dev/tap-core/not-selected"
        )
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "outside its VFS"
        ):
            self.read_changed_contract(changed)

    def test_lifecycle_requires_the_unique_keg_only_canary(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["lifecycle"]["independent_formula"] = (
            "brandonpayton/kandelo-canary/m4"
        )
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "shared guest proof"
        ):
            self.read_changed_contract(changed)

    def test_lifecycle_accepts_an_exact_canary_release_revision(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["lifecycle"]["independent_revision"] = "a" * 40
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "contract.json"
            path.write_text(json.dumps(changed) + "\n")
            parsed, _payload = MODULE.read_contract(path)
        self.assertEqual(
            parsed["lifecycle"]["independent_revision"], "a" * 40
        )

    def test_lifecycle_rejects_a_mutable_canary_revision(self) -> None:
        changed = copy.deepcopy(self.contract)
        changed["lifecycle"]["independent_revision"] = "main"
        with self.assertRaisesRegex(
            MODULE.DiagnosticError, "shared guest proof"
        ):
            self.read_changed_contract(changed)

    def test_independent_tap_requires_exact_formula_and_bottle_metadata(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            contract, tap = self.write_independent_tap(
                pathlib.Path(temporary)
            )
            report = MODULE.verify_independent_tap(contract, tap)
        self.assertEqual(
            report["kind"],
            "kandelo-homebrew-real-install-independent-tap-check",
        )
        self.assertEqual(
            report["formula"],
            "brandonpayton/kandelo-canary/m4-canary",
        )
        self.assertEqual(report["bottle_sha256"], "3" * 64)

    def test_independent_tap_rejects_missing_generated_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            contract, tap = self.write_independent_tap(root)
            (tap / "Kandelo/formula/m4-canary.json").unlink()
            self.git(tap, "add", "Kandelo/formula/m4-canary.json")
            self.git(tap, "commit", "-m", "remove generated metadata")
            changed = json.loads(contract.read_text())
            changed["lifecycle"]["independent_revision"] = self.git(
                tap, "rev-parse", "HEAD"
            )
            contract.write_text(json.dumps(changed) + "\n")
            with self.assertRaisesRegex(
                MODULE.DiagnosticError,
                "cannot read independent Formula metadata",
            ):
                MODULE.verify_independent_tap(contract, tap)

    def test_exact_anonymous_selection_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, receipt, authorization = self.write_selection(
                pathlib.Path(temporary)
            )
            report = MODULE.verify_selection(
                self.contract_path, root, receipt, authorization
            )
        self.assertEqual(
            report["kind"],
            "kandelo-homebrew-real-install-diagnostic-selection-check",
        )
        self.assertEqual(
            report["source_tap_commit"],
            self.contract["authority"]["source_tap_commit"],
        )
        self.assertEqual(len(report["formulae"]), 25)
        self.assertEqual(
            report["selection_release"]["visibility"],
            "public-anonymous-readback",
        )
        self.assertFalse(report["product_lock_used"])

    def test_selection_rejects_dependency_drift(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, receipt, authorization = self.write_selection(
                pathlib.Path(temporary)
            )
            metadata_path = root / "tap/Kandelo/metadata.json"
            metadata = json.loads(metadata_path.read_text())
            package = next(
                item for item in metadata["packages"]
                if item["name"] == "ruby"
            )
            package["dependencies"] = []
            metadata_path.write_text(json.dumps(metadata) + "\n")
            tree_oid = MODULE.campaign_executor().filesystem_git_tree_oid(
                root / "tap", "dependency-drift selected tap"
            )
            self.refresh_selection_authorization(
                root, receipt, authorization, tree_oid
            )
            with self.assertRaisesRegex(
                MODULE.DiagnosticError, "dependencies changed for ruby"
            ):
                MODULE.verify_selection(
                    self.contract_path, root, receipt, authorization
                )

    def test_selection_rejects_duplicate_metadata_package(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, receipt, authorization = self.write_selection(
                pathlib.Path(temporary)
            )
            metadata_path = root / "tap/Kandelo/metadata.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["packages"].append(
                copy.deepcopy(metadata["packages"][0])
            )
            metadata_path.write_text(json.dumps(metadata) + "\n")
            tree_oid = MODULE.campaign_executor().filesystem_git_tree_oid(
                root / "tap", "duplicate-package selected tap"
            )
            self.refresh_selection_authorization(
                root, receipt, authorization, tree_oid
            )
            with self.assertRaisesRegex(
                MODULE.DiagnosticError,
                "metadata differs from the 25-Formula closure",
            ):
                MODULE.verify_selection(
                    self.contract_path, root, receipt, authorization
                )

    def test_selection_rejects_fabricated_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, receipt, authorization = self.write_selection(
                pathlib.Path(temporary)
            )
            value = json.loads(authorization.read_text())
            value["readback"]["release_id"] += 1
            authorization.write_text(json.dumps(value) + "\n")
            with self.assertRaisesRegex(
                MODULE.DiagnosticError, "generic readback verification"
            ):
                MODULE.verify_selection(
                    self.contract_path, root, receipt, authorization
                )

    def read_changed_contract(self, value: dict[str, object]) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "contract.json"
            path.write_text(json.dumps(value) + "\n")
            MODULE.read_contract(path)

    def write_independent_tap(
        self,
        temporary: pathlib.Path,
    ) -> tuple[pathlib.Path, pathlib.Path]:
        tap = temporary / "independent-tap"
        (tap / "Formula").mkdir(parents=True)
        (tap / "Kandelo/formula").mkdir(parents=True)
        self.git(tap, "init", "-q")
        self.git(tap, "config", "user.name", "Diagnostic Test")
        self.git(tap, "config", "user.email", "test@kandelo.invalid")
        formula = tap / "Formula/m4-canary.rb"
        formula.write_text(
            "class M4Canary < Formula\n"
            "  keg_only \"it is an independent canary\"\n"
            "  depends_on \"kandelo-dev/tap-core/dash\"\n"
            "end\n"
        )
        self.git(tap, "add", "Formula/m4-canary.rb")
        self.git(tap, "commit", "-m", "add independent Formula")
        source_commit = self.git(tap, "rev-parse", "HEAD")

        formula.write_text(
            "class M4Canary < Formula\n"
            "  keg_only \"it is an independent canary\"\n"
            "  depends_on \"kandelo-dev/tap-core/dash\"\n"
            "\n"
            "  bottle do\n"
            "    root_url \"https://ghcr.io/v2/"
            "brandonpayton/homebrew-kandelo-canary\"\n"
            "    sha256 cellar: :any_skip_relocation, "
            f"wasm32_kandelo: \"{'3' * 64}\"\n"
            "  end\n"
            "end\n"
        )
        metadata = {
            "bottle_rebuild": 0,
            "bottles": [
                {
                    "arch": "wasm32",
                    "bottle_tag": "wasm32_kandelo",
                    "browser_compatible": False,
                    "built_at": "2026-08-03T00:00:00Z",
                    "built_by": "https://github.com/example/actions/runs/1",
                    "built_from": {
                        "formula_sha256": "4" * 64,
                        "kandelo_commit": self.contract["authority"][
                            "kandelo_commit"
                        ],
                        "kandelo_repository": "Automattic/kandelo",
                        "tap_commit": source_commit,
                        "tap_repository": (
                            "brandonpayton/homebrew-kandelo-canary"
                        ),
                    },
                    "bytes": 123,
                    "cache_key_sha": "3" * 64,
                    "cellar": "/opt/kandelo/homebrew/Cellar",
                    "fork_instrumentation": "not-required",
                    "kandelo_abi": 42,
                    "link_manifest": (
                        "Kandelo/link/m4-canary-1.4.21-wasm32.json"
                    ),
                    "prefix": "/opt/kandelo/homebrew",
                    "runtime_support": ["node"],
                    "sha256": "3" * 64,
                    "status": "success",
                    "url": (
                        "https://ghcr.io/v2/brandonpayton/"
                        "homebrew-kandelo-canary/m4-canary/blobs/sha256:"
                        + "3" * 64
                    ),
                }
            ],
            "dependencies": [
                {
                    "full_name": "kandelo-dev/tap-core/dash",
                    "name": "dash",
                    "version": "0.5.12",
                }
            ],
            "formula_path": "Formula/m4-canary.rb",
            "formula_revision": 0,
            "full_name": "brandonpayton/kandelo-canary/m4-canary",
            "kandelo_abi": 42,
            "name": "m4-canary",
            "schema": 1,
            "source_metadata": "Kandelo/metadata.json",
            "tap_commit": source_commit,
            "tap_name": "brandonpayton/kandelo-canary",
            "tap_repository": "brandonpayton/homebrew-kandelo-canary",
            "version": "1.4.21",
        }
        (tap / "Kandelo/formula/m4-canary.json").write_text(
            json.dumps(metadata) + "\n"
        )
        self.git(tap, "add", "Formula/m4-canary.rb", "Kandelo/formula")
        self.git(tap, "commit", "-m", "publish independent bottle")
        revision = self.git(tap, "rev-parse", "HEAD")
        contract_value = copy.deepcopy(self.contract)
        contract_value["lifecycle"]["independent_revision"] = revision
        contract = temporary / "contract.json"
        contract.write_text(json.dumps(contract_value) + "\n")
        return contract, tap

    def git(self, root: pathlib.Path, *arguments: str) -> str:
        return subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        ).stdout.strip()

    def write_selection(
        self, temporary: pathlib.Path
    ) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path]:
        executor = MODULE.campaign_executor()
        root = temporary / "selection"
        (root / "tap/Kandelo").mkdir(parents=True)
        authority = self.contract["authority"]
        selection_contract = self.contract["selection"]
        packages = []
        formulae = []
        for name in selection_contract["formula_order"]:
            archive_sha = hashlib.sha256(
                f"archive:{name}".encode()
            ).hexdigest()
            archive_bytes = 100 + len(name)
            handoff_sha = hashlib.sha256(
                f"handoff:{name}".encode()
            ).hexdigest()
            packages.append(
                {
                    "name": name,
                    "version": "1.0",
                    "bottles": [
                        {
                            "arch": authority["arch"],
                            "sha256": archive_sha,
                            "bytes": archive_bytes,
                        }
                    ],
                    "dependencies": [
                        {
                            "full_name": (
                                f"{authority['tap_name']}/{dependency}"
                            )
                        }
                        for dependency in selection_contract["dependencies"][
                            name
                        ]
                    ],
                }
            )
            formulae.append(
                {
                    "formula": name,
                    "version": "1.0",
                    "archive": {
                        "sha256": archive_sha,
                        "bytes": archive_bytes,
                    },
                    "handoff": {
                        "manifest_sha256": handoff_sha,
                        "tag": (
                            "homebrew-prefix-handoff-sha256-" + handoff_sha
                        ),
                    },
                }
            )
        metadata = {
            "tap_repository": authority["tap_repository"],
            "tap_name": authority["tap_name"],
            "tap_commit": authority["source_tap_commit"],
            "kandelo_commit": authority["kandelo_commit"],
            "kandelo_abi": authority["kandelo_abi"],
            "packages": packages,
        }
        (root / "tap/Kandelo/metadata.json").write_text(
            json.dumps(metadata) + "\n"
        )
        tree_oid = executor.filesystem_git_tree_oid(
            root / "tap", "test selected tap"
        )
        selection = {
            "schema": 1,
            "kind": "kandelo-homebrew-closed-selection-candidate",
            "arch": authority["arch"],
            "kandelo_abi": authority["kandelo_abi"],
            "roots": selection_contract["roots"],
            "formulae": formulae,
            "tap": {
                "repository": authority["tap_repository"],
                "name": authority["tap_name"],
                "path": "tap",
                "source_commit": authority["source_tap_commit"],
                "source_tree_git_oid": "b" * 40,
                "prepared_tree_git_oid": tree_oid,
            },
            "campaign": {
                "sha256": authority["campaign_sha256"],
                "tag": (
                    "homebrew-prefix-campaign-sha256-"
                    + authority["campaign_sha256"]
                ),
                "guest_layout_sha256": "a" * 64,
                "kandelo_commit": authority["kandelo_commit"],
            },
        }
        selection_payload = executor.pretty_json(selection)
        (root / "selection.json").write_bytes(selection_payload)

        descriptor_sha = "c" * 64
        receipt = temporary / "receipt.json"
        receipt.write_bytes(
            executor.pretty_json(
                {
                    "schema": 1,
                    "kind": "kandelo-homebrew-closed-selection-readback",
                    "arch": authority["arch"],
                    "assets": {
                        "closed-selection.json": {
                            "bytes": 1000,
                            "sha256": descriptor_sha,
                        },
                        "closed-selection.zip": {
                            "bytes": 2000,
                            "sha256": "d" * 64,
                        },
                    },
                    "formula_count": 25,
                    "prepared_tree_git_oid": tree_oid,
                    "release_id": 123,
                    "repository": authority["tap_repository"],
                    "roots": selection_contract["roots"],
                    "selection_manifest_sha256": hashlib.sha256(
                        selection_payload
                    ).hexdigest(),
                    "tag": (
                        "homebrew-prefix-selection-sha256-" + descriptor_sha
                    ),
                    "target_commitish": authority["source_tap_commit"],
                    "visibility": "public-anonymous-readback",
                }
            )
        )
        authorization = temporary / "authorization.json"
        executor.verify_selection_readback(
            selection_root=root,
            receipt_path=receipt,
            output=authorization,
        )
        return root, receipt, authorization

    def refresh_selection_authorization(
        self,
        root: pathlib.Path,
        receipt: pathlib.Path,
        authorization: pathlib.Path,
        tree_oid: str,
    ) -> None:
        executor = MODULE.campaign_executor()
        selection_path = root / "selection.json"
        selection = json.loads(selection_path.read_text())
        selection["tap"]["prepared_tree_git_oid"] = tree_oid
        selection_payload = executor.pretty_json(selection)
        selection_path.write_bytes(selection_payload)
        receipt_value = json.loads(receipt.read_text())
        receipt_value["prepared_tree_git_oid"] = tree_oid
        receipt_value["selection_manifest_sha256"] = hashlib.sha256(
            selection_payload
        ).hexdigest()
        receipt.write_bytes(executor.pretty_json(receipt_value))
        authorization.unlink()
        executor.verify_selection_readback(
            selection_root=root,
            receipt_path=receipt,
            output=authorization,
        )


if __name__ == "__main__":
    unittest.main()
