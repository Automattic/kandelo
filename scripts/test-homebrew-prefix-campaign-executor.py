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


class ReuseFixture(Fixture):
    def __init__(self) -> None:
        super().__init__()
        self.old_tap = self.root / "old-tap"
        (self.old_tap / "Formula").mkdir(parents=True)
        subprocess.run(
            ["git", "init", "-q"], cwd=self.old_tap, check=True
        )
        (self.old_tap / "Formula/alpha.rb").write_bytes(
            formula_source("alpha")
        )
        self.historical_formula_commit = self.commit_old_tap(
            "historical Formula"
        )

        layout = json.loads(
            (ROOT / "homebrew/kandelo-guest-layout.json").read_text()
        )
        archive = b"alpha/wasm32 historical bottle bytes\n"
        self.archive = archive
        digest = sha256(archive)
        source_formula_digest = sha256(formula_source("alpha"))
        # Homebrew archives the Formula receipt that produced a bottle. Its
        # digest is independent from the current tap source identity, which
        # excludes mutable bottle blocks when deciding whether bytes can be
        # reused. Keep the fixture values distinct so admission cannot
        # accidentally substitute one provenance identity for the other.
        archived_formula_digest = sha256(
            b"historical Formula receipt embedded in the bottle\n"
        )
        link_path = "Kandelo/link/alpha-1.0-rebuild0-wasm32.json"
        provenance_path = (
            "Kandelo/reports/"
            "alpha-1.0-rebuild0-wasm32.provenance.json"
        )
        self.old_record = {
            "arch": "wasm32",
            "bottle_tag": "wasm32_kandelo",
            "browser_compatible": True,
            "built_at": "2026-07-20T00:00:00Z",
            "built_by": "https://github.com/example/actions/runs/7",
            "built_from": {
                "formula_sha256": archived_formula_digest,
                "kandelo_commit": "d" * 40,
                "kandelo_repository": "Automattic/kandelo",
                "tap_commit": self.historical_formula_commit,
                "tap_repository": TAP_REPOSITORY,
            },
            "bytes": len(archive),
            "cache_key_sha": digest,
            "cellar": f"{layout['retired_prefixes'][0]}/Cellar",
            "fork_instrumentation": "not-required",
            "kandelo_abi": 42,
            "link_manifest": link_path,
            "prefix": layout["retired_prefixes"][0],
            "runtime_support": ["browser", "node"],
            "sha256": digest,
            "status": "success",
            "url": (
                "https://ghcr.io/v2/"
                f"{TAP_REPOSITORY}/alpha/blobs/sha256:{digest}"
            ),
        }
        metadata = {
            "generated_at": "2026-07-20T00:00:00Z",
            "generator": "reuse fixture",
            "kandelo_abi": 42,
            "kandelo_commit": "d" * 40,
            "kandelo_repository": "Automattic/kandelo",
            "packages": [],
            "release_tag": "bottles-abi-v42",
            "schema": 1,
            "tap_commit": "e" * 40,
            "tap_name": TAP_NAME,
            "tap_repository": TAP_REPOSITORY,
        }
        metadata_path = self.old_tap / "Kandelo/metadata.json"
        write_json(metadata_path, metadata)
        metadata_record = {
            "path": "Kandelo/metadata.json",
            "sha256": sha256(metadata_path.read_bytes()),
        }
        formula_sidecar = {
            "bottle_rebuild": 0,
            "bottles": [self.old_record],
            "dependencies": [],
            "formula_path": "Formula/alpha.rb",
            "formula_revision": 0,
            "full_name": f"{TAP_NAME}/alpha",
            "kandelo_abi": 42,
            "name": "alpha",
            "schema": 1,
            "source_metadata": "Kandelo/metadata.json",
            "tap_commit": "e" * 40,
            "tap_name": TAP_NAME,
            "tap_repository": TAP_REPOSITORY,
            "version": "1.0",
        }
        formula_sidecar_path = self.old_tap / "Kandelo/formula/alpha.json"
        write_json(formula_sidecar_path, formula_sidecar)
        formula_record = {
            "path": "Kandelo/formula/alpha.json",
            "sha256": sha256(formula_sidecar_path.read_bytes()),
        }
        link = {
            "arch": "wasm32",
            "bottle": {
                "bytes": len(archive),
                "cache_key_sha": digest,
                "payload_root": "alpha/1.0",
                "sha256": digest,
                "url": self.old_record["url"],
            },
            "cellar": self.old_record["cellar"],
            "env": {"PATH_prepend": ["bin"]},
            "kandelo_abi": 42,
            "keg": f"{self.old_record['cellar']}/alpha/1.0",
            "links": [
                {
                    "source": "bin/alpha",
                    "target": "bin/alpha",
                    "type": "file",
                }
            ],
            "package": "alpha",
            "prefix": self.old_record["prefix"],
            "receipts": [".brew/alpha.rb", "INSTALL_RECEIPT.json"],
            "schema": 1,
            "version": "1.0",
        }
        link_file = self.old_tap / link_path
        write_json(link_file, link)
        link_record = {
            "path": link_path,
            "sha256": sha256(link_file.read_bytes()),
        }
        build = {
            "brew_version": "Homebrew fixture",
            "dev_shell": "scripts/dev-shell.sh",
            "github_run": "https://github.com/example/actions/runs/7",
            "job": "verify-bottle",
            "runner_os": "Linux",
            "sdk_fingerprint": "1" * 64,
            "sysroot_fingerprint": "2" * 64,
        }
        validation = {
            "outcome_lists": [
                {
                    "failed": [],
                    "name": "schema",
                    "passed": ["fixture"],
                    "skipped": [],
                    "status": "success",
                },
                {
                    "failed": [],
                    "name": "node_smoke",
                    "passed": ["fixture"],
                    "skipped": [],
                    "status": "success",
                },
                {
                    "failed": [],
                    "name": "browser_smoke",
                    "passed": ["fixture"],
                    "skipped": [],
                    "status": "success",
                },
            ]
        }
        provenance = {
            "bottle": {
                key: self.old_record[key]
                for key in (
                    "bottle_tag",
                    "bytes",
                    "cache_key_sha",
                    "cellar",
                    "prefix",
                    "sha256",
                    "url",
                )
            },
            "build": build,
            "formula": {
                "path": "Formula/alpha.rb",
                "sha256": archived_formula_digest,
            },
            "metadata": {
                "formula_json": formula_record,
                "link_manifest_json": link_record,
                "metadata_json": metadata_record,
                "provenance_json": {
                    "path": provenance_path,
                    "sha256": "0" * 64,
                },
            },
            "repositories": {
                key: self.old_record["built_from"][key]
                for key in (
                    "kandelo_repository",
                    "kandelo_commit",
                    "tap_repository",
                    "tap_commit",
                )
            },
            "schema": 1,
            "subject": {
                "arch": "wasm32",
                "bottle_rebuild": 0,
                "kandelo_abi": 42,
                "package": "alpha",
                "version": "1.0",
            },
            "validation": validation,
        }
        provenance["metadata"]["provenance_json"]["sha256"] = (
            EXECUTOR.normalized_provenance_sha256(provenance)
        )
        provenance_file = self.old_tap / provenance_path
        write_json(provenance_file, provenance)
        provenance_record = {
            "path": provenance_path,
            "sha256": sha256(provenance_file.read_bytes()),
        }
        self.old_tap_commit = self.commit_old_tap("historical evidence")

        self.campaign["authority"].update(
            {
                "guest_layout": {
                    "path": "homebrew/kandelo-guest-layout.json",
                    "sha256": sha256(
                        (
                            ROOT / "homebrew/kandelo-guest-layout.json"
                        ).read_bytes()
                    ),
                },
                "old_metadata": metadata_record,
                "old_tap_commit": self.old_tap_commit,
            }
        )
        alpha = self.formulae[0]
        alpha["variants"] = [
            {
                "anonymous_readback": {
                    "bytes": len(archive),
                    "sha256": digest,
                    "url": self.old_record["url"],
                },
                "arch": "wasm32",
                "disposition": {
                    "kind": "byte-clean-reuse-candidate",
                    "reasons": [],
                },
                "inspection": {
                    "file_count": 3,
                    "fork_instrumentation": "not-required",
                    "formula_sha256": archived_formula_digest,
                    "result_sha256": "3" * 64,
                    "retired_prefixes": [],
                    "scan": "all-regular-members",
                },
                "old_formula_source": {
                    "commit": self.historical_formula_commit,
                    "identity_excluding_bottle_sha256": (
                        source_formula_digest
                    ),
                    "path": "Formula/alpha.rb",
                    "sha256": source_formula_digest,
                },
                "old_record": self.old_record,
                "old_record_sha256": sha256(
                    EXECUTOR.canonical_json(self.old_record)
                ),
                "provenance": provenance_record,
                "selected_by": "metadata-selected",
                "sidecars": {
                    "formula": formula_record,
                    "link": link_record,
                },
            }
        ]
        write_json(self.campaign_path, self.campaign)
        self.fetches: list[str] = []

    def commit_old_tap(self, message: str) -> str:
        subprocess.run(
            ["git", "add", "."], cwd=self.old_tap, check=True
        )
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Campaign fixture",
                "-c",
                "user.email=campaign@example.invalid",
                "commit",
                "-q",
                "-m",
                message,
            ],
            cwd=self.old_tap,
            check=True,
        )
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.old_tap,
            check=True,
            stdout=subprocess.PIPE,
            text=True,
        ).stdout.strip()

    def fetch_bottle(
        self,
        url: str,
        output: pathlib.Path,
        expected_bytes: int,
        expected_sha256: str,
    ) -> None:
        self.fetches.append(url)
        self.assert_public_read(url)
        if (
            len(self.archive) != expected_bytes
            or sha256(self.archive) != expected_sha256
        ):
            raise AssertionError("reuse fixture bottle identity changed")
        output.write_bytes(self.archive)

    def assert_public_read(self, url: str) -> None:
        if url != self.old_record["url"]:
            raise AssertionError("reuse did not fetch the public digest URL")

    def derive_reuse(self, output: pathlib.Path) -> None:
        EXECUTOR.derive_reuse(
            campaign_path=self.campaign_path,
            source_tap_root=self.source,
            old_tap_root=self.old_tap,
            formula_name="alpha",
            arch="wasm32",
            dependency_roots=[],
            output=output,
            asset_fetcher=self.fetch_bottle,
        )

    def generate_sidecars(
        self,
        *,
        tap_root: pathlib.Path,
        input_path: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != self.campaign["authority"][
            "guest_layout"
        ]["sha256"]:
            raise AssertionError("selection used the wrong guest layout")
        package = json.loads(input_path.read_text())["packages"][0]
        metadata_path = tap_root / "Kandelo/metadata.json"
        packages: list[dict[str, str]] = []
        if metadata_path.is_file():
            packages = json.loads(metadata_path.read_text())["packages"]
        packages.append({"name": package["name"]})
        write_json(metadata_path, {"packages": packages, "schema": 1})

    def validate_tap(
        self,
        *,
        tap_root: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != self.campaign["authority"][
            "guest_layout"
        ]["sha256"]:
            raise AssertionError("selection used the wrong guest layout")
        if not (tap_root / "Kandelo/metadata.json").is_file():
            raise AssertionError("selection validation lacked metadata")


class FinalTapFixture(Fixture):
    def __init__(self, *, active_retired_prefix: bool = False) -> None:
        super().__init__(multi_arch=True)
        layout_path = ROOT / "homebrew/kandelo-guest-layout.json"
        layout = json.loads(layout_path.read_text())
        self.retired_prefix = layout["retired_prefixes"][0]
        self.campaign["authority"]["guest_layout"]["sha256"] = sha256(
            layout_path.read_bytes()
        )

        gamma = self.source / "Formula/gamma.rb"
        gamma_payload = formula_source("gamma")
        if active_retired_prefix:
            gamma_payload += (
                f'# active path: {self.retired_prefix}\n'.encode()
            )
        gamma.write_bytes(gamma_payload)
        write_json(
            self.source / "Kandelo/prefix-campaign-authority.json",
            {"fixture": "retired after composition"},
        )
        manifest_path = (
            self.source / "Kandelo/campaigns/prefix-v1/manifest.json"
        )
        write_json(manifest_path, {"fixture": "sealed target source"})
        overlay_source = (
            self.source / "Kandelo/campaigns/prefix-v1/source"
        )
        (overlay_source / "Formula").mkdir(parents=True)
        (overlay_source / "Formula/alpha.rb").write_bytes(
            formula_source("alpha")
        )
        (self.source / "Kandelo/campaigns/prefix-v1/README.md").write_text(
            "Campaign completion evidence is retained here.\n"
        )
        (self.source / "Kandelo/campaigns/prefix-v1/verify.py").write_text(
            "# generic completion verifier fixture\n"
        )
        retained_test = (
            self.source
            / "Kandelo/formula_support/test/"
            "kandelo_formula_support_test.rb"
        )
        retained_test.parent.mkdir(parents=True)
        retained_test.write_text(
            f'# negative test rejects "{self.retired_prefix}"\n'
        )
        self.failure_evidence = (
            "historical failed publication at "
            f"{self.retired_prefix}\n"
        ).encode()
        self.rollback_evidence = (
            "historical rollback publication from "
            f"{self.retired_prefix}\n"
        ).encode()
        failure = (
            self.source / "Kandelo/reports/failures/alpha.json"
        )
        failure.parent.mkdir(parents=True)
        failure.write_bytes(self.failure_evidence)
        rollback = (
            self.source / "Kandelo/reports/rollbacks/beta.json"
        )
        rollback.parent.mkdir(parents=True)
        rollback.write_bytes(self.rollback_evidence)
        workflow = (
            self.source
            / ".github/workflows/prefix-campaign-bottles.yml"
        )
        workflow.parent.mkdir(parents=True)
        workflow.write_text("name: retired campaign publisher\n")
        materializer = self.source / "scripts/prefix-campaign-source.py"
        materializer.parent.mkdir(parents=True)
        materializer.write_text("# retained generic materializer fixture\n")

        self.source_tree = EXECUTOR.filesystem_git_tree_oid(
            self.source,
            "final tap fixture target source",
        )
        self.source_provenance = {
            "manifest_sha256": sha256(manifest_path.read_bytes()),
            "source_tree_git_oid": EXECUTOR.filesystem_git_tree_oid(
                overlay_source,
                "final tap fixture overlay source",
            ),
            "target_tree_git_oid": self.source_tree,
        }
        self.campaign["authority"]["source_materialization"] = {
            "authority": {
                "path": "Kandelo/prefix-campaign-authority.json",
                "sha256": sha256(
                    (
                        self.source
                        / "Kandelo/prefix-campaign-authority.json"
                    ).read_bytes()
                ),
            },
            "kind": "sealed-target-overlay-v1",
            "manifest": {
                "path": "Kandelo/campaigns/prefix-v1/manifest.json",
                "sha256": self.source_provenance[
                    "manifest_sha256"
                ],
            },
            "materializer": {
                "path": "scripts/prefix-campaign-source.py",
                "sha256": sha256(materializer.read_bytes()),
            },
            "source_root": "Kandelo/campaigns/prefix-v1/source",
            "source_tree_git_oid": self.source_provenance[
                "source_tree_git_oid"
            ],
            "target_tree_git_oid": self.source_tree,
        }
        write_json(self.campaign_path, self.campaign)

        self.live = self.root / "live-tap"
        self.live.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.live, check=True)
        (self.live / "README.md").write_text("live tap parent\n")
        subprocess.run(["git", "add", "."], cwd=self.live, check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Final tap fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-q",
                "-m",
                "live parent",
            ],
            cwd=self.live,
            check=True,
        )
        self.live_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.live,
            text=True,
        ).strip()
        self.live_tree = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=self.live,
            text=True,
        ).strip()
        self.pre_retirement_validated = False

    def complete_handoffs(
        self,
    ) -> tuple[pathlib.Path, pathlib.Path]:
        alpha = self.root / "final-alpha"
        self.derive(
            "alpha",
            [
                ("wasm32", self.publication("alpha", "wasm32")),
                ("wasm64", self.publication("alpha", "wasm64")),
            ],
            [],
            alpha,
        )
        beta = self.root / "final-beta"
        self.derive(
            "beta",
            [
                ("wasm32", self.publication("beta", "wasm32")),
                ("wasm64", self.publication("beta", "wasm64")),
            ],
            [alpha],
            beta,
        )
        return alpha, beta

    def generate_final_sidecars(
        self,
        *,
        tap_root: pathlib.Path,
        input_path: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != self.campaign["authority"][
            "guest_layout"
        ]["sha256"]:
            raise AssertionError("final tap used the wrong guest layout")
        name = json.loads(input_path.read_text())["packages"][0]["name"]
        metadata_path = tap_root / "Kandelo/metadata.json"
        names: set[str] = set()
        if metadata_path.is_file():
            names.update(
                value["name"]
                for value in json.loads(metadata_path.read_text())[
                    "packages"
                ]
            )
        names.add(name)
        write_json(
            metadata_path,
            {
                "packages": [
                    {"name": value} for value in sorted(names)
                ],
                "schema": 1,
            },
        )

    def validate_final_tap(
        self,
        *,
        tap_root: pathlib.Path,
        prefix_campaign_layout_sha256: str,
    ) -> None:
        if prefix_campaign_layout_sha256 != self.campaign["authority"][
            "guest_layout"
        ]["sha256"]:
            raise AssertionError("final tap used the wrong guest layout")
        if not (
            tap_root / "Kandelo/prefix-campaign-authority.json"
        ).is_file():
            raise AssertionError("whole-tap validation ran after retirement")
        if (
            tap_root / EXECUTOR.CAMPAIGN_COMPLETION_PATH
        ).exists():
            raise AssertionError("completion preceded whole-tap validation")
        for name in ("alpha", "beta"):
            formula = (tap_root / f"Formula/{name}.rb").read_text()
            for arch in ("wasm32", "wasm64"):
                if f"# {arch} bottle" not in formula:
                    raise AssertionError(
                        f"final tap lacks {name}/{arch} bottle"
                    )
        self.pre_retirement_validated = True

    def prepare_final(
        self,
        handoffs: list[pathlib.Path],
        output: pathlib.Path,
        finalization: pathlib.Path,
        **overrides: Any,
    ) -> None:
        arguments: dict[str, Any] = {
            "campaign_path": self.campaign_path,
            "source_tap_root": self.source,
            "live_tap_root": self.live,
            "handoff_roots": handoffs,
            "expected_live_commit": self.live_commit,
            "expected_live_tree_git_oid": self.live_tree,
            "output": output,
            "finalization_output": finalization,
            "bottle_merger": self.merge_dependency,
            "sidecar_generator": self.generate_final_sidecars,
            "tap_validator": self.validate_final_tap,
        }
        arguments.update(overrides)
        EXECUTOR.prepare_final_tap(**arguments)


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
    def test_historical_bottle_readback_is_credential_free(
        self,
    ) -> None:
        root = pathlib.Path(tempfile.mkdtemp(prefix="reuse-readback."))
        self.addCleanup(shutil.rmtree, root)
        output = root / "bottle.tar.gz"
        archive = b"public historical bottle\n"
        digest = sha256(archive)
        captured: dict[str, Any] = {}

        def run(command: list[str], **options: Any) -> Any:
            captured["command"] = command
            captured["options"] = options
            output.write_bytes(archive)
            return type("Result", (), {"returncode": 0})()

        credentials = {
            name: "must-not-reach-readback"
            for name in (
                "GH_TOKEN",
                "GITHUB_TOKEN",
                "HOMEBREW_GITHUB_API_TOKEN",
                "HOMEBREW_GITHUB_PACKAGES_TOKEN",
                "HOMEBREW_DOCKER_REGISTRY_TOKEN",
            )
        }
        with mock.patch.dict(
            EXECUTOR.os.environ, credentials
        ), mock.patch.object(
            EXECUTOR.subprocess,
            "run",
            side_effect=run,
        ):
            EXECUTOR.anonymous_bottle_readback(
                "https://ghcr.io/v2/kandelo-dev/"
                f"homebrew-tap-core/alpha/blobs/sha256:{digest}",
                output,
                len(archive),
                digest,
            )

        environment = captured["options"]["env"]
        self.assertTrue(credentials.keys().isdisjoint(environment))
        self.assertEqual(
            captured["command"][0:3], ["npx", "--no-install", "tsx"]
        )
        self.assertIn(
            "scripts/homebrew-verify-public-bottle.ts",
            captured["command"][3],
        )

    def test_reuse_handoff_preserves_provenance_and_round_trips(
        self,
    ) -> None:
        fixture = ReuseFixture()
        self.addCleanup(fixture.close)
        handoff = fixture.root / "reuse-handoff"
        fixture.derive_reuse(handoff)

        self.assertEqual(fixture.fetches, [fixture.old_record["url"]])
        manifest = json.loads((handoff / "handoff.json").read_text())
        self.assertEqual(manifest["schema"], EXECUTOR.HANDOFF_SCHEMA)
        self.assertEqual(
            manifest["publications"],
            [
                {
                    "arch": "wasm32",
                    "files": manifest["publications"][0]["files"],
                    "kind": "reuse",
                }
            ],
        )
        self.assertEqual(
            [
                value["path"]
                for value in manifest["publications"][0]["files"]
            ],
            [
                f"payload/wasm32/{relative}"
                for relative in EXECUTOR.REUSE_PUBLICATION_FILES
            ],
        )
        composition = json.loads(
            (
                handoff
                / "payload/wasm32/composition/sidecars-input.json"
            ).read_text()
        )
        bottle = composition["packages"][0]["bottles"][0]
        self.assertEqual(
            bottle["built_from"], fixture.old_record["built_from"]
        )
        self.assertNotEqual(
            bottle["built_from"]["formula_sha256"],
            fixture.formulae[0]["variants"][0]["old_formula_source"][
                "identity_excluding_bottle_sha256"
            ],
        )
        self.assertEqual(
            composition["kandelo_commit"], KANDELO_COMMIT
        )
        self.assertNotEqual(
            bottle["built_from"]["kandelo_commit"],
            composition["kandelo_commit"],
        )

        prepared = fixture.root / "reuse-release"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=handoff,
            dependency_roots=[],
            output=prepared,
        )
        release = json.loads(
            (prepared / "release-manifest.json").read_text()
        )
        self.assertEqual(
            [value["name"] for value in release["assets"]],
            sorted(
                [
                    "handoff.json",
                    *[
                        EXECUTOR.publication_asset_name(
                            "wasm32", relative
                        )
                        for relative in EXECUTOR.REUSE_PUBLICATION_FILES
                    ],
                ]
            ),
        )
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        readback = fixture.root / "reuse-readback"
        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=release["tag"],
            output=readback,
            receipt_output=fixture.root / "reuse-receipt.json",
            dependency_roots=[],
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        self.assertEqual(
            (
                readback / "payload/wasm32/reuse/bottle.tar.gz"
            ).read_bytes(),
            fixture.archive,
        )

        selection = fixture.root / "reuse-selection"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha"],
            arch="wasm32",
            handoff_roots=[readback],
            output=selection,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )
        self.assertIn(
            fixture.old_record["sha256"],
            (selection / "tap/Formula/alpha.rb").read_text(),
        )

    def test_reuse_admission_rejects_untrusted_or_ambiguous_inputs(
        self,
    ) -> None:
        def required_rebuild(fixture: ReuseFixture) -> None:
            variant = fixture.formulae[0]["variants"][0]
            variant["disposition"] = {
                "kind": "required-rebuild",
                "reasons": ["fixture"],
            }
            write_json(fixture.campaign_path, fixture.campaign)

        def private_url(fixture: ReuseFixture) -> None:
            variant = fixture.formulae[0]["variants"][0]
            private = "https://example.invalid/private/bottle"
            variant["old_record"]["url"] = private
            variant["anonymous_readback"]["url"] = private
            variant["old_record_sha256"] = sha256(
                EXECUTOR.canonical_json(variant["old_record"])
            )
            write_json(fixture.campaign_path, fixture.campaign)

        def retired_bytes(fixture: ReuseFixture) -> None:
            fixture.formulae[0]["variants"][0]["inspection"][
                "retired_prefixes"
            ] = ["/home/linuxbrew/.linuxbrew"]
            write_json(fixture.campaign_path, fixture.campaign)

        def substituted_producer(fixture: ReuseFixture) -> None:
            variant = fixture.formulae[0]["variants"][0]
            variant["old_record"]["built_from"]["tap_commit"] = "f" * 40
            variant["old_record_sha256"] = sha256(
                EXECUTOR.canonical_json(variant["old_record"])
            )
            write_json(fixture.campaign_path, fixture.campaign)

        def ambiguous_record(fixture: ReuseFixture) -> None:
            variant = fixture.formulae[0]["variants"][0]
            variant["old_record"]["unreviewed"] = True
            variant["old_record_sha256"] = sha256(
                EXECUTOR.canonical_json(variant["old_record"])
            )
            write_json(fixture.campaign_path, fixture.campaign)

        def stale_destination(fixture: ReuseFixture) -> None:
            fixture.formulae[0]["destination"]["bottle_rebuild"] = 0
            write_json(fixture.campaign_path, fixture.campaign)

        cases = (
            ("required rebuild", required_rebuild, "not admitted"),
            ("private URL", private_url, "bottle identity is invalid"),
            (
                "retired bytes",
                retired_bytes,
                "does not admit byte-clean reuse",
            ),
            (
                "substituted producer",
                substituted_producer,
                "old Formula source is substituted",
            ),
            (
                "ambiguous old record",
                ambiguous_record,
                "old bottle record is ambiguous",
            ),
            (
                "non-advancing destination",
                stale_destination,
                "reuse destination does not advance rebuild",
            ),
        )
        for label, mutate, message in cases:
            with self.subTest(label=label):
                fixture = ReuseFixture()
                try:
                    mutate(fixture)
                    output = fixture.root / "rejected-reuse"
                    with self.assertRaisesRegex(
                        EXECUTOR.ExecutorError, message
                    ):
                        fixture.derive_reuse(output)
                    self.assertFalse(output.exists())
                    self.assertEqual(fixture.fetches, [])
                finally:
                    fixture.close()

    def test_reuse_rejects_mutable_evidence_and_wrong_public_bytes(
        self,
    ) -> None:
        dirty = ReuseFixture()
        self.addCleanup(dirty.close)
        (
            dirty.old_tap
            / "Kandelo/reports/alpha-1.0-rebuild0-wasm32.provenance.json"
        ).write_text("{}\n")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError, "historical tap input worktree is dirty"
        ):
            dirty.derive_reuse(dirty.root / "dirty-output")

        substituted = ReuseFixture()
        self.addCleanup(substituted.close)
        provenance = (
            substituted.old_tap
            / "Kandelo/reports/alpha-1.0-rebuild0-wasm32.provenance.json"
        )
        value = json.loads(provenance.read_text())
        value["build"]["job"] = "substituted"
        write_json(provenance, value)
        substituted.campaign["authority"]["old_tap_commit"] = (
            substituted.commit_old_tap("substitute provenance")
        )
        write_json(substituted.campaign_path, substituted.campaign)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError, "differs from its campaign digest"
        ):
            substituted.derive_reuse(
                substituted.root / "substituted-output"
            )

        wrong = ReuseFixture()
        self.addCleanup(wrong.close)

        def wrong_fetch(
            _url: str,
            output: pathlib.Path,
            _expected_bytes: int,
            _expected_sha256: str,
        ) -> None:
            output.write_bytes(b"wrong public bytes")

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "anonymous bottle bytes changed|byte count differs",
        ):
            EXECUTOR.derive_reuse(
                campaign_path=wrong.campaign_path,
                source_tap_root=wrong.source,
                old_tap_root=wrong.old_tap,
                formula_name="alpha",
                arch="wasm32",
                dependency_roots=[],
                output=wrong.root / "wrong-output",
                asset_fetcher=wrong_fetch,
            )

    def test_reuse_readback_rejects_rewritten_composition(
        self,
    ) -> None:
        fixture = ReuseFixture()
        self.addCleanup(fixture.close)
        handoff = fixture.root / "tampered-reuse"
        fixture.derive_reuse(handoff)
        composition_path = (
            handoff / "payload/wasm32/composition/sidecars-input.json"
        )
        composition = json.loads(composition_path.read_text())
        composition["packages"][0]["bottles"][0]["built_from"][
            "kandelo_commit"
        ] = KANDELO_COMMIT
        write_json(composition_path, composition)
        manifest_path = handoff / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        record = next(
            value
            for value in manifest["publications"][0]["files"]
            if value["path"].endswith(
                "composition/sidecars-input.json"
            )
        )
        record["bytes"] = composition_path.stat().st_size
        record["sha256"] = sha256(composition_path.read_bytes())
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "reuse sidecars input is substituted",
        ):
            EXECUTOR.load_handoff(
                handoff,
                fixture.campaign,
                fixture.campaign_path.read_bytes(),
            )

    def test_final_tap_composes_complete_campaign_and_canonical_receipt(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        output = fixture.root / "final-candidate"
        finalization_path = fixture.root / "finalization.json"
        merge_order: list[tuple[str, str]] = []

        def record_merge(**arguments: Any) -> None:
            merge_order.append(
                (arguments["formula"], arguments["arch"])
            )
            fixture.merge_dependency(**arguments)

        fixture.prepare_final(
            [beta, alpha],
            output,
            finalization_path,
            bottle_merger=record_merge,
        )

        self.assertEqual(
            merge_order,
            [
                ("alpha", "wasm32"),
                ("alpha", "wasm64"),
                ("beta", "wasm32"),
                ("beta", "wasm64"),
            ],
        )
        self.assertTrue(fixture.pre_retirement_validated)
        self.assertTrue((output / "Formula/gamma.rb").is_file())
        for relative in EXECUTOR.CAMPAIGN_RETIREMENT_PATHS:
            self.assertFalse((output / relative).exists())
        for relative in (
            "Kandelo/campaigns/prefix-v1/README.md",
            "Kandelo/campaigns/prefix-v1/verify.py",
            "Kandelo/formula_support/test/"
            "kandelo_formula_support_test.rb",
            "scripts/prefix-campaign-source.py",
        ):
            self.assertTrue((output / relative).is_file(), relative)
        self.assertEqual(
            (
                output / "Kandelo/reports/failures/alpha.json"
            ).read_bytes(),
            fixture.failure_evidence,
        )
        self.assertEqual(
            (
                output / "Kandelo/reports/rollbacks/beta.json"
            ).read_bytes(),
            fixture.rollback_evidence,
        )

        completion_path = output / EXECUTOR.CAMPAIGN_COMPLETION_PATH
        completion = json.loads(completion_path.read_text())
        self.assertEqual(
            set(completion),
            {
                "campaign",
                "campaign_release",
                "catalog_cohort_sha256",
                "expected_parent_commit",
                "guest_layout_sha256",
                "handoffs_sha256",
                "kind",
                "schema",
                "source",
            },
        )
        self.assertEqual(completion["campaign"], "prefix-v1")
        self.assertEqual(
            completion["expected_parent_commit"],
            fixture.live_commit,
        )
        self.assertEqual(completion["source"], fixture.source_provenance)
        self.assertEqual(
            completion_path.read_bytes(),
            EXECUTOR.pretty_json(completion),
        )

        finalization = json.loads(finalization_path.read_text())
        self.assertEqual(
            set(finalization),
            {
                "campaign_release",
                "candidate",
                "catalog_cohort_sha256",
                "completion",
                "expected_live",
                "guest_layout_sha256",
                "handoffs",
                "handoffs_sha256",
                "kind",
                "schema",
            },
        )
        self.assertEqual(
            finalization_path.read_bytes(),
            EXECUTOR.pretty_json(finalization),
        )
        self.assertEqual(
            [value["formula"] for value in finalization["handoffs"]],
            ["alpha", "beta"],
        )
        self.assertEqual(
            [value["arches"] for value in finalization["handoffs"]],
            [["wasm32", "wasm64"], ["wasm32", "wasm64"]],
        )
        self.assertEqual(
            finalization["handoffs_sha256"],
            sha256(EXECUTOR.canonical_json(finalization["handoffs"])),
        )
        self.assertEqual(
            finalization["catalog_cohort_sha256"],
            sha256(
                EXECUTOR.canonical_json(
                    {
                        "campaign_sha256": sha256(
                            fixture.campaign_path.read_bytes()
                        ),
                        "guest_layout_sha256": fixture.campaign[
                            "authority"
                        ]["guest_layout"]["sha256"],
                        "handoffs": finalization["handoffs"],
                    }
                )
            ),
        )
        self.assertEqual(
            finalization["candidate"]["tree_git_oid"],
            EXECUTOR.filesystem_git_tree_oid(
                output,
                "completed final tap fixture",
            ),
        )
        self.assertEqual(
            finalization["completion"],
            {
                "path": EXECUTOR.CAMPAIGN_COMPLETION_PATH,
                "sha256": sha256(completion_path.read_bytes()),
            },
        )
        self.assertEqual(
            finalization["expected_live"],
            {
                "commit": fixture.live_commit,
                "tree_git_oid": fixture.live_tree,
            },
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "status", "--porcelain=v1"],
                cwd=fixture.live,
            ),
            b"",
        )
        self.assertFalse((output / ".git").exists())

    def test_final_tap_requires_one_complete_handoff_per_formula(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        partial_alpha = fixture.root / "partial-final-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            partial_alpha,
        )
        cases = (
            (
                "missing",
                [alpha],
                "handoffs differ from the campaign Formulae",
            ),
            (
                "duplicate",
                [alpha, alpha, beta],
                "handoff alpha is duplicated",
            ),
            (
                "partial",
                [partial_alpha, beta],
                "does not cover every declared architecture",
            ),
        )
        for label, handoffs, message in cases:
            with self.subTest(label=label):
                output = fixture.root / f"rejected-{label}"
                receipt = fixture.root / f"rejected-{label}.json"
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    message,
                ):
                    fixture.prepare_final(
                        handoffs,
                        output,
                        receipt,
                    )
                self.assertFalse(output.exists())
                self.assertFalse(receipt.exists())

    def test_final_tap_rejects_wrong_dependency_or_live_authority(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        substituted_beta = fixture.root / "substituted-beta"
        shutil.copytree(beta, substituted_beta)
        manifest_path = substituted_beta / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["dependency_handoffs"][0].update(
            {
                "manifest_sha256": "f" * 64,
                "tag": f"homebrew-prefix-handoff-sha256-{'f' * 64}",
            }
        )
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependencies differ from the exact campaign closure",
        ):
            fixture.prepare_final(
                [alpha, substituted_beta],
                fixture.root / "wrong-dependency",
                fixture.root / "wrong-dependency.json",
            )

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "wrong Git tree",
        ):
            fixture.prepare_final(
                [alpha, beta],
                fixture.root / "wrong-live-tree",
                fixture.root / "wrong-live-tree.json",
                expected_live_tree_git_oid="f" * 40,
            )
        (fixture.live / "dirty").write_text("uncommitted\n")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "worktree is dirty",
        ):
            fixture.prepare_final(
                [alpha, beta],
                fixture.root / "dirty-live",
                fixture.root / "dirty-live.json",
            )

    def test_final_tap_rebinds_sealed_source_and_live_parent(
        self,
    ) -> None:
        changed_source = FinalTapFixture()
        self.addCleanup(changed_source.close)
        alpha, beta = changed_source.complete_handoffs()
        (changed_source.source / "Formula/gamma.rb").write_text(
            "changed after campaign sealing\n"
        )
        source_output = changed_source.root / "changed-source-candidate"
        source_receipt = changed_source.root / "changed-source.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its sealed Git tree",
        ):
            changed_source.prepare_final(
                [alpha, beta],
                source_output,
                source_receipt,
            )
        self.assertFalse(source_output.exists())
        self.assertFalse(source_receipt.exists())

        changed_live = FinalTapFixture()
        self.addCleanup(changed_live.close)
        alpha, beta = changed_live.complete_handoffs()

        def change_live_during_validation(**arguments: Any) -> None:
            changed_live.validate_final_tap(**arguments)
            (changed_live.live / "concurrent-change").write_text(
                "changed while preparing\n"
            )

        live_output = changed_live.root / "changed-live-candidate"
        live_receipt = changed_live.root / "changed-live.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "worktree is dirty",
        ):
            changed_live.prepare_final(
                [alpha, beta],
                live_output,
                live_receipt,
                tap_validator=change_live_during_validation,
            )
        self.assertFalse(live_output.exists())
        self.assertFalse(live_receipt.exists())

    def test_final_tap_rejects_active_retired_prefix_bytes(
        self,
    ) -> None:
        fixture = FinalTapFixture(active_retired_prefix=True)
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        output = fixture.root / "retired-prefix-candidate"
        receipt = fixture.root / "retired-prefix-finalization.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "still contains retired guest prefixes.*Formula/gamma.rb",
        ):
            fixture.prepare_final([alpha, beta], output, receipt)
        self.assertFalse(output.exists())
        self.assertFalse(receipt.exists())

    def test_final_tap_preserves_historical_report_evidence(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()

        def mutate_history(**arguments: Any) -> None:
            fixture.generate_final_sidecars(**arguments)
            (
                pathlib.Path(arguments["tap_root"])
                / "Kandelo/reports/failures/alpha.json"
            ).write_text("rewritten history\n")

        output = fixture.root / "rewritten-history-candidate"
        receipt = fixture.root / "rewritten-history-finalization.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "changed historical report evidence",
        ):
            fixture.prepare_final(
                [alpha, beta],
                output,
                receipt,
                sidecar_generator=mutate_history,
            )
        self.assertFalse(output.exists())
        self.assertFalse(receipt.exists())

    def test_prepare_final_tap_cli_exposes_local_only_authorities(
        self,
    ) -> None:
        arguments = [
            str(TOOL),
            "prepare-final-tap",
            "--campaign",
            "campaign.json",
            "--source-tap-root",
            "source",
            "--live-tap-root",
            "live",
            "--handoff",
            "alpha",
            "--expected-live-commit",
            "a" * 40,
            "--expected-live-tree-git-oid",
            "b" * 40,
            "--out",
            "candidate",
            "--finalization-out",
            "finalization.json",
        ]
        with mock.patch.object(sys, "argv", arguments):
            parsed = EXECUTOR.parse_args()
        self.assertEqual(parsed.command, "prepare-final-tap")
        self.assertEqual(parsed.handoff, ["alpha"])
        self.assertEqual(parsed.finalization_out, "finalization.json")

        commit_arguments = [
            str(TOOL),
            "create-final-tap-commit",
            "--candidate-tap-root",
            "candidate",
            "--finalization",
            "finalization.json",
            "--live-tap-root",
            "live",
            "--output-ref",
            "refs/heads/final-prefix",
            "--commit-receipt-out",
            "commit.json",
        ]
        with mock.patch.object(sys, "argv", commit_arguments):
            parsed_commit = EXECUTOR.parse_args()
        self.assertEqual(
            parsed_commit.command,
            "create-final-tap-commit",
        )
        self.assertEqual(
            parsed_commit.output_ref,
            "refs/heads/final-prefix",
        )

    def test_final_tap_requires_every_retirement_path(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        (
            fixture.source
            / ".github/workflows/prefix-campaign-bottles.yml"
        ).unlink()
        fixture.source_tree = EXECUTOR.filesystem_git_tree_oid(
            fixture.source,
            "missing retirement path target",
        )
        fixture.campaign["authority"]["source_materialization"][
            "target_tree_git_oid"
        ] = fixture.source_tree
        write_json(fixture.campaign_path, fixture.campaign)
        alpha, beta = fixture.complete_handoffs()
        output = fixture.root / "missing-retirement-candidate"
        receipt = fixture.root / "missing-retirement-finalization.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "campaign retirement path.*prefix-campaign-bottles.*"
            "unavailable",
        ):
            fixture.prepare_final([alpha, beta], output, receipt)
        self.assertFalse(output.exists())
        self.assertFalse(receipt.exists())

    def test_create_final_tap_commit_uses_one_new_local_ref(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        candidate = fixture.root / "commit-candidate"
        finalization = fixture.root / "commit-finalization.json"
        fixture.prepare_final([alpha, beta], candidate, finalization)
        before_refs = subprocess.check_output(
            ["git", "for-each-ref", "--format=%(refname)"],
            cwd=fixture.live,
            text=True,
        ).splitlines()
        output_ref = "refs/heads/final-prefix-fixture"
        receipt_path = fixture.root / "commit-receipt.json"

        EXECUTOR.create_final_tap_commit(
            candidate_tap_root=candidate,
            finalization_path=finalization,
            live_tap_root=fixture.live,
            output_ref=output_ref,
            commit_receipt_output=receipt_path,
        )

        after_refs = subprocess.check_output(
            ["git", "for-each-ref", "--format=%(refname)"],
            cwd=fixture.live,
            text=True,
        ).splitlines()
        self.assertEqual(
            sorted(set(after_refs) - set(before_refs)),
            [output_ref],
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=fixture.live,
                text=True,
            ).strip(),
            fixture.live_commit,
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "status", "--porcelain=v1"],
                cwd=fixture.live,
            ),
            b"",
        )
        commit_oid = subprocess.check_output(
            ["git", "rev-parse", output_ref],
            cwd=fixture.live,
            text=True,
        ).strip()
        self.assertEqual(
            subprocess.check_output(
                ["git", "rev-parse", f"{commit_oid}^"],
                cwd=fixture.live,
                text=True,
            ).strip(),
            fixture.live_commit,
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "rev-parse", f"{commit_oid}^{{tree}}"],
                cwd=fixture.live,
                text=True,
            ).strip(),
            EXECUTOR.filesystem_git_tree_oid(candidate, "commit candidate"),
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "show", "-s", "--format=%at", commit_oid],
                cwd=fixture.live,
                text=True,
            ).strip(),
            str(EXECUTOR.CAMPAIGN_COMMIT_TIMESTAMP),
        )
        self.assertEqual(
            subprocess.check_output(
                ["git", "show", "-s", "--format=%B", commit_oid],
                cwd=fixture.live,
                text=True,
            ).rstrip("\n"),
            EXECUTOR.FINAL_TAP_COMMIT_MESSAGE.rstrip("\n"),
        )
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(
            receipt_path.read_bytes(),
            EXECUTOR.pretty_json(receipt),
        )
        self.assertEqual(
            set(receipt),
            {
                "candidate",
                "commit",
                "finalization",
                "kind",
                "output_ref",
                "schema",
            },
        )
        self.assertEqual(set(receipt["candidate"]), {"tree_git_oid"})
        self.assertEqual(
            set(receipt["commit"]),
            {"oid", "parent", "tree_git_oid"},
        )
        self.assertEqual(
            set(receipt["finalization"]),
            {"path", "sha256"},
        )
        self.assertEqual(
            receipt["finalization"]["path"],
            "finalization.json",
        )
        self.assertEqual(receipt["output_ref"], output_ref)
        self.assertEqual(receipt["commit"]["oid"], commit_oid)
        self.assertEqual(receipt["commit"]["parent"], fixture.live_commit)
        self.assertEqual(
            receipt["finalization"]["sha256"],
            sha256(finalization.read_bytes()),
        )

        subprocess.run(
            ["git", "update-ref", "-d", output_ref, commit_oid],
            cwd=fixture.live,
            check=True,
        )
        retry_receipt = fixture.root / "retry-commit-receipt.json"
        EXECUTOR.create_final_tap_commit(
            candidate_tap_root=candidate,
            finalization_path=finalization,
            live_tap_root=fixture.live,
            output_ref=output_ref,
            commit_receipt_output=retry_receipt,
        )
        retried = json.loads(retry_receipt.read_text())
        self.assertEqual(retried["commit"]["oid"], commit_oid)
        self.assertEqual(retried, receipt)

    def test_create_final_tap_commit_rejects_substitution_and_refs(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        candidate = fixture.root / "adversarial-commit-candidate"
        finalization = fixture.root / "adversarial-finalization.json"
        fixture.prepare_final([alpha, beta], candidate, finalization)
        existing_ref = subprocess.check_output(
            ["git", "symbolic-ref", "HEAD"],
            cwd=fixture.live,
            text=True,
        ).strip()

        for label, output_ref, message in (
            ("unsafe", "refs/tags/not-a-branch", "refs/heads"),
            ("existing", existing_ref, "already exists"),
        ):
            with self.subTest(label=label):
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    message,
                ):
                    EXECUTOR.create_final_tap_commit(
                        candidate_tap_root=candidate,
                        finalization_path=finalization,
                        live_tap_root=fixture.live,
                        output_ref=output_ref,
                        commit_receipt_output=(
                            fixture.root / f"{label}-commit.json"
                        ),
                    )

        substituted_finalization = fixture.root / "extra-finalization.json"
        finalization_value = json.loads(finalization.read_text())
        finalization_value["unreviewed"] = True
        write_json(substituted_finalization, finalization_value)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "must contain exactly",
        ):
            EXECUTOR.create_final_tap_commit(
                candidate_tap_root=candidate,
                finalization_path=substituted_finalization,
                live_tap_root=fixture.live,
                output_ref="refs/heads/substituted-finalization",
                commit_receipt_output=(
                    fixture.root / "substituted-finalization-commit.json"
                ),
            )

        (candidate / "substituted").write_text("not in receipt\n")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "candidate tree differs from finalization",
        ):
            EXECUTOR.create_final_tap_commit(
                candidate_tap_root=candidate,
                finalization_path=finalization,
                live_tap_root=fixture.live,
                output_ref="refs/heads/substituted-candidate",
                commit_receipt_output=(
                    fixture.root / "substituted-commit.json"
                ),
            )

    def test_create_final_tap_commit_ref_race_and_receipt_failure(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        candidate = fixture.root / "race-commit-candidate"
        finalization = fixture.root / "race-finalization.json"
        fixture.prepare_final([alpha, beta], candidate, finalization)
        output_ref = "refs/heads/raced-final-prefix"
        original_run_git = EXECUTOR.run_git
        injected = False

        def race_ref(
            root: pathlib.Path,
            arguments: list[str],
            label: str,
            **keywords: Any,
        ) -> bytes:
            nonlocal injected
            if label == "new final tap output ref" and not injected:
                injected = True
                subprocess.run(
                    [
                        "git",
                        "update-ref",
                        output_ref,
                        fixture.live_commit,
                        "0" * 40,
                    ],
                    cwd=fixture.live,
                    check=True,
                )
            return original_run_git(root, arguments, label, **keywords)

        with mock.patch.object(EXECUTOR, "run_git", side_effect=race_ref):
            with self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "cannot read new final tap output ref",
            ):
                EXECUTOR.create_final_tap_commit(
                    candidate_tap_root=candidate,
                    finalization_path=finalization,
                    live_tap_root=fixture.live,
                    output_ref=output_ref,
                    commit_receipt_output=fixture.root / "race-receipt.json",
                )
        self.assertEqual(
            subprocess.check_output(
                ["git", "rev-parse", output_ref],
                cwd=fixture.live,
                text=True,
            ).strip(),
            fixture.live_commit,
        )

        rollback_ref = "refs/heads/rollback-final-prefix"
        rollback_receipt = fixture.root / "rollback-commit-receipt.json"
        with mock.patch.object(
            EXECUTOR.os,
            "link",
            side_effect=OSError("injected receipt failure"),
        ):
            with self.assertRaisesRegex(OSError, "receipt failure"):
                EXECUTOR.create_final_tap_commit(
                    candidate_tap_root=candidate,
                    finalization_path=finalization,
                    live_tap_root=fixture.live,
                    output_ref=rollback_ref,
                    commit_receipt_output=rollback_receipt,
                )
        self.assertNotEqual(
            subprocess.run(
                ["git", "show-ref", "--verify", "--quiet", rollback_ref],
                cwd=fixture.live,
            ).returncode,
            0,
        )
        self.assertFalse(rollback_receipt.exists())

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
