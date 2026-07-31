#!/usr/bin/env python3
"""Adversarial tests for prefix-campaign Formula handoffs."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import Any
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts/homebrew-prefix-campaign-executor.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "homebrew_prefix_campaign_executor", TOOL
)
assert SPEC is not None and SPEC.loader is not None
EXECUTOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EXECUTOR
SPEC.loader.exec_module(EXECUTOR)

TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"
KANDELO_COMMIT = "a" * 40
SOURCE_TAP_COMMIT = "b" * 40


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(EXECUTOR.pretty_json(value))


def formula_source(name: str) -> bytes:
    class_name = "".join(part.title() for part in name.split("-"))
    return (
        f"class {class_name} < Formula\n"
        '  desc "campaign executor fixture"\n'
        "end\n"
    ).encode()


def make_formula(
    name: str,
    version: str,
    dependencies: list[tuple[str, str]],
    arches: list[str],
) -> dict[str, Any]:
    payload = formula_source(name)
    return {
        "dependencies": [
            {
                "full_name": f"{TAP_NAME}/{dependency}",
                "version": dependency_version,
            }
            for dependency, dependency_version in dependencies
        ],
        "destination": {
            "bottle_rebuild": 1,
            "reference": f"{version}_1",
            "remote": f"ghcr.io/{TAP_REPOSITORY}/{name}",
        },
        "formula_source": {
            "identity_excluding_bottle_sha256": sha256(payload),
            "path": f"Formula/{name}.rb",
            "sha256": sha256(payload),
        },
        "name": name,
        "source_kind": "fixture",
        "variants": [
            {
                "arch": arch,
                "disposition": {
                    "kind": "required-rebuild",
                    "reasons": ["fixture"],
                },
                "selected_by": "fixture",
            }
            for arch in arches
        ],
        "version": version,
    }


class Fixture:
    def __init__(self, *, multi_arch: bool = False) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="homebrew-prefix-executor-test-"
        )
        self.root = pathlib.Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / "Formula").mkdir(parents=True)
        for name in ("alpha", "beta"):
            (self.source / f"Formula/{name}.rb").write_bytes(
                formula_source(name)
            )
        write_json(
            self.source
            / "Kandelo/reports/"
            "beta-2.0-rebuild1-wasm32.provenance.json",
            {"stale": True},
        )
        self.source_tree = EXECUTOR.filesystem_git_tree_oid(
            self.source, "fixture target source"
        )
        arches = ["wasm32", "wasm64"] if multi_arch else ["wasm32"]
        self.formulae = [
            make_formula("alpha", "1.0", [], arches),
            make_formula(
                "beta",
                "2.0",
                [("alpha", "1.0")],
                arches,
            ),
        ]
        self.campaign = {
            "authority": {
                "current_kandelo_abi": 42,
                "guest_layout": {
                    "path": "homebrew/kandelo-guest-layout.json",
                    "sha256": "c" * 64,
                },
                "kandelo_commit": KANDELO_COMMIT,
                "source_materialization": {
                    "kind": "exact-git-tree-v1",
                    "tree_git_oid": self.source_tree,
                },
                "source_tap_commit": SOURCE_TAP_COMMIT,
                "tap_name": TAP_NAME,
                "tap_repository": TAP_REPOSITORY,
            },
            "formulae": self.formulae,
            "kind": "kandelo-homebrew-guest-prefix-campaign",
            "schema": 1,
        }
        self.campaign_path = self.root / "campaign.json"
        write_json(self.campaign_path, self.campaign)

    def close(self) -> None:
        self.temporary.cleanup()

    def publication(
        self,
        formula: str,
        arch: str,
    ) -> pathlib.Path:
        output = self.root / f"publication-{formula}-{arch}"
        if output.exists():
            shutil.rmtree(output)
        package = next(
            item for item in self.formulae if item["name"] == formula
        )
        archive_payload = (
            f"{formula}/{arch} bottle bytes\n".encode()
        )
        archive_sha256 = sha256(archive_payload)
        for relative in EXECUTOR.PUBLICATION_FILES:
            path = output / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if relative == "composition/sidecars-input.json":
                dependencies = [
                    {
                        "full_name": value["full_name"],
                        "name": value["full_name"].rsplit("/", 1)[1],
                        "version": value["version"],
                    }
                    for value in package["dependencies"]
                ]
                write_json(
                    path,
                    {
                        "packages": [
                            {
                                "bottle_rebuild": package["destination"][
                                    "bottle_rebuild"
                                ],
                                "bottles": [{"arch": arch}],
                                "dependencies": dependencies,
                                "formula_source_sha256": package[
                                    "formula_source"
                                ]["sha256"],
                                "name": formula,
                                "version": package["version"],
                            }
                        ]
                    },
                )
            elif relative == "build/bottle.json":
                formula_key = f"{TAP_NAME}/{formula}"
                owner, tap = TAP_NAME.split("/", 1)
                write_json(
                    path,
                    {
                        formula_key: {
                            "bottle": {
                                "cellar": (
                                    "/opt/kandelo/homebrew/Cellar"
                                ),
                                "rebuild": package["destination"][
                                    "bottle_rebuild"
                                ],
                                "root_url": (
                                    "https://ghcr.io/v2/"
                                    f"{TAP_REPOSITORY}"
                                ),
                                "tags": {
                                    f"{arch}_kandelo": {
                                        "all_files": [
                                            f"bin/{formula}",
                                        ],
                                        "local_filename": (
                                            f"{formula}--"
                                            f"{package['version']}."
                                            f"{arch}_kandelo."
                                            "bottle.tar.gz"
                                        ),
                                        "path_exec_files": [
                                            f"bin/{formula}",
                                        ],
                                        "sha256": archive_sha256,
                                        "tab": {
                                            "runtime_dependencies": [],
                                        },
                                    }
                                },
                            },
                            "formula": {
                                "name": formula,
                                "path": (
                                    f"Library/Taps/{owner}/"
                                    f"homebrew-{tap}/Formula/"
                                    f"{formula}.rb"
                                ),
                                "pkg_version": package["version"],
                            },
                        }
                    },
                )
            elif relative == "build/bottle.tar.gz":
                path.write_bytes(archive_payload)
            elif relative.endswith(".json"):
                write_json(path, {"fixture": relative})
            else:
                path.write_bytes(archive_payload)
        return output

    @staticmethod
    def merge_dependency(
        *,
        tap_root: pathlib.Path,
        campaign: dict[str, Any],
        formula: str,
        arch: str,
        bottle_json: pathlib.Path,
        sha256: str,
        root_url: str,
        cellar: str,
    ) -> None:
        del campaign, root_url, cellar
        value = json.loads(bottle_json.read_text())
        if set(value) != {formula}:
            raise AssertionError("merge input was not canonicalized")
        formula_path = tap_root / f"Formula/{formula}.rb"
        with formula_path.open("ab") as output:
            output.write(
                f"# {arch} bottle {sha256}\n".encode()
            )

    @staticmethod
    def generate_sidecars(
        *,
        tap_root: pathlib.Path,
        input_path: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != "c" * 64:
            raise AssertionError("selection used the wrong guest layout")
        package = json.loads(input_path.read_text())["packages"][0]
        metadata_path = tap_root / "Kandelo/metadata.json"
        packages: list[dict[str, str]] = []
        if metadata_path.is_file():
            packages = json.loads(
                metadata_path.read_text()
            )["packages"]
        packages.append({"name": package["name"]})
        write_json(
            metadata_path,
            {"packages": packages, "schema": 1},
        )

    @staticmethod
    def validate_tap(
        *,
        tap_root: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != "c" * 64:
            raise AssertionError("selection used the wrong guest layout")
        if not (tap_root / "Kandelo/metadata.json").is_file():
            raise AssertionError("selection validation lacked metadata")

    def derive(
        self,
        formula: str,
        publications: list[tuple[str, pathlib.Path]],
        dependencies: list[pathlib.Path],
        output: pathlib.Path,
    ) -> None:
        EXECUTOR.derive_build(
            campaign_path=self.campaign_path,
            source_tap_root=self.source,
            formula_name=formula,
            publications=publications,
            dependency_roots=dependencies,
            output=output,
            validator=lambda *_arguments: None,
            dependency_merger=self.merge_dependency,
        )


def release_fetchers(
    prepared: pathlib.Path,
) -> tuple[Any, Any, dict[str, Any]]:
    manifest = json.loads(
        (prepared / "release-manifest.json").read_text()
    )
    assets = {
        value["name"]: value
        for value in manifest["assets"]
    }
    release = {
        "assets": [
            {
                "browser_download_url": (
                    f"https://github.com/{manifest['repository']}/"
                    f"releases/download/{manifest['tag']}/{name}"
                ),
                "digest": f"sha256:{value['sha256']}",
                "id": index + 1,
                "name": name,
                "size": value["bytes"],
                "state": "uploaded",
            }
            for index, (name, value) in enumerate(sorted(assets.items()))
        ],
        "draft": False,
        "id": 73,
        "immutable": True,
        "prerelease": False,
        "tag_name": manifest["tag"],
        "target_commitish": manifest["target_commitish"],
    }

    def fetch_json(_url: str, _label: str) -> dict[str, Any]:
        return release

    def fetch_asset(
        url: str,
        output: pathlib.Path,
        expected_bytes: int,
        expected_sha256: str,
    ) -> None:
        name = url.rsplit("/", 1)[1]
        source = prepared / "assets" / name
        self_bytes = source.read_bytes()
        if (
            len(self_bytes) != expected_bytes
            or sha256(self_bytes) != expected_sha256
        ):
            raise AssertionError("test release evidence is inconsistent")
        output.write_bytes(self_bytes)

    return fetch_json, fetch_asset, release


def prepare_alpha_release(
    fixture: Fixture,
    label: str,
) -> tuple[pathlib.Path, dict[str, Any]]:
    handoff = fixture.root / f"{label}-handoff"
    fixture.derive(
        "alpha",
        [("wasm32", fixture.publication("alpha", "wasm32"))],
        [],
        handoff,
    )
    prepared = fixture.root / f"{label}-prepared"
    EXECUTOR.prepare_release(
        campaign_path=fixture.campaign_path,
        handoff_root=handoff,
        dependency_roots=[],
        output=prepared,
    )
    manifest = json.loads(
        (prepared / "release-manifest.json").read_text()
    )
    return prepared, manifest


def rewrite_handoff_release(
    prepared: pathlib.Path,
    mutate: Any,
) -> str:
    handoff_path = prepared / "assets/handoff.json"
    handoff = json.loads(handoff_path.read_text())
    mutate(handoff)
    write_json(handoff_path, handoff)
    payload = handoff_path.read_bytes()

    manifest_path = prepared / "release-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    handoff_record = next(
        record
        for record in manifest["assets"]
        if record["name"] == "handoff.json"
    )
    handoff_record["bytes"] = len(payload)
    handoff_record["sha256"] = sha256(payload)
    manifest["tag"] = EXECUTOR.handoff_tag(payload)
    write_json(manifest_path, manifest)
    return manifest["tag"]


class PrefixCampaignExecutorTests(unittest.TestCase):
    def test_closed_selection_ignores_unrelated_missing_formula(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "selection-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        output = fixture.root / "alpha-selection"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha"],
            arch="wasm32",
            handoff_roots=[alpha],
            output=output,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )

        selection = json.loads(
            (output / "selection.json").read_text()
        )
        self.assertEqual(
            selection["kind"],
            "kandelo-homebrew-closed-selection-candidate",
        )
        self.assertEqual(selection["roots"], ["alpha"])
        self.assertEqual(
            [value["formula"] for value in selection["formulae"]],
            ["alpha"],
        )
        self.assertIn(
            "wasm32 bottle",
            (output / "tap/Formula/alpha.rb").read_text(),
        )
        self.assertFalse(
            (output / "tap/Formula/beta.rb").exists()
        )
        self.assertFalse(
            (
                output
                / "tap/Kandelo/reports/"
                "beta-2.0-rebuild1-wasm32.provenance.json"
            ).exists()
        )
        self.assertEqual(
            json.loads(
                (output / "tap/Kandelo/metadata.json").read_text()
            )["packages"],
            [{"name": "alpha"}],
        )

    def test_incomplete_named_closure_produces_no_candidate(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "lock-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        beta = fixture.root / "lock-beta"
        fixture.derive(
            "beta",
            [("wasm32", fixture.publication("beta", "wasm32"))],
            [alpha],
            beta,
        )
        output = fixture.root / "incomplete-selection"

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "selected dependency closure lacks handoffs.*alpha",
        ):
            EXECUTOR.prepare_selection(
                campaign_path=fixture.campaign_path,
                source_tap_root=fixture.source,
                roots=["beta"],
                arch="wasm32",
                handoff_roots=[beta],
                output=output,
                bottle_merger=fixture.merge_dependency,
                sidecar_generator=fixture.generate_sidecars,
                tap_validator=fixture.validate_tap,
            )
        self.assertFalse(output.exists())

        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["beta"],
            arch="wasm32",
            handoff_roots=[beta, alpha],
            output=output,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )
        selection = json.loads(
            (output / "selection.json").read_text()
        )
        self.assertEqual(
            [value["formula"] for value in selection["formulae"]],
            ["alpha", "beta"],
        )

    def test_closed_selection_uses_private_handoff_snapshots(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "stable-selection-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        live_input = (
            alpha
            / "payload/wasm32/composition/sidecars-input.json"
        )

        def mutate_live_then_generate(**arguments: Any) -> None:
            private_input = pathlib.Path(arguments["input_path"])
            self.assertNotEqual(
                private_input.resolve(),
                live_input.resolve(),
            )
            live_input.write_bytes(b'{"mutated":true}\n')
            fixture.generate_sidecars(**arguments)

        output = fixture.root / "stable-selection"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha"],
            arch="wasm32",
            handoff_roots=[alpha],
            output=output,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=mutate_live_then_generate,
            tap_validator=fixture.validate_tap,
        )
        self.assertTrue((output / "selection.json").is_file())
        self.assertEqual(
            json.loads(
                (output / "tap/Kandelo/metadata.json").read_text()
            )["packages"],
            [{"name": "alpha"}],
        )

    def test_selection_validator_failure_exposes_no_candidate(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "invalid-selection-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        output = fixture.root / "invalid-selection"

        def reject_tap(**_arguments: Any) -> None:
            raise EXECUTOR.ExecutorError("whole-tap validation failed")

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "whole-tap validation failed",
        ):
            EXECUTOR.prepare_selection(
                campaign_path=fixture.campaign_path,
                source_tap_root=fixture.source,
                roots=["alpha"],
                arch="wasm32",
                handoff_roots=[alpha],
                output=output,
                bottle_merger=fixture.merge_dependency,
                sidecar_generator=fixture.generate_sidecars,
                tap_validator=reject_tap,
            )
        self.assertFalse(output.exists())

    def test_successful_arch_is_handed_off_without_its_sibling(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)

        handoff = fixture.root / "alpha-wasm32-handoff"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            handoff,
        )
        value, _payload = EXECUTOR.load_handoff(
            handoff,
            fixture.campaign,
            fixture.campaign_path.read_bytes(),
        )
        self.assertEqual(
            [publication["arch"] for publication in value["publications"]],
            ["wasm32"],
        )

        prepared = fixture.root / "alpha-wasm32-release"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=handoff,
            dependency_roots=[],
            output=prepared,
        )
        self.assertTrue(
            (prepared / "assets/wasm32.build.bottle.tar.gz").is_file()
        )
        self.assertFalse(
            (prepared / "assets/wasm64.build.bottle.tar.gz").exists()
        )
        manifest = json.loads(
            (prepared / "release-manifest.json").read_text()
        )
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        readback = fixture.root / "alpha-wasm32-readback"
        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=manifest["tag"],
            output=readback,
            receipt_output=fixture.root / "alpha-wasm32-receipt.json",
            dependency_roots=[],
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        readback_value, _payload = EXECUTOR.load_handoff(
            readback,
            fixture.campaign,
            fixture.campaign_path.read_bytes(),
        )
        self.assertEqual(
            [
                publication["arch"]
                for publication in readback_value["publications"]
            ],
            ["wasm32"],
        )

    def test_consumer_requires_same_arch_dependency_handoff(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha_wasm32 = fixture.root / "alpha-wasm32"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha_wasm32,
        )

        beta_wasm32 = fixture.root / "beta-wasm32"
        fixture.derive(
            "beta",
            [("wasm32", fixture.publication("beta", "wasm32"))],
            [alpha_wasm32],
            beta_wasm32,
        )
        self.assertTrue((beta_wasm32 / "handoff.json").is_file())

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependency alpha has no wasm64 campaign publication",
        ):
            fixture.derive(
                "beta",
                [("wasm64", fixture.publication("beta", "wasm64"))],
                [alpha_wasm32],
                fixture.root / "beta-wasm64",
            )

    def test_four_commands_round_trip_dependency_ordered_handoffs(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)

        campaign_tag = (
            "homebrew-prefix-campaign-sha256-"
            + sha256(fixture.campaign_path.read_bytes())
        )
        campaign_release = fixture.root / "campaign-release"
        (campaign_release / "assets").mkdir(parents=True)
        shutil.copy2(
            fixture.campaign_path,
            campaign_release / "assets/campaign.json",
        )
        write_json(
            campaign_release / "release-manifest.json",
            {
                "assets": [
                    {
                        "bytes": fixture.campaign_path.stat().st_size,
                        "name": "campaign.json",
                        "sha256": sha256(
                            fixture.campaign_path.read_bytes()
                        ),
                    }
                ],
                "repository": TAP_REPOSITORY,
                "tag": campaign_tag,
                "target_commitish": SOURCE_TAP_COMMIT,
            },
        )
        fetch_json, fetch_asset, release = release_fetchers(
            campaign_release
        )
        release["tag_name"] = campaign_tag
        release["target_commitish"] = SOURCE_TAP_COMMIT
        fetched_campaign = fixture.root / "fetched-campaign.json"
        campaign_receipt = fixture.root / "campaign-receipt.json"
        EXECUTOR.fetch_campaign_release(
            repository=TAP_REPOSITORY,
            tag=campaign_tag,
            output=fetched_campaign,
            receipt_output=campaign_receipt,
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        self.assertEqual(
            fetched_campaign.read_bytes(),
            fixture.campaign_path.read_bytes(),
        )

        alpha = fixture.root / "alpha-handoff"
        fixture.derive(
            "alpha",
            [
                ("wasm32", fixture.publication("alpha", "wasm32")),
                ("wasm64", fixture.publication("alpha", "wasm64")),
            ],
            [],
            alpha,
        )
        alpha_prepared = fixture.root / "alpha-prepared"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=alpha,
            dependency_roots=[],
            output=alpha_prepared,
        )
        subprocess.run(
            [
                "python3",
                str(
                    ROOT
                    / "scripts/"
                    "validate-immutable-github-release-manifest.py"
                ),
                "--manifest",
                str(alpha_prepared / "release-manifest.json"),
                "--asset-root",
                str(alpha_prepared / "assets"),
                "--stage-dir",
                str(fixture.root / "validated-assets"),
                "--out-manifest",
                str(fixture.root / "validated-release.json"),
            ],
            check=True,
            env={
                key: value
                for key, value in os.environ.items()
                if key not in ("GH_TOKEN", "GITHUB_TOKEN")
            },
        )
        alpha_json, _payload = EXECUTOR.load_json_bytes(
            alpha_prepared / "release-manifest.json",
            "alpha release manifest",
        )
        alpha_fetch_json, alpha_fetch_asset, _release = release_fetchers(
            alpha_prepared
        )
        alpha_readback = fixture.root / "alpha-readback"
        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=alpha_json["tag"],
            output=alpha_readback,
            receipt_output=fixture.root / "alpha-receipt.json",
            dependency_roots=[],
            json_fetcher=alpha_fetch_json,
            asset_fetcher=alpha_fetch_asset,
        )

        beta = fixture.root / "beta-handoff"
        fixture.derive(
            "beta",
            [
                ("wasm32", fixture.publication("beta", "wasm32")),
                ("wasm64", fixture.publication("beta", "wasm64")),
            ],
            [alpha_readback],
            beta,
        )
        beta_prepared = fixture.root / "beta-prepared"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=beta,
            dependency_roots=[alpha_readback],
            output=beta_prepared,
        )
        beta_json, _payload = EXECUTOR.load_json_bytes(
            beta_prepared / "release-manifest.json",
            "beta release manifest",
        )
        beta_fetch_json, beta_fetch_asset, _release = release_fetchers(
            beta_prepared
        )
        beta_readback = fixture.root / "beta-readback"
        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=beta_json["tag"],
            output=beta_readback,
            receipt_output=fixture.root / "beta-receipt.json",
            dependency_roots=[alpha_readback],
            json_fetcher=beta_fetch_json,
            asset_fetcher=beta_fetch_asset,
        )
        beta_handoff, _payload = EXECUTOR.load_handoff(
            beta_readback,
            fixture.campaign,
            fixture.campaign_path.read_bytes(),
        )
        self.assertEqual(
            beta_handoff["dependency_handoffs"][0]["formula"],
            "alpha",
        )
        self.assertEqual(
            [
                publication["arch"]
                for publication in beta_handoff["publications"]
            ],
            ["wasm32", "wasm64"],
        )

    def test_missing_dependency_and_wrong_source_tree_fail_closed(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependency handoffs differ",
        ):
            fixture.derive(
                "beta",
                [("wasm32", fixture.publication("beta", "wasm32"))],
                [],
                fixture.root / "missing-dependency",
            )
        (fixture.source / "Formula/alpha.rb").write_bytes(b"tampered\n")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "sealed Git tree",
        ):
            fixture.derive(
                "alpha",
                [
                    (
                        "wasm32",
                        fixture.publication("alpha", "wasm32"),
                    )
                ],
                [],
                fixture.root / "wrong-source",
            )

    def test_publication_and_release_tampering_are_rejected(self) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        publication = fixture.publication("alpha", "wasm32")
        composition = publication / "composition/sidecars-input.json"
        value = json.loads(composition.read_text())
        value["packages"][0]["formula_source_sha256"] = "f" * 64
        write_json(composition, value)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "composition differs",
        ):
            fixture.derive(
                "alpha",
                [("wasm32", publication)],
                [],
                fixture.root / "bad-composition",
            )

        publication = fixture.publication("alpha", "wasm32")
        os.symlink(
            publication / "receipt.json",
            publication / "unexpected-link",
        )
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "symlink or special file",
        ):
            fixture.derive(
                "alpha",
                [("wasm32", publication)],
                [],
                fixture.root / "bad-link",
            )

        alpha = fixture.root / "alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        prepared = fixture.root / "prepared"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=alpha,
            dependency_roots=[],
            output=prepared,
        )
        manifest = json.loads(
            (prepared / "release-manifest.json").read_text()
        )
        fetch_json, fetch_asset, release = release_fetchers(prepared)
        fetched_assets: list[str] = []

        def count_fetches(
            url: str,
            output: pathlib.Path,
            expected_bytes: int,
            expected_sha256: str,
        ) -> None:
            fetched_assets.append(url.rsplit("/", 1)[1])
            fetch_asset(
                url,
                output,
                expected_bytes,
                expected_sha256,
            )

        release["assets"].append(
                {
                    "browser_download_url": (
                        f"https://github.com/{TAP_REPOSITORY}/"
                        f"releases/download/{manifest['tag']}/"
                        "unexpected.json"
                    ),
                    "digest": f"sha256:{'f' * 64}",
                    "id": 100,
                    "name": "unexpected.json",
                    "size": 1,
                    "state": "uploaded",
            }
        )
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "unexpected assets",
        ):
            EXECUTOR.fetch_release(
                campaign_path=fixture.campaign_path,
                tag=manifest["tag"],
                output=fixture.root / "unexpected-release",
                receipt_output=fixture.root / "unexpected-receipt.json",
                dependency_roots=[],
                json_fetcher=fetch_json,
                asset_fetcher=count_fetches,
            )
        self.assertEqual(fetched_assets, ["handoff.json"])

    def test_campaign_release_requires_content_address_and_immutability(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        payload = fixture.campaign_path.read_bytes()
        tag = f"homebrew-prefix-campaign-sha256-{sha256(payload)}"
        release = {
            "assets": [
                {
                    "browser_download_url": (
                        f"https://github.com/{TAP_REPOSITORY}/"
                        f"releases/download/{tag}/campaign.json"
                    ),
                    "digest": f"sha256:{sha256(payload)}",
                    "id": 1,
                    "name": "campaign.json",
                    "size": len(payload),
                    "state": "uploaded",
                }
            ],
            "draft": False,
            "id": 2,
            "immutable": False,
            "prerelease": False,
            "tag_name": tag,
            "target_commitish": SOURCE_TAP_COMMIT,
        }

        def fetch_json(_url: str, _label: str) -> dict[str, Any]:
            return release

        def fetch_asset(
            _url: str,
            output: pathlib.Path,
            _expected_bytes: int,
            _expected_sha256: str,
        ) -> None:
            output.write_bytes(payload)

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "public immutable release",
        ):
            EXECUTOR.fetch_campaign_release(
                repository=TAP_REPOSITORY,
                tag=tag,
                output=fixture.root / "campaign-output.json",
                receipt_output=fixture.root / "campaign-receipt.json",
                json_fetcher=fetch_json,
                asset_fetcher=fetch_asset,
            )

    def test_campaign_dependency_versions_match_formula_inventory(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        fixture.formulae[1]["dependencies"][0]["version"] = "9.9"
        write_json(fixture.campaign_path, fixture.campaign)

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "version differs from its Formula",
        ):
            EXECUTOR.load_campaign(fixture.campaign_path)

    def test_deterministic_checkout_identity_matches_git(self) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        repository = fixture.root / "git-identity"
        repository.mkdir()
        subprocess.run(
            ["git", "init", "--quiet", str(repository)],
            check=True,
        )
        (repository / "source").write_text("sealed source\n")
        subprocess.run(
            ["git", "-C", str(repository), "add", "source"],
            check=True,
        )
        tree = subprocess.check_output(
            ["git", "-C", str(repository), "write-tree"],
            text=True,
        ).strip()
        environment = os.environ.copy()
        environment.update(
            {
                "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z",
                "GIT_AUTHOR_EMAIL": EXECUTOR.CAMPAIGN_COMMIT_EMAIL,
                "GIT_AUTHOR_NAME": EXECUTOR.CAMPAIGN_COMMIT_NAME,
                "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z",
                "GIT_COMMITTER_EMAIL": EXECUTOR.CAMPAIGN_COMMIT_EMAIL,
                "GIT_COMMITTER_NAME": EXECUTOR.CAMPAIGN_COMMIT_NAME,
            }
        )
        parent = subprocess.check_output(
            ["git", "-C", str(repository), "commit-tree", tree],
            input=b"fixture parent\n",
            env=environment,
        ).decode().strip()
        label = "alpha/wasm32 dependency bottles"
        message = (
            "Kandelo Homebrew campaign publisher snapshot\n\n"
            f"Purpose: {label}\n"
            f"Protected source: {parent}\n"
        ).encode()
        actual = subprocess.check_output(
            [
                "git",
                "-C",
                str(repository),
                "commit-tree",
                tree,
                "-p",
                parent,
            ],
            input=message,
            env=environment,
        ).decode().strip()
        self.assertEqual(
            EXECUTOR.deterministic_campaign_commit_oid(
                parent=parent,
                tree=tree,
                label=label,
            ),
            actual,
        )

    def test_leaf_checkout_uses_exact_arch_commit_identity(self) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        observed: dict[str, Any] = {}

        def capture(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            arch: str,
            _publication: pathlib.Path,
            prepared_root: pathlib.Path,
            checkout_commit: str,
        ) -> None:
            observed["arch"] = arch
            observed["checkout_commit"] = checkout_commit
            observed["tree"] = EXECUTOR.filesystem_git_tree_oid(
                prepared_root,
                "leaf prepared checkout",
            )
            observed["formula"] = (
                prepared_root / "Formula/alpha.rb"
            ).read_bytes()

        EXECUTOR.derive_build(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            formula_name="alpha",
            publications=[
                ("wasm32", fixture.publication("alpha", "wasm32"))
            ],
            dependency_roots=[],
            output=fixture.root / "leaf-checkout",
            validator=capture,
            dependency_merger=fixture.merge_dependency,
        )
        target_commit = EXECUTOR.deterministic_campaign_commit_oid(
            parent=SOURCE_TAP_COMMIT,
            tree=fixture.source_tree,
            label="sealed target source",
        )
        expected = EXECUTOR.deterministic_campaign_commit_oid(
            parent=target_commit,
            tree=fixture.source_tree,
            label="alpha/wasm32 dependency bottles",
        )
        self.assertEqual(observed["arch"], "wasm32")
        self.assertEqual(observed["tree"], fixture.source_tree)
        self.assertEqual(observed["checkout_commit"], expected)
        self.assertNotEqual(observed["checkout_commit"], target_commit)
        self.assertEqual(
            observed["formula"],
            formula_source("alpha"),
        )

    def test_each_arch_derives_its_own_dependency_checkout(self) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "multi-arch-alpha"
        fixture.derive(
            "alpha",
            [
                ("wasm32", fixture.publication("alpha", "wasm32")),
                ("wasm64", fixture.publication("alpha", "wasm64")),
            ],
            [],
            alpha,
        )
        observed: dict[str, dict[str, Any]] = {}

        def capture(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            arch: str,
            _publication: pathlib.Path,
            prepared_root: pathlib.Path,
            checkout_commit: str,
        ) -> None:
            observed[arch] = {
                "checkout_commit": checkout_commit,
                "dependency_formula": (
                    prepared_root / "Formula/alpha.rb"
                ).read_text(),
                "tree": EXECUTOR.filesystem_git_tree_oid(
                    prepared_root,
                    f"{arch} prepared checkout",
                ),
            }

        EXECUTOR.derive_build(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            formula_name="beta",
            publications=[
                ("wasm32", fixture.publication("beta", "wasm32")),
                ("wasm64", fixture.publication("beta", "wasm64")),
            ],
            dependency_roots=[alpha],
            output=fixture.root / "multi-arch-beta",
            validator=capture,
            dependency_merger=fixture.merge_dependency,
        )
        target_commit = EXECUTOR.deterministic_campaign_commit_oid(
            parent=SOURCE_TAP_COMMIT,
            tree=fixture.source_tree,
            label="sealed target source",
        )
        self.assertEqual(set(observed), {"wasm32", "wasm64"})
        for arch in ("wasm32", "wasm64"):
            expected = EXECUTOR.deterministic_campaign_commit_oid(
                parent=target_commit,
                tree=observed[arch]["tree"],
                label=f"beta/{arch} dependency bottles",
            )
            self.assertEqual(
                observed[arch]["checkout_commit"],
                expected,
            )
            self.assertIn(
                sha256(f"alpha/{arch} bottle bytes\n".encode()),
                observed[arch]["dependency_formula"],
            )
        self.assertNotEqual(
            observed["wasm32"]["tree"],
            observed["wasm64"]["tree"],
        )
        self.assertNotEqual(
            observed["wasm32"]["checkout_commit"],
            observed["wasm64"]["checkout_commit"],
        )

    def test_dependency_json_is_snapshotted_without_its_archive(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        alpha = fixture.root / "snapshot-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        live_bottle_json = (
            alpha / "payload/wasm32/build/bottle.json"
        )
        original_handoff = (alpha / "handoff.json").read_bytes()
        staged_files: list[str] = []

        def mutate_after_snapshot(**arguments: Any) -> None:
            bottle_json = pathlib.Path(arguments["bottle_json"])
            staged_files.extend(
                sorted(
                    path.name
                    for path in bottle_json.parent.iterdir()
                )
            )
            live_bottle_json.write_bytes(b'{"mutated":true}\n')
            fixture.merge_dependency(**arguments)

        beta = fixture.root / "snapshot-beta"
        EXECUTOR.derive_build(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            formula_name="beta",
            publications=[
                ("wasm32", fixture.publication("beta", "wasm32"))
            ],
            dependency_roots=[alpha],
            output=beta,
            validator=lambda *_arguments: None,
            dependency_merger=mutate_after_snapshot,
        )
        self.assertEqual(
            staged_files,
            ["bottle.json", "raw-bottle.json"],
        )
        self.assertEqual(
            json.loads((beta / "handoff.json").read_text())[
                "dependency_handoffs"
            ][0]["tag"],
            EXECUTOR.handoff_tag(original_handoff),
        )

    def test_default_validator_rejects_forged_checkout_identity(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        publication = fixture.publication("alpha", "wasm32")
        manifest = publication / "build/manifest.json"
        forged = "f" * 40
        derived = "d" * 40
        write_json(
            manifest,
            {
                "schema": 4,
                "tap_checkout_commit": forged,
            },
        )
        with mock.patch.object(
            EXECUTOR.subprocess,
            "run",
        ) as runner:
            with self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "names a different prepared checkout",
            ):
                EXECUTOR.default_publication_validator(
                    fixture.campaign,
                    fixture.formulae[0],
                    "wasm32",
                    publication,
                    fixture.source,
                    derived,
                )
            runner.assert_not_called()
        write_json(
            manifest,
            {
                "schema": 4,
                "tap_checkout_commit": derived,
            },
        )
        completed = subprocess.CompletedProcess(
            [],
            0,
            stdout=b"",
            stderr=b"",
        )
        with mock.patch.object(
            EXECUTOR.subprocess,
            "run",
            return_value=completed,
        ) as runner:
            EXECUTOR.default_publication_validator(
                fixture.campaign,
                fixture.formulae[0],
                "wasm32",
                publication,
                fixture.source,
                derived,
            )
        commands = runner.call_args.args[0]
        self.assertEqual(
            commands[commands.index("--tap-commit") + 1],
            SOURCE_TAP_COMMIT,
        )
        self.assertEqual(
            commands[
                commands.index("--tap-checkout-commit") + 1
            ],
            derived,
        )
        self.assertNotEqual(derived, forged)

    def test_derivation_uses_private_stable_input_snapshots(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        publication = fixture.publication("alpha", "wasm32")
        original_receipt = (publication / "receipt.json").read_bytes()
        output = fixture.root / "stable-snapshot"

        def mutate_live_inputs(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            _arch: str,
            private_publication: pathlib.Path,
            private_source: pathlib.Path,
            _checkout_commit: str,
        ) -> None:
            self.assertNotEqual(
                private_publication.resolve(),
                publication.resolve(),
            )
            self.assertNotEqual(
                private_source.resolve(),
                fixture.source.resolve(),
            )
            (publication / "receipt.json").write_bytes(
                b"changed after private snapshot\n"
            )
            (fixture.source / "Formula/alpha.rb").write_bytes(
                b"changed after private snapshot\n"
            )

        EXECUTOR.derive_build(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            formula_name="alpha",
            publications=[("wasm32", publication)],
            dependency_roots=[],
            output=output,
            validator=mutate_live_inputs,
        )
        self.assertEqual(
            (
                output / "payload/wasm32/receipt.json"
            ).read_bytes(),
            original_receipt,
        )

        hostile = Fixture()
        self.addCleanup(hostile.close)
        hostile_publication = hostile.publication(
            "alpha", "wasm32"
        )
        hostile_output = hostile.root / "mutated-private-snapshot"

        def mutate_private_input(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            _arch: str,
            private_publication: pathlib.Path,
            _private_source: pathlib.Path,
            _checkout_commit: str,
        ) -> None:
            (private_publication / "receipt.json").write_bytes(
                b"validator changed private bytes\n"
            )

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its manifest",
        ):
            EXECUTOR.derive_build(
                campaign_path=hostile.campaign_path,
                source_tap_root=hostile.source,
                formula_name="alpha",
                publications=[
                    ("wasm32", hostile_publication)
                ],
                dependency_roots=[],
                output=hostile_output,
                validator=mutate_private_input,
            )
        self.assertFalse(hostile_output.exists())

        hostile_source = Fixture()
        self.addCleanup(hostile_source.close)
        source_publication = hostile_source.publication(
            "alpha", "wasm32"
        )
        source_output = (
            hostile_source.root / "mutated-private-source"
        )

        def mutate_private_source(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            _arch: str,
            _private_publication: pathlib.Path,
            private_source: pathlib.Path,
            _checkout_commit: str,
        ) -> None:
            (private_source / "Formula/alpha.rb").write_bytes(
                b"validator changed private source\n"
            )

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "prepared checkout changed after validation",
        ):
            EXECUTOR.derive_build(
                campaign_path=hostile_source.campaign_path,
                source_tap_root=hostile_source.source,
                formula_name="alpha",
                publications=[("wasm32", source_publication)],
                dependency_roots=[],
                output=source_output,
                validator=mutate_private_source,
            )
        self.assertFalse(source_output.exists())

    def test_handoff_inventory_rejects_before_payload_downloads(
        self,
    ) -> None:
        def add_traversal(handoff: dict[str, Any]) -> None:
            handoff["publications"][0]["files"][0]["path"] = (
                "payload/wasm32/../../outside"
            )

        def repeat_path(handoff: dict[str, Any]) -> None:
            records = handoff["publications"][0]["files"]
            records[1]["path"] = records[0]["path"]

        def repeat_asset(handoff: dict[str, Any]) -> None:
            records = handoff["publications"][0]["files"]
            records[1]["asset_name"] = records[0]["asset_name"]

        def exceed_aggregate_bound(
            handoff: dict[str, Any],
        ) -> None:
            for record in handoff["publications"][0]["files"]:
                record["bytes"] = EXECUTOR.MAX_ASSET_BYTES

        cases = (
            (
                "traversal",
                add_traversal,
                "safe repository-relative path",
            ),
            (
                "repeated-path",
                repeat_path,
                "repeats a payload path",
            ),
            (
                "repeated-asset",
                repeat_asset,
                "asset name",
            ),
            (
                "aggregate-bound",
                exceed_aggregate_bound,
                "aggregate size bound",
            ),
        )
        for label, mutate, message in cases:
            with self.subTest(label=label):
                fixture = Fixture()
                try:
                    prepared, _manifest = prepare_alpha_release(
                        fixture, label
                    )
                    tag = rewrite_handoff_release(prepared, mutate)
                    fetch_json, fetch_asset, _release = (
                        release_fetchers(prepared)
                    )
                    fetched_assets: list[str] = []

                    def count_fetches(
                        url: str,
                        output: pathlib.Path,
                        expected_bytes: int,
                        expected_sha256: str,
                    ) -> None:
                        fetched_assets.append(url.rsplit("/", 1)[1])
                        fetch_asset(
                            url,
                            output,
                            expected_bytes,
                            expected_sha256,
                        )

                    output = fixture.root / f"{label}-readback"
                    receipt = fixture.root / f"{label}-receipt.json"
                    with self.assertRaisesRegex(
                        EXECUTOR.ExecutorError,
                        message,
                    ):
                        EXECUTOR.fetch_release(
                            campaign_path=fixture.campaign_path,
                            tag=tag,
                            output=output,
                            receipt_output=receipt,
                            dependency_roots=[],
                            json_fetcher=fetch_json,
                            asset_fetcher=count_fetches,
                        )
                    self.assertEqual(
                        fetched_assets, ["handoff.json"]
                    )
                    self.assertFalse(output.exists())
                    self.assertFalse(receipt.exists())
                finally:
                    fixture.close()

    def test_outputs_must_not_overlap_inputs_or_receipts(self) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        publication = fixture.publication("alpha", "wasm32")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "overlaps an input path",
        ):
            fixture.derive(
                "alpha",
                [("wasm32", publication)],
                [],
                publication / "nested-handoff",
            )
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "overlaps an input path",
        ):
            fixture.derive(
                "alpha",
                [("wasm32", publication)],
                [],
                fixture.source / "nested-handoff",
            )

        prepared, manifest = prepare_alpha_release(
            fixture, "overlap"
        )
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        same_output = fixture.root / "same-output"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "overlap",
        ):
            EXECUTOR.fetch_release(
                campaign_path=fixture.campaign_path,
                tag=manifest["tag"],
                output=same_output,
                receipt_output=same_output,
                dependency_roots=[],
                json_fetcher=fetch_json,
                asset_fetcher=fetch_asset,
            )
        nested_output = fixture.root / "nested-output"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "overlap",
        ):
            EXECUTOR.fetch_release(
                campaign_path=fixture.campaign_path,
                tag=manifest["tag"],
                output=nested_output,
                receipt_output=nested_output / "receipt.json",
                dependency_roots=[],
                json_fetcher=fetch_json,
                asset_fetcher=fetch_asset,
            )

    def test_receipt_commit_failure_rolls_back_and_retry_succeeds(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        prepared, manifest = prepare_alpha_release(
            fixture, "rollback"
        )
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        output = fixture.root / "rollback-readback"
        receipt = fixture.root / "rollback-receipt.json"
        real_link = os.link

        def fail_receipt_link(
            source: pathlib.Path,
            destination: pathlib.Path,
        ) -> None:
            if pathlib.Path(destination).resolve(
                strict=False
            ) == receipt.resolve(strict=False):
                raise OSError("injected receipt commit failure")
            real_link(source, destination)

        with mock.patch.object(
            EXECUTOR.os,
            "link",
            side_effect=fail_receipt_link,
        ):
            with self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "commit readback output and receipt",
            ):
                EXECUTOR.fetch_release(
                    campaign_path=fixture.campaign_path,
                    tag=manifest["tag"],
                    output=output,
                    receipt_output=receipt,
                    dependency_roots=[],
                    json_fetcher=fetch_json,
                    asset_fetcher=fetch_asset,
                )
        self.assertFalse(output.exists())
        self.assertFalse(receipt.exists())

        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=manifest["tag"],
            output=output,
            receipt_output=receipt,
            dependency_roots=[],
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        self.assertTrue(output.is_dir())
        self.assertTrue(receipt.is_file())

        staged_file = fixture.root / "staged-campaign.json"
        staged_file.write_bytes(b"campaign\n")
        staged_receipt = fixture.root / "staged-receipt.json"
        write_json(staged_receipt, {"schema": 1})
        file_output = fixture.root / "campaign-readback.json"
        file_receipt = fixture.root / "campaign-file-receipt.json"

        def fail_file_receipt_link(
            source: pathlib.Path,
            destination: pathlib.Path,
        ) -> None:
            if pathlib.Path(destination).resolve(
                strict=False
            ) == file_receipt.resolve(strict=False):
                raise OSError("injected file receipt commit failure")
            real_link(source, destination)

        with mock.patch.object(
            EXECUTOR.os,
            "link",
            side_effect=fail_file_receipt_link,
        ):
            with self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "commit readback output and receipt",
            ):
                EXECUTOR.commit_output_pair(
                    staged_file,
                    file_output,
                    staged_receipt,
                    file_receipt,
                )
        self.assertFalse(file_output.exists())
        self.assertFalse(file_receipt.exists())
        EXECUTOR.commit_output_pair(
            staged_file,
            file_output,
            staged_receipt,
            file_receipt,
        )
        self.assertEqual(file_output.read_bytes(), b"campaign\n")
        self.assertTrue(file_receipt.is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
