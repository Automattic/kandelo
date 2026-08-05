#!/usr/bin/env python3
"""Adversarial tests for prefix-campaign Formula handoffs."""

from __future__ import annotations

import copy
import hashlib
import io
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import warnings
import zipfile
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
GUEST_LAYOUT_SHA256 = hashlib.sha256(
    (ROOT / "homebrew/kandelo-guest-layout.json").read_bytes()
).hexdigest()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(EXECUTOR.pretty_json(value))


def write_oci_json_blob(
    layout: pathlib.Path,
    value: Any,
    media_type: str,
) -> dict[str, Any]:
    payload = EXECUTOR.canonical_json(value)
    digest = sha256(payload)
    path = layout / "blobs/sha256" / digest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return {
        "digest": f"sha256:{digest}",
        "mediaType": media_type,
        "size": len(payload),
    }


def commit_repo(root: pathlib.Path, message: str) -> str:
    subprocess.run(["git", "add", "--all"], cwd=root, check=True)
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
        cwd=root,
        check=True,
    )
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        text=True,
    ).strip()


def formula_source(name: str) -> bytes:
    class_name = "".join(part.title() for part in name.split("-"))
    return (
        f"class {class_name} < Formula\n"
        '  desc "campaign executor fixture"\n'
        "\n"
        "end\n"
    ).encode()


def make_formula(
    name: str,
    version: str,
    dependencies: list[tuple[str, str]],
    arches: list[str],
    *,
    runtime_dependencies: list[tuple[str, str]] | None = None,
) -> dict[str, Any]:
    payload = formula_source(name)
    if runtime_dependencies is None:
        runtime_dependencies = dependencies
    return {
        "dependencies": [
            {
                "full_name": f"{TAP_NAME}/{dependency}",
                "version": dependency_version,
            }
            for dependency, dependency_version in dependencies
        ],
        "destination": {
            "admission": {
                "kind": "anonymous-absence",
                "method": "anonymous-oras-manifest-probe",
                "probe": {
                    "digest": None,
                    "kind": "manifest",
                    "schema": 1,
                    "status": "missing",
                },
                "schema": 1,
            },
            "bottle_rebuild": 0,
            "reference": version,
            "remote": f"ghcr.io/{TAP_REPOSITORY}/{name}",
        },
        "formula_source": {
            "identity_excluding_bottle_sha256": sha256(payload),
            "path": f"Formula/{name}.rb",
            "sha256": sha256(payload),
        },
        "name": name,
        "runtime_dependencies": [
            {
                "full_name": f"{TAP_NAME}/{dependency}",
                "version": dependency_version,
            }
            for dependency, dependency_version in runtime_dependencies
        ],
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
    def __init__(
        self,
        *,
        multi_arch: bool = False,
        scoped_beta_dependency: bool = False,
    ) -> None:
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
                runtime_dependencies=(
                    [] if scoped_beta_dependency else None
                ),
            ),
        ]
        self.campaign = {
            "authority": {
                "current_kandelo_abi": 42,
                "guest_layout": {
                    "path": "homebrew/kandelo-guest-layout.json",
                    "sha256": GUEST_LAYOUT_SHA256,
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
            "schema": 2,
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
        prepared_formula_digest = EXECUTOR.prepared_formula_sha256(
            self.source,
            self.campaign,
            package,
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
                    for value in package["runtime_dependencies"]
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
                                "formula_source_sha256": (
                                    prepared_formula_digest
                                ),
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
        if prefix_campaign_layout_sha256 != GUEST_LAYOUT_SHA256:
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
        if prefix_campaign_layout_sha256 != GUEST_LAYOUT_SHA256:
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
        archived_formula = (
            b'class Alpha < Formula\n'
            b'  desc "campaign executor fixture"\n'
            b'  bottle do\n'
            b'    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"\n'
            b'    sha256 cellar: :any, wasm32_kandelo: "'
            + b"0" * 64
            + b'"\n'
            b'  end\n'
            b'end\n'
        )
        receipt = EXECUTOR.canonical_json(
            {
                "arch": "wasm32",
                "built_on": {
                    "os": "Kandelo",
                    "os_version": "42",
                },
                "changed_files": None,
                "compiler": "clang",
                "homebrew_version": "Homebrew fixture",
                "runtime_dependencies": [],
                "source_modified_time": 0,
            }
        )
        archive_buffer = io.BytesIO()
        with tarfile.open(
            fileobj=archive_buffer,
            mode="w:gz",
            format=tarfile.PAX_FORMAT,
        ) as bottle:
            for path, payload, mode in (
                ("alpha/1.0/.brew/alpha.rb", archived_formula, 0o644),
                ("alpha/1.0/INSTALL_RECEIPT.json", receipt, 0o644),
                ("alpha/1.0/bin/alpha", b"#!/bin/sh\nexit 0\n", 0o755),
            ):
                member = tarfile.TarInfo(path)
                member.mode = mode
                member.mtime = 0
                member.size = len(payload)
                bottle.addfile(member, io.BytesIO(payload))
        archive = archive_buffer.getvalue()
        self.archive = archive
        digest = sha256(archive)
        source_formula_sha256 = sha256(formula_source("alpha"))
        source_formula_digest = subprocess.check_output(
            [
                "ruby",
                str(ROOT / "scripts/homebrew-formula-source-digest.rb"),
                "--identity-excluding-bottle",
                str(self.old_tap / "Formula/alpha.rb"),
            ],
            text=True,
        ).strip()
        self.formulae[0]["formula_source"][
            "identity_excluding_bottle_sha256"
        ] = source_formula_digest
        # Homebrew archives the Formula receipt that produced a bottle. Its
        # digest is independent from the current tap source identity, which
        # excludes mutable bottle blocks when deciding whether bytes can be
        # reused. Keep the fixture values distinct so admission cannot
        # accidentally substitute one provenance identity for the other.
        archived_formula_digest = sha256(archived_formula)
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
        alpha["destination"]["bottle_rebuild"] = 1
        alpha["destination"]["reference"] = "1.0-1"
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
                    "sha256": source_formula_sha256,
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


class PredecessorReuseFixture(Fixture):
    REQUIRED_UNCHANGED_TOOLS = (
        "host/src/homebrew-vfs-fetch.ts",
        "scripts/homebrew-formula-source-digest.rb",
        "scripts/homebrew-inspect-bottle.py",
        "scripts/homebrew-publication-limits.sh",
        "scripts/homebrew-validate-wasm-artifact.sh",
        "scripts/homebrew-verify-public-bottle.ts",
    )

    def __init__(
        self,
        *,
        dependent: bool = False,
        legacy_predecessor: bool = False,
        partial_multiarch: bool = False,
        prepared_formula_differs: bool = False,
        raw_predecessor_build_digest: bool = False,
        scoped_dependency: bool = False,
    ) -> None:
        super().__init__(
            multi_arch=partial_multiarch,
            scoped_beta_dependency=scoped_dependency,
        )
        self.raw_predecessor_build_digest = (
            raw_predecessor_build_digest
        )
        if prepared_formula_differs:
            prepared_target = (
                self.formulae[-1] if dependent else self.formulae[0]
            )
            name = prepared_target["name"]
            source = self.source / prepared_target["formula_source"]["path"]
            retired_prefix = json.loads(
                (ROOT / "homebrew/kandelo-guest-layout.json").read_text()
            )["retired_prefixes"][0]
            fixture_bottle_sha256 = "a" * 64
            payload = formula_source(name).replace(
                b"\nend\n",
                (
                    "\n  bottle do\n"
                    '    root_url "https://ghcr.io/v2/'
                    f'{TAP_REPOSITORY}/{name}"\n'
                    f'    sha256 cellar: "{retired_prefix}/Cellar", '
                    f'wasm32_kandelo: "{fixture_bottle_sha256}"\n'
                    "  end\n\n"
                    "end\n"
                ).encode(),
            )
            source.write_bytes(payload)
            prepared_target["destination"].update(
                {
                    "bottle_rebuild": 1,
                    "reference": f"{prepared_target['version']}-1",
                }
            )
            prepared_target["formula_source"].update(
                {
                    "identity_excluding_bottle_sha256": (
                        EXECUTOR.CAMPAIGN_FORMULA.formula_identity(
                            source,
                            repository_root=ROOT,
                        )
                    ),
                    "sha256": sha256(payload),
                }
            )
            self.source_tree = EXECUTOR.filesystem_git_tree_oid(
                self.source, "prepared Formula fixture target source"
            )
            self.campaign["authority"]["source_materialization"][
                "tree_git_oid"
            ] = self.source_tree
        self.partial_multiarch = partial_multiarch
        if not dependent:
            self.formulae = [self.formulae[0]]
        self.target_formula = self.formulae[-1]
        self.target_name = self.target_formula["name"]
        self.campaign["formulae"] = self.formulae
        self.campaign["authority"].update(
            {
                "abi_snapshot": {
                    "path": "abi/snapshot.json",
                    "sha256": "7" * 64,
                },
                "native_homebrew_commit": "8" * 40,
                "tools": {
                    path: sha256(path.encode())
                    for path in self.REQUIRED_UNCHANGED_TOOLS
                },
            }
        )
        self.predecessor = copy.deepcopy(self.campaign)
        if legacy_predecessor:
            for formula in self.predecessor["formulae"]:
                formula.pop("runtime_dependencies")
        self.predecessor["authority"]["kandelo_commit"] = "1" * 40
        self.predecessor_path = self.root / "predecessor-campaign.json"
        write_json(self.predecessor_path, self.predecessor)
        predecessor_payload = self.predecessor_path.read_bytes()
        self.predecessor_campaign_tag = (
            "homebrew-prefix-campaign-sha256-"
            + sha256(predecessor_payload)
        )
        self.predecessor_dependency_roots: list[pathlib.Path] = []
        if dependent:
            predecessor_dependency = (
                self.root / "predecessor-alpha-handoff"
            )
            self._derive_alpha_dependency(
                campaign_path=self.predecessor_path,
                output=predecessor_dependency,
            )
            self.predecessor_dependency_roots.append(
                predecessor_dependency
            )
        self.predecessor_handoff = self.root / "predecessor-handoff"
        self.archive = (
            f"{self.target_name} predecessor bottle\n".encode()
        )
        self.archive_sha256 = sha256(self.archive)
        self._write_predecessor_handoff()
        predecessor_handoff_payload = (
            self.predecessor_handoff / "handoff.json"
        ).read_bytes()
        self.predecessor_handoff_tag = EXECUTOR.handoff_tag(
            predecessor_handoff_payload
        )

        self.campaign["schema"] = 3
        self.campaign["authority"]["kandelo_commit"] = "2" * 40
        self.campaign["authority"]["predecessor_recovery_source"] = {
            "commit": "9" * 40,
            "repository": TAP_REPOSITORY,
        }
        self.campaign["authority"]["predecessor_recovery"] = [
            {
                "activation_commit": "3" * 40,
                "archive": {
                    "path": (
                        "Kandelo/campaigns/prefix-v1/"
                        "aborted-campaigns/"
                        f"{sha256(predecessor_payload)}.json"
                    ),
                    "sha256": "4" * 64,
                },
                "campaign": {
                    "sha256": sha256(predecessor_payload),
                    "tag": self.predecessor_campaign_tag,
                },
                "kandelo_commit": "1" * 40,
                "source_tap_commit": SOURCE_TAP_COMMIT,
                "target_tree_git_oid": self.source_tree,
            }
        ]
        formula = self.target_formula
        formula["destination"]["admission"] = (
            {
                "kind": "archived-predecessor-exact-presence",
                "method": "anonymous-oras-public-index-probe",
                "probe": {
                    "children": [
                        {
                            "arch": "wasm32",
                            "bottle_sha256": "5" * 64,
                            "bottle_size": 1,
                            "homebrew_ref": "1.0.wasm32_kandelo.1",
                            "manifest_digest": "sha256:" + "5" * 64,
                            "manifest_size": 1,
                        }
                    ],
                    "digest": "sha256:" + "5" * 64,
                    "kind": "public-index",
                    "schema": 1,
                    "size": 1,
                    "status": "present",
                },
                "schema": 2,
            }
            if partial_multiarch
            else {
                "kind": "archived-predecessor-exact-presence",
                "method": "anonymous-oras-manifest-probe",
                "probe": {
                    "digest": "sha256:" + "5" * 64,
                    "kind": "manifest",
                    "schema": 1,
                    "status": "present",
                },
                "schema": 1,
            }
        )
        formula["variants"][0]["reuse_source"] = {
            "arch": "wasm32",
            "campaign_tag": self.predecessor_campaign_tag,
            "handoff_tag": self.predecessor_handoff_tag,
            "kind": "predecessor-handoff",
        }
        write_json(self.campaign_path, self.campaign)
        self.dependency_roots: list[pathlib.Path] = []
        if dependent:
            dependency = self.root / "successor-alpha-handoff"
            self._derive_alpha_dependency(
                campaign_path=self.campaign_path,
                output=dependency,
            )
            self.dependency_roots.append(dependency)

        self.public_destination_layout: pathlib.Path | None = None
        self.destination_imports: list[list[str]] = []
        self.source_closure_requests: list[list[str]] = []
        self.source_closure_sha256 = "6" * 64
        self.current_source_closure_sha256 = self.source_closure_sha256

    def _derive_alpha_dependency(
        self,
        *,
        campaign_path: pathlib.Path,
        output: pathlib.Path,
        archive_payload: bytes | None = None,
    ) -> None:
        publication = self.publication("alpha", "wasm32")
        if archive_payload is not None:
            archive = publication / "build/bottle.tar.gz"
            archive.write_bytes(archive_payload)
            bottle_json = publication / "build/bottle.json"
            value = json.loads(bottle_json.read_text())
            value[f"{TAP_NAME}/alpha"]["bottle"]["tags"][
                "wasm32_kandelo"
            ]["sha256"] = sha256(archive_payload)
            write_json(bottle_json, value)
        EXECUTOR.derive_build(
            campaign_path=campaign_path,
            source_tap_root=self.source,
            formula_name="alpha",
            publications=[("wasm32", publication)],
            dependency_roots=[],
            output=output,
            validator=lambda *_arguments: None,
            dependency_merger=self.merge_dependency,
        )

    def _write_predecessor_handoff(self) -> None:
        formula = self.target_formula
        name = self.target_name
        arch = "wasm32"
        prepared_formula_digest = EXECUTOR.prepared_formula_sha256(
            self.source,
            self.predecessor,
            formula,
        )
        publication = self.predecessor_handoff / f"payload/{arch}"
        layout = EXECUTOR.campaign_guest_layout(self.predecessor)
        archive = publication / "build/bottle.tar.gz"
        archive.parent.mkdir(parents=True)
        archive.write_bytes(self.archive)
        write_json(
            publication / "build/bottle.json",
            EXECUTOR.reuse_bottle_json(
                self.predecessor,
                formula,
                arch,
                self.archive_sha256,
                layout,
            ),
        )
        write_json(
            publication / "composition/sidecars-input.json",
            {
                "generated_at": "2026-08-03T00:00:00Z",
                "generator": "predecessor build fixture",
                "kandelo_abi": 42,
                "kandelo_commit": "1" * 40,
                "kandelo_repository": "Automattic/kandelo",
                "packages": [
                    {
                        "bottle_rebuild": formula["destination"][
                            "bottle_rebuild"
                        ],
                        "bottles": [
                            {
                                "arch": arch,
                                "archived_formula_sha256": (
                                    formula["formula_source"]["sha256"]
                                ),
                                "bottle_file": "../build/bottle.tar.gz",
                                "bottle_tag": "wasm32_kandelo",
                                "browser_compatible": False,
                                "build": {"fixture": "build"},
                                "built_at": "2026-08-03T00:00:00Z",
                                "built_by": "https://example.invalid/run/1",
                                "cache_key_sha": self.archive_sha256,
                                "cellar": layout["cellar"],
                                "env": {"PATH_prepend": ["bin"]},
                                "fork_instrumentation": "not-required",
                                "keg": (
                                    f"{layout['cellar']}/{name}/"
                                    f"{formula['version']}"
                                ),
                                "links": [
                                    {
                                        "source": f"bin/{name}",
                                        "target": f"bin/{name}",
                                        "type": "symlink",
                                    }
                                ],
                                "payload_root": (
                                    f"{name}/{formula['version']}"
                                ),
                                "prefix": layout["prefix"],
                                "receipts": ["INSTALL_RECEIPT.json"],
                                "runtime_support": ["node"],
                                "status": "success",
                                "url": (
                                    "https://ghcr.io/v2/"
                                    f"{TAP_REPOSITORY}/{name}/blobs/"
                                    f"sha256:{self.archive_sha256}"
                                ),
                                "validation": {"fixture": "validation"},
                            }
                        ],
                        "dependencies": [
                            {
                                "full_name": dependency["full_name"],
                                "name": dependency["full_name"].rsplit(
                                    "/", 1
                                )[1],
                                "version": dependency["version"],
                            }
                            for dependency in formula[
                                "runtime_dependencies"
                            ]
                        ],
                        "formula_path": f"Formula/{name}.rb",
                        "formula_revision": 0,
                        "formula_source_sha256": (
                            formula["formula_source"]["sha256"]
                            if self.raw_predecessor_build_digest
                            else prepared_formula_digest
                        ),
                        "full_name": f"{TAP_NAME}/{name}",
                        "name": name,
                        "version": formula["version"],
                    }
                ],
                "release_tag": "bottles-abi-v42",
                "schema": 1,
                "tap_commit": SOURCE_TAP_COMMIT,
                "tap_name": TAP_NAME,
                "tap_repository": TAP_REPOSITORY,
            },
        )
        for relative in (
            "build/dependency-provenance.json",
            "build/manifest.json",
            "receipt.json",
        ):
            write_json(publication / relative, {"fixture": relative})
        records = [
            EXECUTOR.file_record(
                publication / relative,
                f"payload/{arch}/{relative}",
                EXECUTOR.publication_asset_name(arch, relative),
            )
            for relative in EXECUTOR.BUILD_PUBLICATION_FILES
        ]
        predecessor_payload = self.predecessor_path.read_bytes()
        predecessor_index = {
            value["name"]: value
            for value in self.predecessor["formulae"]
        }
        dependency_records, _identities, _loaded = (
            EXECUTOR.load_dependency_handoff_set(
                self.predecessor_dependency_roots,
                self.predecessor,
                predecessor_payload,
                predecessor_index,
                name,
                (arch,),
            )
        )
        write_json(
            self.predecessor_handoff / "handoff.json",
            {
                "campaign": {"sha256": sha256(predecessor_payload)},
                "dependency_handoffs": dependency_records,
                "formula": EXECUTOR.campaign_formula_evidence(
                    self.predecessor, formula
                ),
                "kind": "kandelo-homebrew-prefix-formula-handoff",
                "publications": [
                    {"arch": arch, "files": records, "kind": "build"}
                ],
                "schema": EXECUTOR.HANDOFF_SCHEMA,
                "source": {
                    "kandelo_commit": "1" * 40,
                    "source_tap_commit": SOURCE_TAP_COMMIT,
                    "target_tree_git_oid": self.source_tree,
                    "tap_name": TAP_NAME,
                    "tap_repository": TAP_REPOSITORY,
                },
            },
        )
        EXECUTOR.load_handoff(
            self.predecessor_handoff,
            self.predecessor,
            predecessor_payload,
        )

    def destination_verifier(
        self,
        campaign: dict[str, Any],
        formula: dict[str, Any],
        arch: str,
        source_tap_root: pathlib.Path,
        archive_record: dict[str, Any],
        extracted: dict[str, Any],
    ) -> dict[str, str]:
        del arch, source_tap_root, extracted
        if (
            campaign != self.campaign
            or formula != self.target_formula
            or archive_record["sha256"] != self.archive_sha256
        ):
            raise AssertionError("destination verifier received substitution")
        destination = formula["destination"]
        result = {
            "reference": destination["reference"],
            "remote": destination["remote"],
            "source_closure_sha256": "6" * 64,
        }
        if destination["admission"]["schema"] == 2:
            result.update(
                {
                    "admission_manifest_digest": destination[
                        "admission"
                    ]["probe"]["digest"],
                    "observed_manifest_digest": destination[
                        "admission"
                    ]["probe"]["digest"],
                }
            )
        else:
            result["manifest_digest"] = destination["admission"][
                "probe"
            ]["digest"]
        return result

    def install_public_destination(
        self,
        *,
        include_wasm64: bool = False,
        layer_payload: bytes | None = None,
        observed_child_source_closure_sha256: str | None = None,
        observed_source_closure_sha256: str | None = None,
    ) -> None:
        formula = self.target_formula
        authority = self.campaign["authority"]
        destination = formula["destination"]
        source_closure_sha256 = self.source_closure_sha256
        semantic_annotations = {
            "dev.kandelo.homebrew.abi": str(
                authority["current_kandelo_abi"]
            ),
            "dev.kandelo.homebrew.bottle_rebuild": str(
                destination["bottle_rebuild"]
            ),
            "dev.kandelo.homebrew.formula": self.target_name,
            "dev.kandelo.homebrew.formula_revision": "0",
            (
                "dev.kandelo.homebrew."
                "formula_source_identity_sha256"
            ): formula["formula_source"][
                "identity_excluding_bottle_sha256"
            ],
            "dev.kandelo.homebrew.pkg_version": formula["version"],
            "dev.kandelo.homebrew.source_closure_sha256": (
                source_closure_sha256
            ),
            "dev.kandelo.homebrew.tap_repository": authority[
                "tap_repository"
            ].lower(),
        }
        layout = self.root / "public-destination-layout"
        blobs = layout / "blobs/sha256"
        blobs.mkdir(parents=True)
        config = write_oci_json_blob(
            layout,
            {},
            "application/vnd.oci.image.config.v1+json",
        )
        if layer_payload is None:
            layer_payload = self.archive
        layer_sha256 = sha256(layer_payload)
        (blobs / layer_sha256).write_bytes(layer_payload)
        layer = {
            "annotations": {},
            "digest": f"sha256:{layer_sha256}",
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "size": len(layer_payload),
        }
        child = write_oci_json_blob(
            layout,
            {
                "annotations": semantic_annotations,
                "config": config,
                "layers": [layer],
                "mediaType": (
                    "application/vnd.oci.image.manifest.v1+json"
                ),
                "schemaVersion": 2,
            },
            "application/vnd.oci.image.manifest.v1+json",
        )
        child.update(
            {
                "annotations": {
                    **semantic_annotations,
                    "org.opencontainers.image.ref.name": (
                        f"{formula['version']}.wasm32_kandelo."
                        f"{destination['bottle_rebuild']}"
                    ),
                    "sh.brew.bottle.digest": layer_sha256,
                    "sh.brew.bottle.size": str(len(layer_payload)),
                },
                "platform": {
                    "architecture": "wasm",
                    "os": "kandelo",
                    "variant": "wasm32",
                },
            }
        )
        top_document = {
            "annotations": {
                "com.github.package.type": "homebrew_bottle",
                **semantic_annotations,
                "org.opencontainers.image.ref.name": destination[
                    "reference"
                ],
                "org.opencontainers.image.source": (
                    "https://github.com/"
                    + authority["tap_repository"].lower()
                ),
                "org.opencontainers.image.title": (
                    f"{authority['tap_name']}/{self.target_name}"
                ),
                "org.opencontainers.image.version": formula["version"],
            },
            "manifests": [child],
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "schemaVersion": 2,
        }
        admission_top = write_oci_json_blob(
            layout,
            top_document,
            "application/vnd.oci.image.index.v1+json",
        )
        if destination["admission"]["schema"] == 2:
            destination["admission"]["probe"].update(
                {
                    "children": [
                        {
                            "arch": "wasm32",
                            "bottle_sha256": layer_sha256,
                            "bottle_size": len(layer_payload),
                            "homebrew_ref": child["annotations"][
                                "org.opencontainers.image.ref.name"
                            ],
                            "manifest_digest": child["digest"],
                            "manifest_size": child["size"],
                        }
                    ],
                    "digest": admission_top["digest"],
                    "size": admission_top["size"],
                }
            )
        top = admission_top
        if observed_source_closure_sha256 is not None:
            top_document["annotations"][
                "dev.kandelo.homebrew.source_closure_sha256"
            ] = observed_source_closure_sha256
        if observed_child_source_closure_sha256 is not None:
            child["annotations"][
                "dev.kandelo.homebrew.source_closure_sha256"
            ] = observed_child_source_closure_sha256
        if (
            observed_source_closure_sha256 is not None
            or observed_child_source_closure_sha256 is not None
        ):
            top = write_oci_json_blob(
                layout,
                top_document,
                "application/vnd.oci.image.index.v1+json",
            )
        if include_wasm64:
            extra_payload = b"wasm64 sibling bottle\n"
            extra_sha256 = sha256(extra_payload)
            (blobs / extra_sha256).write_bytes(extra_payload)
            extra_manifest = write_oci_json_blob(
                layout,
                {
                    "annotations": semantic_annotations,
                    "config": config,
                    "layers": [
                        {
                            "annotations": {},
                            "digest": f"sha256:{extra_sha256}",
                            "mediaType": (
                                "application/vnd.oci.image.layer.v1.tar+gzip"
                            ),
                            "size": len(extra_payload),
                        }
                    ],
                    "mediaType": (
                        "application/vnd.oci.image.manifest.v1+json"
                    ),
                    "schemaVersion": 2,
                },
                "application/vnd.oci.image.manifest.v1+json",
            )
            extra_manifest.update(
                {
                    "annotations": {
                        **semantic_annotations,
                        "org.opencontainers.image.ref.name": (
                            f"{formula['version']}.wasm64_kandelo."
                            f"{destination['bottle_rebuild']}"
                        ),
                        "sh.brew.bottle.digest": extra_sha256,
                        "sh.brew.bottle.size": str(len(extra_payload)),
                    },
                    "platform": {
                        "architecture": "wasm",
                        "os": "kandelo",
                        "variant": "wasm64",
                    },
                }
            )
            top_document["manifests"] = [child, extra_manifest]
            top = write_oci_json_blob(
                layout,
                top_document,
                "application/vnd.oci.image.index.v1+json",
            )
        write_json(
            layout / "index.json",
            {
                "manifests": [
                    {
                        **top,
                        "annotations": {
                            "org.opencontainers.image.ref.name": (
                                destination["reference"]
                            )
                        },
                    }
                ],
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "schemaVersion": 2,
            },
        )
        if destination["admission"]["schema"] == 1:
            destination["admission"]["probe"]["digest"] = top["digest"]
        write_json(self.campaign_path, self.campaign)
        self.public_destination_layout = layout

    def import_public_destination(
        self,
        arguments: list[str],
        _label: str,
    ) -> None:
        if arguments[0] == "source-closure":
            expected = {
                "--tap-root": str(self.source),
                "--kandelo-root": str(ROOT),
                "--tap-repository": TAP_REPOSITORY,
                "--tap-name": TAP_NAME,
                "--formula": self.target_name,
            }
            for option, value in expected.items():
                observed = arguments[arguments.index(option) + 1]
                matches = (
                    pathlib.Path(observed).resolve()
                    == pathlib.Path(value).resolve()
                    if option in ("--tap-root", "--kandelo-root")
                    else observed == value
                )
                if not matches:
                    raise AssertionError(
                        f"source closure changed {option}"
                    )
            write_json(
                pathlib.Path(arguments[arguments.index("--out") + 1]),
                {
                    "formula": self.target_name,
                    "formula_identity_sha256": self.target_formula[
                        "formula_source"
                    ]["identity_excluding_bottle_sha256"],
                    "formula_mode": "100644",
                    "schema": 2,
                    "source_closure_sha256": (
                        self.current_source_closure_sha256
                    ),
                    "tap_name": TAP_NAME,
                    "tap_repository": TAP_REPOSITORY,
                },
            )
            self.source_closure_requests.append(arguments)
            return
        if arguments[0] != "import-public-index":
            raise AssertionError("destination used the wrong OCI command")
        destination = self.target_formula["destination"]
        expected = {
            "--remote": destination["remote"],
            "--reference": destination["reference"],
        }
        for option, value in expected.items():
            if arguments[arguments.index(option) + 1] != value:
                raise AssertionError(f"destination changed {option}")
        registry_config = pathlib.Path(
            arguments[arguments.index("--registry-config") + 1]
        )
        if json.loads(registry_config.read_text()) != {"auths": {}}:
            raise AssertionError("destination import was not anonymous")
        if self.public_destination_layout is None:
            raise AssertionError("public destination was not installed")
        output = pathlib.Path(
            arguments[arguments.index("--out-layout") + 1]
        )
        shutil.copytree(self.public_destination_layout, output)
        imported_index = json.loads(
            (self.public_destination_layout / "index.json").read_text()
        )
        write_json(
            pathlib.Path(
                arguments[arguments.index("--out-result") + 1]
            ),
            {
                "digest": imported_index["manifests"][0]["digest"],
                "layout": str(output),
                "schema": 1,
                "status": "present",
            },
        )
        self.destination_imports.append(arguments)

    def derive(
        self,
        output: pathlib.Path,
        *,
        predecessor_dependency_roots: list[pathlib.Path] | None = None,
        dependency_roots: list[pathlib.Path] | None = None,
        recovery_tap_root: pathlib.Path | None = None,
        use_default_destination_verifier: bool = False,
    ) -> None:
        if predecessor_dependency_roots is None:
            predecessor_dependency_roots = (
                self.predecessor_dependency_roots
            )
        if dependency_roots is None:
            dependency_roots = self.dependency_roots
        options: dict[str, Any] = {}
        if not use_default_destination_verifier:
            options["destination_verifier"] = self.destination_verifier
        if recovery_tap_root is not None:
            options["recovery_tap_root"] = recovery_tap_root
        EXECUTOR.derive_predecessor_reuse(
            campaign_path=self.campaign_path,
            source_tap_root=self.source,
            predecessor_campaign_path=self.predecessor_path,
            predecessor_handoff_root=self.predecessor_handoff,
            formula_name=self.target_name,
            arch="wasm32",
            predecessor_dependency_roots=predecessor_dependency_roots,
            dependency_roots=dependency_roots,
            output=output,
            **options,
        )


class PredecessorDependencyReuseFixture(PredecessorReuseFixture):
    def __init__(
        self,
        *,
        legacy_predecessor: bool = False,
        scoped_dependency: bool = False,
    ) -> None:
        super().__init__(
            dependent=True,
            legacy_predecessor=legacy_predecessor,
            scoped_dependency=scoped_dependency,
        )


class FinalTapFixture(Fixture):
    def __init__(self, *, active_retired_prefix: bool = False) -> None:
        super().__init__(multi_arch=True)
        layout_path = ROOT / "homebrew/kandelo-guest-layout.json"
        layout = json.loads(layout_path.read_text())
        self.retired_prefix = layout["retired_prefixes"][0]
        self.campaign["authority"]["guest_layout"]["sha256"] = sha256(
            layout_path.read_bytes()
        )
        target_alpha = formula_source("alpha")
        base_alpha = target_alpha + b"# sealed overlay preimage\n"
        target_helper = b"# sealed campaign helper\n"
        gamma_payload = formula_source("gamma")
        if active_retired_prefix:
            gamma_payload += f"# active path: {self.retired_prefix}\n".encode()

        template = self.source
        self.live = self.root / "live-tap"
        shutil.copytree(template, self.live)
        shutil.rmtree(template)
        (
            self.live
            / "Kandelo/reports/"
            "beta-2.0-rebuild1-wasm32.provenance.json"
        ).unlink()
        subprocess.run(["git", "init", "-q"], cwd=self.live, check=True)
        (self.live / "Formula/alpha.rb").write_bytes(base_alpha)
        (self.live / "Formula/gamma.rb").write_bytes(gamma_payload)
        (self.live / "Kandelo/README.md").write_text(
            "base campaign control documentation\n"
        )
        campaign_docs = self.live / "Kandelo/campaigns/prefix-v1"
        campaign_docs.mkdir(parents=True, exist_ok=True)
        (campaign_docs / "README.md").write_text(
            "base campaign completion documentation\n"
        )
        (campaign_docs / "verify.py").write_text(
            "# generic completion verifier fixture\n"
        )
        retained_test = (
            self.live
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
        failure = self.live / "Kandelo/reports/failures/alpha.json"
        failure.parent.mkdir(parents=True)
        failure.write_bytes(self.failure_evidence)
        rollback = self.live / "Kandelo/reports/rollbacks/beta.json"
        rollback.parent.mkdir(parents=True)
        rollback.write_bytes(self.rollback_evidence)
        workflow = self.live / ".github/workflows/prefix-campaign-bottles.yml"
        workflow.parent.mkdir(parents=True)
        workflow.write_text("name: base campaign publisher\n")
        materializer = self.live / "scripts/prefix-campaign-source.py"
        materializer.parent.mkdir(parents=True)
        materializer.write_text("# retained generic materializer fixture\n")
        (self.live / "scripts/prefix-campaign-controller.py").write_text(
            "# base campaign controller\n"
        )
        (self.live / "scripts/test_prefix_campaign_controller.py").write_text(
            "# base campaign controller test\n"
        )
        write_json(
            self.live / "Kandelo/prefix-campaign-authority.json",
            {"fixture": "base campaign authority"},
        )
        write_json(
            self.live / "Kandelo/campaigns/prefix-v1/manifest.json",
            {"fixture": "base campaign manifest"},
        )
        overlay_source = self.live / "Kandelo/campaigns/prefix-v1/source"
        overlay_source.mkdir(parents=True)
        (overlay_source / "placeholder").write_text("base payload\n")
        self.base_commit = commit_repo(self.live, "sealed overlay base")
        self.base_tree = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=self.live,
            text=True,
        ).strip()

        sealed_target = EXECUTOR.git_snapshot(
            self.live,
            self.base_commit,
            self.root / "sealed-target",
            "final tap fixture sealed target",
        )
        (sealed_target / "Formula/alpha.rb").write_bytes(target_alpha)
        (sealed_target / "scripts/sealed-campaign-helper.py").write_bytes(
            target_helper
        )
        sealed_target_tree = EXECUTOR.filesystem_git_tree_oid(
            sealed_target,
            "final tap fixture sealed target",
        )

        shutil.rmtree(overlay_source)
        (overlay_source / "Formula").mkdir(parents=True)
        (overlay_source / "Formula/alpha.rb").write_bytes(target_alpha)
        (overlay_source / "scripts").mkdir()
        (
            overlay_source / "scripts/sealed-campaign-helper.py"
        ).write_bytes(target_helper)
        overlay_tree = EXECUTOR.filesystem_git_tree_oid(
            overlay_source,
            "final tap fixture overlay source",
        )

        def file_record(payload: bytes) -> dict[str, Any]:
            return {
                "blob_git_oid": EXECUTOR.git_object_id("blob", payload),
                "bytes": len(payload),
                "mode": "100644",
                "sha256": sha256(payload),
            }

        manifest = {
            "base": {
                "commit": self.base_commit,
                "tree_git_oid": self.base_tree,
            },
            "campaign": "prefix-v1",
            "files": [
                {
                    "base": file_record(base_alpha),
                    "path": "Formula/alpha.rb",
                    "target": file_record(target_alpha),
                },
                {
                    "base": None,
                    "path": "scripts/sealed-campaign-helper.py",
                    "target": file_record(target_helper),
                },
            ],
            "kind": "kandelo-homebrew-prefix-campaign-source-overlay",
            "schema": 1,
            "source_root": "Kandelo/campaigns/prefix-v1/source",
            "target_tree_git_oid": sealed_target_tree,
        }
        manifest_path = self.live / EXECUTOR.SOURCE_MANIFEST_PATH
        write_json(manifest_path, manifest)
        authority = {
            "target_source": {
                "manifest_path": EXECUTOR.SOURCE_MANIFEST_PATH,
                "manifest_sha256": sha256(manifest_path.read_bytes()),
                "source_root": "Kandelo/campaigns/prefix-v1/source",
                "source_tree_git_oid": overlay_tree,
                "target_tree_git_oid": sealed_target_tree,
            }
        }
        authority_path = self.live / EXECUTOR.SOURCE_AUTHORITY_PATH
        write_json(authority_path, authority)
        # These reviewed source-commit paths did not exist in the old base.
        # The regression proves full source identity preserves them even though
        # they are not selected Formulae and not overlay records.
        source_only_paths = {
            ".github/workflows/dry-run-bottles.yml": "name: dry run\n",
            ".github/workflows/repository-namespace-canary.yml": (
                "name: namespace canary\n"
            ),
            "Kandelo/publisher-trust-rotation.md": "source trust notes\n",
            "scripts/rotate-publisher-trust.py": "# rotate trust\n",
            "scripts/test_prefix_campaign_source.py": "# source tests\n",
            "scripts/test_rotate_publisher_trust.py": "# trust tests\n",
        }
        for relative, payload in source_only_paths.items():
            path = self.live / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(payload)
        self.source_commit = commit_repo(
            self.live,
            "bind complete source beside sealed overlay",
        )
        source_commit_tree = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=self.live,
            text=True,
        ).strip()

        source_commit_snapshot = EXECUTOR.git_snapshot(
            self.live,
            self.source_commit,
            self.root / "source-commit-preview",
            "final tap fixture complete source",
        )
        self.source = sealed_target
        self.source_tree = sealed_target_tree
        records = [
            (
                "Formula/alpha.rb",
                file_record(base_alpha),
                file_record(target_alpha),
            ),
            (
                "scripts/sealed-campaign-helper.py",
                None,
                file_record(target_helper),
            ),
        ]
        EXECUTOR.replay_overlay_files(
            tap_root=source_commit_snapshot,
            source_root=(
                source_commit_snapshot
                / "Kandelo/campaigns/prefix-v1/source"
            ),
            records=records,
            label="final tap fixture source replay",
        )
        replayed_source_tree = EXECUTOR.filesystem_git_tree_oid(
            source_commit_snapshot,
            "final tap fixture replayed source",
        )
        self.campaign["authority"]["source_tap_commit"] = self.source_commit
        self.campaign["authority"]["source_materialization"] = {
            "authority": {
                "path": EXECUTOR.SOURCE_AUTHORITY_PATH,
                "sha256": sha256(authority_path.read_bytes()),
            },
            "kind": "sealed-target-overlay-v1",
            "manifest": {
                "path": EXECUTOR.SOURCE_MANIFEST_PATH,
                "sha256": sha256(manifest_path.read_bytes()),
            },
            "materializer": {
                "path": EXECUTOR.SOURCE_MATERIALIZER_PATH,
                "sha256": sha256(materializer.read_bytes()),
            },
            "source_root": "Kandelo/campaigns/prefix-v1/source",
            "source_tree_git_oid": overlay_tree,
            "target_tree_git_oid": sealed_target_tree,
        }

        allowed_activation_updates = {
            ".github/workflows/base-contract-checks.yml": (
                "name: activated campaign base contract\n"
            ),
            ".github/workflows/contract-checks.yml": (
                "name: activated campaign contract\n"
            ),
            ".github/workflows/prefix-campaign-bottles.yml": (
                "name: activated campaign publisher\n"
            ),
            "Kandelo/README.md": "activated campaign control docs\n",
            "Kandelo/campaigns/prefix-v1/README.md": (
                "activated campaign completion docs\n"
            ),
            "Kandelo/test-workflow-trust.rb": "# activated trust test\n",
            "scripts/prefix-campaign-controller.py": (
                "# activated campaign controller\n"
            ),
            "scripts/test_prefix_campaign_controller.py": (
                "# activated campaign controller test\n"
            ),
        }
        for relative, payload in allowed_activation_updates.items():
            path = self.live / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(payload)
        live_authority = json.loads(authority_path.read_text())
        live_authority["activation"] = "reviewed descendant"
        write_json(authority_path, live_authority)
        self.refresh_live("activate campaign controller")

        preview = EXECUTOR.git_snapshot(
            self.live,
            self.live_commit,
            self.root / "live-replay-preview",
            "final tap fixture live replay preview",
        )
        EXECUTOR.replay_overlay_files(
            tap_root=preview,
            source_root=(
                source_commit_snapshot
                / "Kandelo/campaigns/prefix-v1/source"
            ),
            records=records,
            label="final tap fixture live replay preview",
        )
        self.source_provenance = {
            "base": {
                "commit": self.base_commit,
                "tree_git_oid": self.base_tree,
            },
            "manifest_sha256": sha256(manifest_path.read_bytes()),
            "overlay_source_tree_git_oid": overlay_tree,
            "replayed_live_tree_git_oid": (
                EXECUTOR.filesystem_git_tree_oid(
                    preview,
                    "final tap fixture replayed live preview",
                )
            ),
            "replayed_source_tree_git_oid": replayed_source_tree,
            "sealed_target_tree_git_oid": sealed_target_tree,
            "source_tap_commit": self.source_commit,
            "source_tap_tree_git_oid": source_commit_tree,
        }
        shutil.rmtree(preview)
        shutil.rmtree(source_commit_snapshot)
        write_json(self.campaign_path, self.campaign)
        self.pre_retirement_validated = False

    def refresh_live(self, message: str) -> None:
        self.live_commit = commit_repo(self.live, message)
        self.live_tree = subprocess.check_output(
            ["git", "rev-parse", "HEAD^{tree}"],
            cwd=self.live,
            text=True,
        ).strip()

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

    def split_handoffs(
        self,
    ) -> dict[tuple[str, str], pathlib.Path]:
        handoffs: dict[tuple[str, str], pathlib.Path] = {}
        for arch in ("wasm32", "wasm64"):
            alpha = self.root / f"final-alpha-{arch}"
            self.derive(
                "alpha",
                [(arch, self.publication("alpha", arch))],
                [],
                alpha,
            )
            handoffs[("alpha", arch)] = alpha
            beta = self.root / f"final-beta-{arch}"
            self.derive(
                "beta",
                [(arch, self.publication("beta", arch))],
                [alpha],
                beta,
            )
            handoffs[("beta", arch)] = beta
        return handoffs

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
    def test_host_tools_reuse_an_active_dev_shell(self) -> None:
        with mock.patch.dict(
            EXECUTOR.os.environ,
            {"KANDELO_DEV_SHELL_TOOL_PATH": "/declared/tools"},
        ):
            self.assertEqual(
                EXECUTOR.dev_shell_command("rustc", "-vV"),
                ["rustc", "-vV"],
            )

    def test_rustc_host_target_is_derived_once(self) -> None:
        EXECUTOR.rustc_host_target.cache_clear()
        self.addCleanup(EXECUTOR.rustc_host_target.cache_clear)
        completed = subprocess.CompletedProcess(
            [],
            0,
            stdout=(
                b"rustc 1.97.0-nightly\n"
                b"host: x86_64-unknown-linux-gnu\n"
            ),
            stderr=b"",
        )
        with mock.patch.object(
            EXECUTOR.subprocess,
            "run",
            return_value=completed,
        ) as runner:
            self.assertEqual(
                EXECUTOR.rustc_host_target(),
                "x86_64-unknown-linux-gnu",
            )
            self.assertEqual(
                EXECUTOR.rustc_host_target(),
                "x86_64-unknown-linux-gnu",
            )
        runner.assert_called_once()

    def test_closed_selection_xtasks_explicitly_target_the_host(
        self,
    ) -> None:
        root = pathlib.Path(
            tempfile.mkdtemp(prefix="closed-selection-xtask-test-")
        )
        self.addCleanup(shutil.rmtree, root)
        tap_root = root / "tap"
        tap_root.mkdir()
        sidecar_input = root / "sidecars.json"
        sidecar_input.write_text("{}\n")
        completed = subprocess.CompletedProcess(
            [],
            0,
            stdout=b"",
            stderr=b"",
        )
        host_target = "x86_64-unknown-linux-gnu"
        with mock.patch.object(
            EXECUTOR,
            "rustc_host_target",
            return_value=host_target,
        ), mock.patch.object(
            EXECUTOR.subprocess,
            "run",
            return_value=completed,
        ) as runner:
            EXECUTOR.default_sidecar_generator(
                tap_root=tap_root,
                input_path=sidecar_input,
                prefix_campaign_layout_sha256="a" * 64,
            )
            EXECUTOR.default_tap_validator(
                tap_root=tap_root,
                prefix_campaign_layout_sha256="a" * 64,
            )

        self.assertEqual(runner.call_count, 2)
        for call in runner.call_args_list:
            command = call.args[0]
            self.assertEqual(
                command[command.index("--target") + 1],
                host_target,
            )
            self.assertLess(
                command.index("--target"),
                command.index("--quiet"),
            )

    def test_real_host_xtask_escapes_the_default_wasm_target(
        self,
    ) -> None:
        EXECUTOR.rustc_host_target.cache_clear()
        self.addCleanup(EXECUTOR.rustc_host_target.cache_clear)
        root = pathlib.Path(
            tempfile.mkdtemp(prefix="host-xtask-executable-test-")
        )
        self.addCleanup(shutil.rmtree, root)
        matrix = root / "empty-matrix.json"
        matrix.write_text("[]\n")
        environment = os.environ.copy()
        environment.pop("CARGO_BUILD_TARGET", None)
        command = EXECUTOR.host_xtask_command(
            "sort-package-matrix",
            "--matrix",
            str(matrix),
        )
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=1800,
        )
        self.assertEqual(
            result.returncode,
            0,
            result.stderr.decode("utf-8", errors="replace")[-4096:],
        )
        self.assertEqual(
            result.stdout.decode("utf-8").splitlines()[-1],
            "[]",
        )

    def test_publisher_workflow_authenticates_each_metadata_read(
        self,
    ) -> None:
        workflow_counts = {
            ".github/workflows/reusable-homebrew-bottle-publish.yml": 7,
            ".github/workflows/"
            "reusable-homebrew-prefix-first-child-publish.yml": 1,
        }
        for relative, expected in workflow_counts.items():
            workflow = (ROOT / relative).read_text()
            step_blocks = re.split(
                r"(?=^      - name: )",
                workflow,
                flags=re.M,
            )
            publisher_steps = [
                block
                for block in step_blocks
                if "homebrew-prefix-campaign-publisher.py" in block
                and "verify-built-bottle" not in block
            ]
            self.assertEqual(len(publisher_steps), expected)
            for step in publisher_steps:
                self.assertIn("GH_TOKEN: ${{ github.token }}", step)

    def test_github_metadata_uses_token_without_credentialing_assets(
        self,
    ) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"{}"
        with mock.patch.dict(
            os.environ,
            {"GH_TOKEN": "test-token", "GITHUB_TOKEN": "fallback-token"},
            clear=False,
        ), mock.patch.object(
            EXECUTOR.urllib.request,
            "urlopen",
            return_value=response,
        ) as urlopen:
            self.assertEqual(
                EXECUTOR.http_json(
                    "https://api.github.com/repos/example/repo/releases/1",
                    "fixture metadata",
                ),
                {},
            )
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.get_header("Authorization"),
            "Bearer test-token",
        )
        redirected = (
            EXECUTOR.urllib.request.HTTPRedirectHandler().redirect_request(
                request,
                None,
                302,
                "fixture redirect",
                {},
                "https://example.invalid/redirected",
            )
        )
        self.assertIsNotNone(redirected)
        self.assertIsNone(redirected.get_header("Authorization"))

        asset_request = mock.MagicMock()
        asset_request.__enter__.return_value.read.side_effect = [b"x", b""]
        with mock.patch.dict(
            os.environ,
            {"GH_TOKEN": "test-token"},
            clear=False,
        ), tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            EXECUTOR.urllib.request,
            "urlopen",
            return_value=asset_request,
        ) as asset_urlopen:
            EXECUTOR.http_asset(
                "https://github.com/example/repo/releases/download/tag/a",
                pathlib.Path(temporary) / "asset",
                1,
                sha256(b"x"),
            )
        request = asset_urlopen.call_args.args[0]
        self.assertIsNone(request.get_header("Authorization"))

    def test_github_token_is_not_sent_to_another_host(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"{}"
        with mock.patch.dict(
            os.environ,
            {"GH_TOKEN": "test-token"},
            clear=False,
        ), mock.patch.object(
            EXECUTOR.urllib.request,
            "urlopen",
            return_value=response,
        ) as urlopen:
            EXECUTOR.http_json(
                "https://example.invalid/metadata",
                "fixture metadata",
            )
        request = urlopen.call_args.args[0]
        self.assertIsNone(request.get_header("Authorization"))

    def test_malformed_github_token_fails_before_network(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"GH_TOKEN": "bad\ntoken"},
            clear=False,
        ), mock.patch.object(
            EXECUTOR.urllib.request,
            "urlopen",
        ) as urlopen, self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "GitHub API token is malformed",
        ):
            EXECUTOR.http_json(
                "https://api.github.com/repos/example/repo/releases/1",
                "fixture metadata",
            )
        urlopen.assert_not_called()

    def test_destination_admission_requires_campaign_schema_two(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        fixture.campaign["schema"] = 1
        write_json(fixture.campaign_path, fixture.campaign)

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "campaign manifest has an unsupported contract",
        ):
            EXECUTOR.load_campaign(fixture.campaign_path)

    def test_reviewed_required_build_accepts_namespace_bootstrap(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        alpha = fixture.campaign["formulae"][0]
        alpha["source_kind"] = "reviewed-new-entrant"
        alpha["variants"][0].update(
            {
                "build_input": {"kind": "formula-source"},
                "disposition": {
                    "kind": "required-build",
                    "reasons": ["new-campaign-entrant"],
                },
                "selected_by": "reviewed-campaign-input",
            }
        )
        alpha["destination"]["admission"] = {
            "kind": "first-package-namespace-bootstrap-required",
            "method": "anonymous-oras-manifest-probe",
            "probe": {
                "digest": None,
                "kind": "manifest",
                "schema": 1,
                "status": "auth-required",
            },
            "schema": 1,
        }
        write_json(fixture.campaign_path, fixture.campaign)

        _campaign, _payload, index = EXECUTOR.load_campaign(
            fixture.campaign_path
        )

        self.assertEqual(index["alpha"]["destination"], alpha["destination"])

    def test_namespace_bootstrap_rejects_existing_or_reused_formula(
        self,
    ) -> None:
        cases = (
            ("sidecar-backed", "fixture", "required-rebuild", "fixture"),
            (
                "reuse",
                "reviewed-new-entrant",
                "byte-clean-reuse-candidate",
                "reviewed-campaign-input",
            ),
        )
        for label, source_kind, disposition, selected_by in cases:
            with self.subTest(label=label):
                fixture = Fixture()
                self.addCleanup(fixture.close)
                alpha = fixture.campaign["formulae"][0]
                alpha["source_kind"] = source_kind
                alpha["variants"][0].update(
                    {
                        "build_input": {"kind": "formula-source"},
                        "disposition": {
                            "kind": disposition,
                            "reasons": (
                                []
                                if disposition
                                == "byte-clean-reuse-candidate"
                                else ["fixture"]
                            ),
                        },
                        "selected_by": selected_by,
                    }
                )
                alpha["destination"]["admission"] = {
                    "kind": (
                        "first-package-namespace-bootstrap-required"
                    ),
                    "method": "anonymous-oras-manifest-probe",
                    "probe": {
                        "digest": None,
                        "kind": "manifest",
                        "schema": 1,
                        "status": "auth-required",
                    },
                    "schema": 1,
                }
                write_json(fixture.campaign_path, fixture.campaign)

                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    "not eligible for first-package namespace bootstrap",
                ):
                    EXECUTOR.load_campaign(fixture.campaign_path)

    def test_destination_admission_rejects_substituted_probe_state(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        alpha = fixture.campaign["formulae"][0]
        alpha["destination"]["admission"]["probe"] = {
            "digest": "sha256:" + "f" * 64,
            "kind": "manifest",
            "schema": 1,
            "status": "present",
        }
        write_json(fixture.campaign_path, fixture.campaign)

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "anonymous absence is invalid",
        ):
            EXECUTOR.load_campaign(fixture.campaign_path)

    def test_partial_destination_inventory_must_equal_reuse_sources(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(partial_multiarch=True)
        self.addCleanup(fixture.close)
        probe = fixture.target_formula["destination"]["admission"]["probe"]
        probe["children"].append(
            {
                "arch": "wasm64",
                "bottle_sha256": "6" * 64,
                "bottle_size": 1,
                "homebrew_ref": "1.0.wasm64_kandelo.1",
                "manifest_digest": "sha256:" + "6" * 64,
                "manifest_size": 1,
            }
        )
        write_json(fixture.campaign_path, fixture.campaign)

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "wasm64 predecessor source is missing",
        ):
            EXECUTOR.load_campaign(fixture.campaign_path)

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
            captured["command"][0:2],
            ["node", "--experimental-strip-types"],
        )
        self.assertIn(
            "scripts/homebrew-verify-public-bottle.ts",
            captured["command"][2],
        )
        self.assertNotIn("npx", captured["command"])
        self.assertNotIn("tsx", captured["command"])

    def test_predecessor_handoff_is_resealed_without_rebuilding(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(
            prepared_formula_differs=True
        )
        self.addCleanup(fixture.close)
        raw_formula_digest = fixture.target_formula["formula_source"][
            "sha256"
        ]
        prepared_formula_digest = EXECUTOR.prepared_formula_sha256(
            fixture.source,
            fixture.predecessor,
            fixture.target_formula,
        )
        predecessor_sidecars = json.loads(
            (
                fixture.predecessor_handoff
                / "payload/wasm32/composition/sidecars-input.json"
            ).read_text()
        )
        self.assertNotEqual(prepared_formula_digest, raw_formula_digest)
        self.assertEqual(
            predecessor_sidecars["packages"][0][
                "formula_source_sha256"
            ],
            prepared_formula_digest,
        )

        handoff = fixture.root / "successor-handoff"
        fixture.derive(handoff)

        manifest = json.loads((handoff / "handoff.json").read_text())
        self.assertEqual(
            manifest["source"]["kandelo_commit"],
            "2" * 40,
        )
        self.assertEqual(manifest["publications"][0]["kind"], "reuse")
        self.assertEqual(
            (
                handoff
                / "payload/wasm32/reuse/bottle.tar.gz"
            ).read_bytes(),
            fixture.archive,
        )
        sidecars = json.loads(
            (
                handoff
                / "payload/wasm32/composition/sidecars-input.json"
            ).read_text()
        )
        bottle = sidecars["packages"][0]["bottles"][0]
        self.assertEqual(sidecars["kandelo_commit"], "2" * 40)
        self.assertEqual(
            sidecars["packages"][0]["formula_source_sha256"],
            raw_formula_digest,
        )
        self.assertEqual(
            bottle["built_from"]["kandelo_commit"],
            "1" * 40,
        )
        evidence = json.loads(
            (
                handoff / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        self.assertEqual(
            evidence["predecessor"]["campaign_tag"],
            fixture.predecessor_campaign_tag,
        )
        self.assertEqual(
            evidence["predecessor"]["handoff_tag"],
            fixture.predecessor_handoff_tag,
        )
        prepared = fixture.root / "successor-release"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=handoff,
            dependency_roots=[],
            output=prepared,
        )
        self.assertTrue((prepared / "release-manifest.json").is_file())

        successor_handoff, _payload = EXECUTOR.load_handoff(
            handoff,
            fixture.campaign,
            fixture.campaign_path.read_bytes(),
        )
        extracted, archive_record = EXECUTOR.predecessor_reuse_inputs(
            campaign=fixture.campaign,
            formula=fixture.target_formula,
            handoff_root=handoff,
            handoff=successor_handoff,
            arch="wasm32",
            expected_formula_source_sha256=raw_formula_digest,
        )
        self.assertEqual(archive_record["sha256"], fixture.archive_sha256)
        self.assertEqual(extracted["cache_key_sha"], fixture.archive_sha256)

    def test_legacy_predecessor_without_scopes_remains_reusable(
        self,
    ) -> None:
        fixture = PredecessorDependencyReuseFixture(
            legacy_predecessor=True
        )
        self.addCleanup(fixture.close)
        handoff = fixture.root / "legacy-predecessor-handoff"

        fixture.derive(handoff)

        manifest = json.loads((handoff / "handoff.json").read_text())
        self.assertEqual(
            manifest["formula"]["dependencies"],
            [
                {
                    "full_name": f"{TAP_NAME}/alpha",
                    "version": "1.0",
                }
            ],
        )
        self.assertEqual(manifest["publications"][0]["kind"], "reuse")

    def test_default_predecessor_destination_verifier_binds_public_oci(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        fixture.install_public_destination()
        handoff = fixture.root / "default-verifier-handoff"

        with mock.patch.object(
            EXECUTOR,
            "run_oci_layout_command",
            side_effect=fixture.import_public_destination,
        ):
            fixture.derive(
                handoff,
                use_default_destination_verifier=True,
            )

        self.assertEqual(len(fixture.source_closure_requests), 1)
        self.assertEqual(len(fixture.destination_imports), 1)
        self.assertEqual(
            (
                handoff / "payload/wasm32/reuse/bottle.tar.gz"
            ).read_bytes(),
            fixture.archive,
        )
        evidence = json.loads(
            (
                handoff / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        destination = fixture.target_formula["destination"]
        self.assertEqual(
            evidence["destination"],
            {
                "manifest_digest": destination["admission"]["probe"][
                    "digest"
                ],
                "reference": destination["reference"],
                "remote": destination["remote"],
                "source_closure_sha256": "6" * 64,
            },
        )

    def test_default_predecessor_destination_rejects_support_drift(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        fixture.install_public_destination()
        fixture.current_source_closure_sha256 = "7" * 64
        output = fixture.root / "changed-support-closure"

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=fixture.import_public_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "predecessor source closure changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_default_predecessor_destination_rejects_formula_mode_drift(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        baseline_path = fixture.root / "baseline-source-closure.json"
        closure_arguments = [
            "source-closure",
            "--tap-root",
            str(fixture.source),
            "--kandelo-root",
            str(ROOT),
            "--tap-repository",
            TAP_REPOSITORY,
            "--tap-name",
            TAP_NAME,
            "--formula",
            fixture.target_name,
            "--out",
            str(baseline_path),
        ]
        EXECUTOR.run_oci_layout_command(
            closure_arguments,
            "derive baseline test source closure",
        )
        fixture.source_closure_sha256 = json.loads(
            baseline_path.read_text()
        )["source_closure_sha256"]
        fixture.install_public_destination()

        formula_path = fixture.source / fixture.target_formula[
            "formula_source"
        ]["path"]
        formula_path.chmod(0o755)
        fixture.campaign["authority"]["source_materialization"][
            "tree_git_oid"
        ] = EXECUTOR.filesystem_git_tree_oid(
            fixture.source, "executable Formula target source"
        )
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "changed-formula-mode"
        real_oci_command = EXECUTOR.run_oci_layout_command

        def verify_destination(arguments: list[str], label: str) -> None:
            if arguments[0] == "source-closure":
                real_oci_command(arguments, label)
            else:
                fixture.import_public_destination(arguments, label)

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=verify_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "predecessor source closure changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_partial_predecessor_rejects_rewritten_top_closure(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(partial_multiarch=True)
        self.addCleanup(fixture.close)
        fixture.current_source_closure_sha256 = "7" * 64
        fixture.install_public_destination(
            include_wasm64=True,
            observed_child_source_closure_sha256=("7" * 64),
            observed_source_closure_sha256=("7" * 64),
        )
        output = fixture.root / "rewritten-top-source-closure"

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=fixture.import_public_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "predecessor source closure changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_partial_predecessor_destination_accepts_appended_build_sibling(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(partial_multiarch=True)
        self.addCleanup(fixture.close)
        fixture.install_public_destination(include_wasm64=True)
        handoff = fixture.root / "partial-default-verifier-handoff"

        with mock.patch.object(
            EXECUTOR,
            "run_oci_layout_command",
            side_effect=fixture.import_public_destination,
        ):
            fixture.derive(
                handoff,
                use_default_destination_verifier=True,
            )

        evidence = json.loads(
            (
                handoff / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        destination = fixture.target_formula["destination"]
        imported_index = json.loads(
            (fixture.public_destination_layout / "index.json").read_text()
        )
        observed_digest = imported_index["manifests"][0]["digest"]
        self.assertEqual(evidence["schema"], 3)
        self.assertEqual(
            evidence["destination"],
            {
                "admission_manifest_digest": destination["admission"][
                    "probe"
                ]["digest"],
                "observed_manifest_digest": observed_digest,
                "reference": destination["reference"],
                "remote": destination["remote"],
                "source_closure_sha256": "6" * 64,
            },
        )
        self.assertNotEqual(
            evidence["destination"]["admission_manifest_digest"],
            evidence["destination"]["observed_manifest_digest"],
        )
        self.assertNotIn(
            "reuse_source", fixture.target_formula["variants"][1]
        )

    def test_partial_predecessor_destination_rejects_changed_admitted_child(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(partial_multiarch=True)
        self.addCleanup(fixture.close)
        fixture.install_public_destination()
        fixture.target_formula["destination"]["admission"]["probe"][
            "children"
        ][0]["manifest_digest"] = "sha256:" + "9" * 64
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "changed-admitted-child"

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=fixture.import_public_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "admitted public OCI child changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_partial_predecessor_destination_binds_admitted_homebrew_ref(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(partial_multiarch=True)
        self.addCleanup(fixture.close)
        fixture.install_public_destination()
        fixture.target_formula["destination"]["admission"]["probe"][
            "children"
        ][0]["homebrew_ref"] = "1.0.wasm32_kandelo.2"
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "changed-admitted-homebrew-ref"

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=fixture.import_public_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "admitted public OCI child changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_default_predecessor_destination_rejects_another_layer(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        fixture.install_public_destination(
            layer_payload=b"substituted public bottle\n"
        )
        output = fixture.root / "substituted-destination"

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=fixture.import_public_destination,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "public OCI bottle layer changed",
            ),
        ):
            fixture.derive(
                output,
                use_default_destination_verifier=True,
            )
        self.assertFalse(output.exists())

    def test_predecessor_reuse_reseals_matching_dependency_closures(
        self,
    ) -> None:
        fixture = PredecessorDependencyReuseFixture(
            scoped_dependency=True
        )
        self.addCleanup(fixture.close)
        handoff = fixture.root / "dependent-successor-handoff"
        fixture.derive(handoff)

        predecessor_dependency = fixture.predecessor_dependency_roots[0]
        successor_dependency = fixture.dependency_roots[0]
        predecessor_payload = (
            predecessor_dependency / "handoff.json"
        ).read_bytes()
        successor_payload = (
            successor_dependency / "handoff.json"
        ).read_bytes()
        successor_manifest = json.loads(
            (handoff / "handoff.json").read_text()
        )
        self.assertEqual(successor_manifest["formula"]["name"], "beta")
        self.assertEqual(successor_manifest["formula"]["dependencies"], [])
        self.assertEqual(
            successor_manifest["dependency_handoffs"],
            [
                {
                    "formula": "alpha",
                    "manifest_sha256": sha256(successor_payload),
                    "tag": EXECUTOR.handoff_tag(successor_payload),
                }
            ],
        )

        dependency_archive = (
            predecessor_dependency
            / "payload/wasm32/build/bottle.tar.gz"
        ).read_bytes()
        evidence = json.loads(
            (
                handoff / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        self.assertEqual(
            evidence["dependency_bottles"],
            [
                {
                    "bytes": len(dependency_archive),
                    "formula": "alpha",
                    "predecessor_handoff_tag": EXECUTOR.handoff_tag(
                        predecessor_payload
                    ),
                    "sha256": sha256(dependency_archive),
                    "successor_handoff_tag": EXECUTOR.handoff_tag(
                        successor_payload
                    ),
                }
            ],
        )
        self.assertNotEqual(
            evidence["dependency_bottles"][0][
                "predecessor_handoff_tag"
            ],
            evidence["dependency_bottles"][0][
                "successor_handoff_tag"
            ],
        )
        sidecars = json.loads(
            (
                handoff
                / "payload/wasm32/composition/sidecars-input.json"
            ).read_text()
        )
        self.assertEqual(sidecars["packages"][0]["dependencies"], [])
        prepared = fixture.root / "dependent-successor-release"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=handoff,
            dependency_roots=fixture.dependency_roots,
            output=prepared,
        )
        self.assertTrue((prepared / "release-manifest.json").is_file())

    def test_predecessor_reuse_rejects_raw_digest_for_prepared_formula(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture(
            prepared_formula_differs=True,
            raw_predecessor_build_digest=True,
        )
        self.addCleanup(fixture.close)
        output = fixture.root / "raw-formula-digest-successor"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "predecessor alpha/wasm32 sidecars are inconsistent",
        ):
            fixture.derive(output)
        self.assertFalse(output.exists())

    def test_predecessor_reuse_rejects_changed_dependency_bottle(
        self,
    ) -> None:
        fixture = PredecessorDependencyReuseFixture()
        self.addCleanup(fixture.close)
        changed_dependency = fixture.root / "changed-alpha-handoff"
        fixture._derive_alpha_dependency(
            campaign_path=fixture.campaign_path,
            output=changed_dependency,
            archive_payload=b"changed alpha bottle bytes\n",
        )
        output = fixture.root / "changed-dependency-successor"

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependency alpha/wasm32 bottle changed",
        ):
            fixture.derive(
                output,
                dependency_roots=[changed_dependency],
            )
        self.assertFalse(output.exists())

    def test_predecessor_reuse_allows_unrelated_formula_tree_change(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        predecessor_tree = fixture.predecessor["authority"][
            "source_materialization"
        ]["tree_git_oid"]
        (fixture.source / "Formula/unrelated.rb").write_bytes(
            formula_source("unrelated")
        )
        successor_tree = EXECUTOR.filesystem_git_tree_oid(
            fixture.source, "successor target source"
        )
        fixture.campaign["authority"]["source_materialization"][
            "tree_git_oid"
        ] = successor_tree
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "unrelated-formula-successor"

        self.assertNotEqual(successor_tree, predecessor_tree)
        fixture.derive(output)
        manifest = json.loads((output / "handoff.json").read_text())
        evidence = json.loads(
            (
                output / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        self.assertEqual(
            manifest["source"]["target_tree_git_oid"], successor_tree
        )
        self.assertEqual(
            evidence["predecessor"]["source"]["target_tree_git_oid"],
            predecessor_tree,
        )
        prepared = fixture.root / "unrelated-formula-release"
        EXECUTOR.prepare_release(
            campaign_path=fixture.campaign_path,
            handoff_root=output,
            dependency_roots=[],
            output=prepared,
        )
        release = json.loads(
            (prepared / "release-manifest.json").read_text()
        )
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        readback = fixture.root / "unrelated-formula-readback"
        EXECUTOR.fetch_release(
            campaign_path=fixture.campaign_path,
            tag=release["tag"],
            output=readback,
            receipt_output=fixture.root / "unrelated-formula-receipt.json",
            dependency_roots=[],
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        readback_evidence = json.loads(
            (
                readback / "payload/wasm32/reuse/evidence.json"
            ).read_text()
        )
        self.assertEqual(readback_evidence, evidence)

    def test_predecessor_reuse_evidence_binds_recovery_source(self) -> None:
        for field in (
            "kandelo_commit",
            "source_tap_commit",
            "target_tree_git_oid",
        ):
            with self.subTest(field=field):
                fixture = PredecessorReuseFixture()
                try:
                    handoff = fixture.root / f"changed-{field}-handoff"
                    fixture.derive(handoff)
                    evidence_path = (
                        handoff / "payload/wasm32/reuse/evidence.json"
                    )
                    evidence = json.loads(evidence_path.read_text())
                    evidence["predecessor"]["source"][field] = "f" * 40
                    write_json(evidence_path, evidence)

                    manifest_path = handoff / "handoff.json"
                    manifest = json.loads(manifest_path.read_text())
                    evidence_record = next(
                        record
                        for record in manifest["publications"][0]["files"]
                        if record["path"]
                        == "payload/wasm32/reuse/evidence.json"
                    )
                    payload = evidence_path.read_bytes()
                    evidence_record["bytes"] = len(payload)
                    evidence_record["sha256"] = sha256(payload)
                    write_json(manifest_path, manifest)

                    with self.assertRaisesRegex(
                        EXECUTOR.ExecutorError,
                        "predecessor source closure changed",
                    ):
                        EXECUTOR.load_handoff(
                            handoff,
                            fixture.campaign,
                            fixture.campaign_path.read_bytes(),
                        )
                finally:
                    fixture.close()

    def test_predecessor_reuse_rejects_changed_formula_source(self) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        formula = fixture.target_formula
        changed_source = formula_source(fixture.target_name) + b"# changed\n"
        (fixture.source / formula["formula_source"]["path"]).write_bytes(
            changed_source
        )
        changed_sha256 = sha256(changed_source)
        formula["formula_source"].update(
            {
                "identity_excluding_bottle_sha256": changed_sha256,
                "sha256": changed_sha256,
            }
        )
        fixture.campaign["authority"]["source_materialization"][
            "tree_git_oid"
        ] = EXECUTOR.filesystem_git_tree_oid(
            fixture.source, "changed Formula target source"
        )
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "changed-formula-successor"

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "predecessor campaign changes a bottle input",
        ):
            fixture.derive(output)
        self.assertFalse(output.exists())

    def test_predecessor_reuse_rejects_changed_build_test_version(
        self,
    ) -> None:
        fixture = PredecessorDependencyReuseFixture(
            scoped_dependency=True
        )
        self.addCleanup(fixture.close)
        fixture.formulae[0]["version"] = "1.1"
        fixture.target_formula["dependencies"][0]["version"] = "1.1"
        write_json(fixture.campaign_path, fixture.campaign)
        output = fixture.root / "changed-build-test-version"

        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "predecessor campaign changes a bottle input",
        ):
            fixture.derive(output)
        self.assertFalse(output.exists())

    def test_predecessor_reuse_authority_fails_closed(self) -> None:
        def schema_two(fixture: PredecessorReuseFixture) -> None:
            fixture.campaign["schema"] = 2

        def wrong_archive_name(fixture: PredecessorReuseFixture) -> None:
            record = fixture.campaign["authority"][
                "predecessor_recovery"
            ][0]
            record["archive"]["path"] = (
                "Kandelo/campaigns/prefix-v1/aborted-campaigns/"
                + "9" * 64
                + ".json"
            )

        def missing_recovery_source(
            fixture: PredecessorReuseFixture,
        ) -> None:
            del fixture.campaign["authority"][
                "predecessor_recovery_source"
            ]

        def wrong_recovery_repository(
            fixture: PredecessorReuseFixture,
        ) -> None:
            fixture.campaign["authority"][
                "predecessor_recovery_source"
            ]["repository"] = "example/other-tap"

        def unknown_campaign(fixture: PredecessorReuseFixture) -> None:
            fixture.formulae[0]["variants"][0]["reuse_source"][
                "campaign_tag"
            ] = "homebrew-prefix-campaign-sha256-" + "9" * 64

        def reuse_without_presence(
            fixture: PredecessorReuseFixture,
        ) -> None:
            admission = fixture.formulae[0]["destination"]["admission"]
            admission["kind"] = "anonymous-absence"
            admission["probe"]["digest"] = None
            admission["probe"]["status"] = "missing"

        for label, mutate in (
            ("schema-two", schema_two),
            ("missing-recovery-source", missing_recovery_source),
            ("wrong-recovery-repository", wrong_recovery_repository),
            ("wrong-archive-name", wrong_archive_name),
            ("unknown-campaign", unknown_campaign),
            ("reuse-without-presence", reuse_without_presence),
        ):
            with self.subTest(label=label):
                fixture = PredecessorReuseFixture()
                try:
                    mutate(fixture)
                    write_json(fixture.campaign_path, fixture.campaign)
                    with self.assertRaises(EXECUTOR.ExecutorError):
                        EXECUTOR.load_campaign(fixture.campaign_path)
                finally:
                    fixture.close()

    def test_predecessor_reuse_scoped_recovery_checkout_fails_closed(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        recovery = fixture.root / "recovery-tap"
        recovery.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=recovery, check=True)
        scope_relative = (
            "Kandelo/campaigns/prefix-v1/successor/fixture-scope.json"
        )
        scope_path = recovery / scope_relative
        write_json(
            scope_path,
            {"kind": "fixture-successor-scope", "schema": 1},
        )
        recovery_commit = commit_repo(
            recovery, "bind predecessor reuse successor scope"
        )
        fixture.campaign["authority"]["predecessor_recovery_source"][
            "commit"
        ] = recovery_commit
        fixture.campaign["authority"]["successor_scope"] = {
            "path": scope_relative,
            "sha256": sha256(scope_path.read_bytes()),
        }
        write_json(fixture.campaign_path, fixture.campaign)

        valid = fixture.root / "scoped-predecessor-reuse"
        fixture.derive(valid, recovery_tap_root=recovery)
        self.assertTrue((valid / "handoff.json").is_file())

        missing = fixture.root / "missing-recovery-checkout"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "requires a recovery tap checkout",
        ):
            fixture.derive(missing)
        self.assertFalse(missing.exists())

        write_json(recovery / "later.json", {"schema": 1})
        commit_repo(recovery, "move recovery checkout past authority")
        wrong = fixture.root / "wrong-recovery-checkout"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "does not name the campaign's exact commit",
        ):
            fixture.derive(wrong, recovery_tap_root=recovery)
        self.assertFalse(wrong.exists())
        subprocess.run(
            [
                "git",
                "-c",
                "advice.detachedHead=false",
                "checkout",
                "--detach",
                "--quiet",
                recovery_commit,
            ],
            cwd=recovery,
            check=True,
        )

        fixture.campaign["authority"]["successor_scope"][
            "sha256"
        ] = "0" * 64
        write_json(fixture.campaign_path, fixture.campaign)
        changed_digest = fixture.root / "changed-recovery-scope-digest"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its recovery authority",
        ):
            fixture.derive(
                changed_digest,
                recovery_tap_root=recovery,
            )
        self.assertFalse(changed_digest.exists())

    def test_predecessor_reuse_legacy_scope_omission_remains_valid(
        self,
    ) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        output = fixture.root / "legacy-unscoped-predecessor-reuse"
        fixture.derive(output)
        self.assertTrue((output / "handoff.json").is_file())

    def test_successor_scope_authority_is_optional_and_exact(self) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)

        # Schema-3 campaigns sealed before successor scopes remain readable.
        EXECUTOR.load_campaign(fixture.campaign_path)
        self.assertIsNone(
            EXECUTOR.successor_scope_authority(
                fixture.campaign["authority"], 3
            )
        )

        record = {
            "path": (
                "Kandelo/campaigns/prefix-v1/successor/"
                "f901-successor-scope.json"
            ),
            "sha256": "6" * 64,
        }
        fixture.campaign["authority"]["successor_scope"] = record
        write_json(fixture.campaign_path, fixture.campaign)
        EXECUTOR.load_campaign(fixture.campaign_path)
        self.assertEqual(
            EXECUTOR.successor_scope_authority(
                fixture.campaign["authority"], 3
            ),
            record,
        )

        baseline = copy.deepcopy(fixture.campaign)
        mutations = {
            "missing-path": lambda value: value["authority"][
                "successor_scope"
            ].pop("path"),
            "extra-field": lambda value: value["authority"][
                "successor_scope"
            ].__setitem__("archive", "not-authority"),
            "unsafe-path": lambda value: value["authority"][
                "successor_scope"
            ].__setitem__("path", "../scope.json"),
            "bad-digest": lambda value: value["authority"][
                "successor_scope"
            ].__setitem__("sha256", "invalid"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                changed = copy.deepcopy(baseline)
                mutate(changed)
                write_json(fixture.campaign_path, changed)
                with self.assertRaises(EXECUTOR.ExecutorError):
                    EXECUTOR.load_campaign(fixture.campaign_path)

        schema_two = Fixture()
        self.addCleanup(schema_two.close)
        schema_two.campaign["authority"]["successor_scope"] = record
        write_json(schema_two.campaign_path, schema_two.campaign)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "only a schema-3 campaign",
        ):
            EXECUTOR.load_campaign(schema_two.campaign_path)

    def test_predecessor_reuse_rejects_tampering(self) -> None:
        fixture = PredecessorReuseFixture()
        self.addCleanup(fixture.close)
        archive = (
            fixture.predecessor_handoff
            / "payload/wasm32/build/bottle.tar.gz"
        )
        archive.write_bytes(archive.read_bytes() + b"substitution")
        with self.assertRaises(EXECUTOR.ExecutorError):
            fixture.derive(fixture.root / "rejected-predecessor")

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

        child = fixture.root / "reuse-oci-child"
        EXECUTOR.compose_reuse_child(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            handoff_root=handoff,
            formula_name="alpha",
            arch="wasm32",
            output=child,
        )
        child_receipt = json.loads(
            (child / "receipt.json").read_text()
        )
        self.assertEqual(child_receipt["schema"], 2)
        self.assertEqual(child_receipt["kind"], "child")
        self.assertEqual(child_receipt["top_ref"], "1.0-1")
        self.assertEqual(
            child_receipt["oci"]["homebrew_ref"],
            "1.0.wasm32_kandelo.1",
        )
        self.assertEqual(
            child_receipt["bottle"],
            {
                "bytes": fixture.old_record["bytes"],
                "sha256": fixture.old_record["sha256"],
                "url": fixture.old_record["url"],
            },
        )
        self.assertEqual(
            child_receipt["formula_source_sha256"],
            fixture.old_record["built_from"]["formula_sha256"],
        )
        self.assertEqual(
            child_receipt["formula_source_identity_sha256"],
            fixture.formulae[0]["formula_source"][
                "identity_excluding_bottle_sha256"
            ],
        )
        self.assertEqual(
            (child / "layout/blobs/sha256" /
             fixture.old_record["sha256"]).read_bytes(),
            fixture.archive,
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

    def test_reuse_oci_child_rejects_substituted_inputs_and_output(
        self,
    ) -> None:
        wrong_kind = ReuseFixture()
        self.addCleanup(wrong_kind.close)
        wrong_kind_handoff = wrong_kind.root / "wrong-kind-handoff"
        wrong_kind.derive_reuse(wrong_kind_handoff)
        manifest_path = wrong_kind_handoff / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["publications"][0]["kind"] = "build"
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "file inventory is invalid",
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=wrong_kind.campaign_path,
                source_tap_root=wrong_kind.source,
                handoff_root=wrong_kind_handoff,
                formula_name="alpha",
                arch="wasm32",
                output=wrong_kind.root / "wrong-kind-child",
            )

        wrong_formula = ReuseFixture()
        self.addCleanup(wrong_formula.close)
        wrong_formula_handoff = wrong_formula.root / "wrong-formula-handoff"
        wrong_formula.derive_reuse(wrong_formula_handoff)
        manifest_path = wrong_formula_handoff / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["formula"] = EXECUTOR.campaign_formula_evidence(
            wrong_formula.campaign,
            wrong_formula.formulae[1],
        )
        write_json(manifest_path, manifest)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "beta/wasm32 reuse variant|another Formula",
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=wrong_formula.campaign_path,
                source_tap_root=wrong_formula.source,
                handoff_root=wrong_formula_handoff,
                formula_name="alpha",
                arch="wasm32",
                output=wrong_formula.root / "wrong-formula-child",
            )

        wrong_arch = ReuseFixture()
        self.addCleanup(wrong_arch.close)
        wrong_arch_handoff = wrong_arch.root / "wrong-arch-handoff"
        wrong_arch.derive_reuse(wrong_arch_handoff)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "not one campaign variant",
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=wrong_arch.campaign_path,
                source_tap_root=wrong_arch.source,
                handoff_root=wrong_arch_handoff,
                formula_name="alpha",
                arch="wasm64",
                output=wrong_arch.root / "wrong-arch-child",
            )

        tampered = ReuseFixture()
        self.addCleanup(tampered.close)
        tampered_handoff = tampered.root / "tampered-archive-handoff"
        tampered.derive_reuse(tampered_handoff)
        with (
            tampered_handoff
            / "payload/wasm32/reuse/bottle.tar.gz"
        ).open("ab") as archive:
            archive.write(b"tampered")
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its manifest",
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=tampered.campaign_path,
                source_tap_root=tampered.source,
                handoff_root=tampered_handoff,
                formula_name="alpha",
                arch="wasm32",
                output=tampered.root / "tampered-archive-child",
            )

        receipt = ReuseFixture()
        self.addCleanup(receipt.close)
        receipt_handoff = receipt.root / "tampered-receipt-handoff"
        receipt.derive_reuse(receipt_handoff)
        original_runner = EXECUTOR.run_oci_layout_command

        def tamper_receipt(arguments: list[str], label: str) -> None:
            original_runner(arguments, label)
            if arguments[0] != "validate-child":
                return
            path = pathlib.Path(
                arguments[arguments.index("--receipt") + 1]
            )
            value = json.loads(path.read_text())
            value["formula_revision"] = 7
            write_json(path, value)

        with (
            mock.patch.object(
                EXECUTOR,
                "run_oci_layout_command",
                side_effect=tamper_receipt,
            ),
            self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "wrong formula_revision",
            ),
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=receipt.campaign_path,
                source_tap_root=receipt.source,
                handoff_root=receipt_handoff,
                formula_name="alpha",
                arch="wasm32",
                output=receipt.root / "tampered-receipt-child",
            )
        self.assertFalse(
            (receipt.root / "tampered-receipt-child").exists()
        )

        existing = ReuseFixture()
        self.addCleanup(existing.close)
        existing_handoff = existing.root / "existing-output-handoff"
        existing.derive_reuse(existing_handoff)
        existing_output = existing.root / "existing-output"
        existing_output.mkdir()
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "already exists",
        ):
            EXECUTOR.compose_reuse_child(
                campaign_path=existing.campaign_path,
                source_tap_root=existing.source,
                handoff_root=existing_handoff,
                formula_name="alpha",
                arch="wasm32",
                output=existing_output,
            )

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
        handoffs = fixture.split_handoffs()
        output = fixture.root / "final-candidate"
        finalization_path = fixture.root / "finalization.json"
        merge_order: list[tuple[str, str]] = []

        def record_merge(**arguments: Any) -> None:
            merge_order.append(
                (arguments["formula"], arguments["arch"])
            )
            fixture.merge_dependency(**arguments)

        fixture.prepare_final(
            [
                handoffs[("beta", "wasm64")],
                handoffs[("alpha", "wasm32")],
                handoffs[("beta", "wasm32")],
                handoffs[("alpha", "wasm64")],
            ],
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
            ".github/workflows/base-contract-checks.yml",
            ".github/workflows/contract-checks.yml",
            ".github/workflows/dry-run-bottles.yml",
            ".github/workflows/repository-namespace-canary.yml",
            "Kandelo/README.md",
            "Kandelo/campaigns/prefix-v1/README.md",
            "Kandelo/campaigns/prefix-v1/verify.py",
            "Kandelo/formula_support/test/"
            "kandelo_formula_support_test.rb",
            "Kandelo/publisher-trust-rotation.md",
            "Kandelo/test-workflow-trust.rb",
            "scripts/prefix-campaign-source.py",
            "scripts/prefix-campaign-controller.py",
            "scripts/rotate-publisher-trust.py",
            "scripts/test_prefix_campaign_controller.py",
            "scripts/test_prefix_campaign_source.py",
            "scripts/test_rotate_publisher_trust.py",
        ):
            self.assertTrue((output / relative).is_file(), relative)
            self.assertEqual(
                (output / relative).read_bytes(),
                (fixture.live / relative).read_bytes(),
                relative,
            )
        live_inventory = {
            path: identity
            for path, identity in EXECUTOR.filesystem_git_leaf_inventory(
                fixture.live,
                "final tap fixture live inventory",
            ).items()
            if path != ".git" and not path.startswith(".git/")
        }
        output_inventory = EXECUTOR.filesystem_git_leaf_inventory(
            output,
            "final tap fixture output inventory",
        )
        expected_deleted = {
            path
            for path in live_inventory
            if any(
                path == retired or path.startswith(f"{retired}/")
                for retired in EXECUTOR.CAMPAIGN_RETIREMENT_PATHS
            )
        }
        self.assertEqual(
            set(live_inventory) - set(output_inventory),
            expected_deleted,
        )
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
                "source",
            },
        )
        self.assertEqual(
            finalization_path.read_bytes(),
            EXECUTOR.pretty_json(finalization),
        )
        self.assertEqual(
            [value["formula"] for value in finalization["handoffs"]],
            ["alpha", "alpha", "beta", "beta"],
        )
        self.assertEqual(
            [value["arch"] for value in finalization["handoffs"]],
            ["wasm32", "wasm64", "wasm32", "wasm64"],
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
        self.assertEqual(finalization["source"], fixture.source_provenance)
        self.assertEqual(
            subprocess.check_output(
                ["git", "status", "--porcelain=v1"],
                cwd=fixture.live,
            ),
            b"",
        )
        self.assertFalse((output / ".git").exists())

    def test_final_tap_requires_exact_campaign_variant_union(self) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        handoffs = fixture.split_handoffs()
        complete = list(handoffs.values())
        cases = (
            (
                "missing-sibling",
                [
                    root
                    for key, root in handoffs.items()
                    if key != ("alpha", "wasm64")
                ],
                "handoff variants differ.*alpha.*wasm64",
            ),
            (
                "duplicate-variant",
                [handoffs[("alpha", "wasm32")], *complete],
                "handoff alpha/wasm32 is duplicated",
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

    def test_final_tap_rejects_substituted_architecture(self) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        handoffs = fixture.split_handoffs()
        substituted = fixture.root / "substituted-alpha-architecture"
        shutil.copytree(handoffs[("alpha", "wasm32")], substituted)
        manifest_path = substituted / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        publication = manifest["publications"][0]
        publication["arch"] = "wasm64"
        for record in publication["files"]:
            record["path"] = record["path"].replace(
                "payload/wasm32/", "payload/wasm64/", 1
            )
            record["asset_name"] = record["asset_name"].replace(
                "wasm32.", "wasm64.", 1
            )
        (substituted / "payload/wasm32").rename(
            substituted / "payload/wasm64"
        )
        write_json(manifest_path, manifest)

        output = fixture.root / "wrong-arch"
        receipt = fixture.root / "wrong-arch.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "handoff variants differ.*alpha.*wasm32",
        ):
            fixture.prepare_final(
                [
                    substituted,
                    handoffs[("beta", "wasm32")],
                    handoffs[("beta", "wasm64")],
                ],
                output,
                receipt,
            )
        self.assertFalse(output.exists())
        self.assertFalse(receipt.exists())

    def test_final_tap_requires_same_arch_dependency_identity(self) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        handoffs = fixture.split_handoffs()
        substituted = fixture.root / "substituted-beta-dependency"
        shutil.copytree(handoffs[("beta", "wasm64")], substituted)
        manifest_path = substituted / "handoff.json"
        manifest = json.loads(manifest_path.read_text())
        alpha_wasm32_payload = (
            handoffs[("alpha", "wasm32")] / "handoff.json"
        ).read_bytes()
        alpha_wasm32_digest = sha256(alpha_wasm32_payload)
        manifest["dependency_handoffs"][0].update(
            {
                "manifest_sha256": alpha_wasm32_digest,
                "tag": EXECUTOR.handoff_tag(alpha_wasm32_payload),
            }
        )
        write_json(manifest_path, manifest)

        output = fixture.root / "wrong-dependency-arch"
        receipt = fixture.root / "wrong-dependency-arch.json"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependencies differ from the exact campaign closure",
        ):
            fixture.prepare_final(
                [
                    handoffs[("alpha", "wasm32")],
                    handoffs[("alpha", "wasm64")],
                    handoffs[("beta", "wasm32")],
                    substituted,
                ],
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

    def test_final_tap_rejects_every_non_control_live_change(self) -> None:
        cases = (
            ("unreviewed-workflow", ".github/workflows/unreviewed.yml"),
            ("modified-overlay", "Formula/alpha.rb"),
            ("changed-formula", "Formula/gamma.rb"),
            ("added-formula", "Formula/rogue.rb"),
            ("changed-recipe", "Kandelo/recipes/alpha.json"),
            (
                "changed-formula-support",
                "Kandelo/formula_support/test/"
                "kandelo_formula_support_test.rb",
            ),
        )
        for label, relative in cases:
            with self.subTest(label=label):
                fixture = FinalTapFixture()
                self.addCleanup(fixture.close)
                alpha, beta = fixture.complete_handoffs()
                path = fixture.live / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                prior = path.read_bytes() if path.is_file() else b""
                path.write_bytes(prior + f"# {label}\n".encode())
                fixture.refresh_live(label)
                output = fixture.root / f"{label}-candidate"
                receipt = fixture.root / f"{label}-finalization.json"
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    "outside the reviewed campaign-control paths.*"
                    + re.escape(relative),
                ):
                    fixture.prepare_final(
                        [alpha, beta],
                        output,
                        receipt,
                    )
                self.assertFalse(output.exists())
                self.assertFalse(receipt.exists())

    def test_final_tap_rejects_wrong_base_tree_and_ancestry(self) -> None:
        def rebind_source_base(
            fixture: FinalTapFixture,
            *,
            commit: str,
            tree: str,
            message: str,
        ) -> None:
            manifest_path = fixture.live / EXECUTOR.SOURCE_MANIFEST_PATH
            manifest = json.loads(manifest_path.read_text())
            manifest["base"] = {"commit": commit, "tree_git_oid": tree}
            write_json(manifest_path, manifest)
            authority_path = fixture.live / EXECUTOR.SOURCE_AUTHORITY_PATH
            authority = json.loads(authority_path.read_text())
            authority["target_source"]["manifest_sha256"] = sha256(
                manifest_path.read_bytes()
            )
            write_json(authority_path, authority)
            fixture.refresh_live(message)
            materialization = fixture.campaign["authority"][
                "source_materialization"
            ]
            materialization["authority"]["sha256"] = sha256(
                authority_path.read_bytes()
            )
            materialization["manifest"]["sha256"] = sha256(
                manifest_path.read_bytes()
            )
            fixture.campaign["authority"]["source_tap_commit"] = (
                fixture.live_commit
            )
            write_json(fixture.campaign_path, fixture.campaign)

        for label in ("wrong-tree", "unrelated-commit"):
            with self.subTest(label=label):
                fixture = FinalTapFixture()
                self.addCleanup(fixture.close)
                if label == "wrong-tree":
                    base_commit = fixture.base_commit
                    base_tree = fixture.live_tree
                    expected = "sealed base commit has the wrong tree"
                else:
                    base_commit = subprocess.check_output(
                        [
                            "git",
                            "-c",
                            "user.name=Campaign fixture",
                            "-c",
                            "user.email=campaign@example.invalid",
                            "commit-tree",
                            fixture.base_tree,
                            "-m",
                            "unrelated sealed base",
                        ],
                        cwd=fixture.live,
                        text=True,
                    ).strip()
                    base_tree = fixture.base_tree
                    expected = "sealed base is not an ancestor"
                rebind_source_base(
                    fixture,
                    commit=base_commit,
                    tree=base_tree,
                    message=f"bind {label} base",
                )
                snapshots = fixture.root / f"{label}-snapshots"
                snapshots.mkdir()
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    expected,
                ):
                    EXECUTOR.prepare_live_source_replay(
                        campaign=fixture.campaign,
                        source_root=fixture.source,
                        live_tap_root=fixture.live,
                        expected_live_commit=fixture.live_commit,
                        expected_live_tree_git_oid=fixture.live_tree,
                        snapshot_root=snapshots,
                    )

    def test_final_tap_rejects_non_descendant_live_parent(self) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        orphan = subprocess.check_output(
            [
                "git",
                "-c",
                "user.name=Campaign fixture",
                "-c",
                "user.email=campaign@example.invalid",
                "commit-tree",
                fixture.live_tree,
                "-m",
                "unrelated live parent",
            ],
            cwd=fixture.live,
            text=True,
        ).strip()
        subprocess.run(
            ["git", "checkout", "--detach", "--quiet", orphan],
            cwd=fixture.live,
            check=True,
        )
        fixture.live_commit = orphan
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "does not contain the campaign source commit",
        ):
            fixture.prepare_final(
                [alpha, beta],
                fixture.root / "unrelated-live-candidate",
                fixture.root / "unrelated-live-finalization.json",
            )

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

    def test_sealed_overlay_replay_accepts_absent_and_target_preimages(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        source_commit = EXECUTOR.git_snapshot(
            fixture.live,
            fixture.source_commit,
            fixture.root / "idempotent-source-commit",
            "idempotent replay source commit",
        )
        _provenance, records = EXECUTOR.load_source_overlay_contract(
            source_commit,
            fixture.campaign,
        )
        self.assertTrue(any(base is None for _path, base, _target in records))
        candidate = EXECUTOR.git_snapshot(
            fixture.live,
            fixture.base_commit,
            fixture.root / "idempotent-replay",
            "idempotent replay base",
        )
        overlay = (
            source_commit
            / fixture.campaign["authority"]["source_materialization"][
                "source_root"
            ]
        )

        for iteration in ("base", "target"):
            EXECUTOR.replay_overlay_files(
                tap_root=candidate,
                source_root=overlay,
                records=records,
                label=f"idempotent {iteration} replay",
            )

        self.assertEqual(
            EXECUTOR.filesystem_git_tree_oid(
                candidate,
                "idempotent replay candidate",
            ),
            fixture.source_tree,
        )

    def test_final_tap_requires_every_retirement_path(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        alpha, beta = fixture.complete_handoffs()
        (
            fixture.live
            / ".github/workflows/prefix-campaign-bottles.yml"
        ).unlink()
        fixture.refresh_live("remove required retirement path")
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

        source_candidate = fixture.root / "substituted-source-candidate"
        shutil.copytree(candidate, source_candidate)
        completion_path = (
            source_candidate / EXECUTOR.CAMPAIGN_COMPLETION_PATH
        )
        completion = json.loads(completion_path.read_text())
        completion["source"]["source_tap_tree_git_oid"] = "f" * 40
        write_json(completion_path, completion)
        source_finalization = fixture.root / "substituted-source.json"
        source_value = json.loads(finalization.read_text())
        source_value["source"] = completion["source"]
        source_value["completion"]["sha256"] = sha256(
            completion_path.read_bytes()
        )
        source_value["candidate"]["tree_git_oid"] = (
            EXECUTOR.filesystem_git_tree_oid(
                source_candidate,
                "substituted source candidate",
            )
        )
        write_json(source_finalization, source_value)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "live history differs from its source replay",
        ):
            EXECUTOR.create_final_tap_commit(
                candidate_tap_root=source_candidate,
                finalization_path=source_finalization,
                live_tap_root=fixture.live,
                output_ref="refs/heads/substituted-source",
                commit_receipt_output=(
                    fixture.root / "substituted-source-commit.json"
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
        (fixture.source / "Aliases").mkdir()
        os.symlink(
            "../Formula/alpha.rb", fixture.source / "Aliases/alpha"
        )
        os.symlink(
            "../Formula/beta.rb", fixture.source / "Aliases/beta"
        )
        fixture.campaign["authority"]["source_materialization"][
            "tree_git_oid"
        ] = EXECUTOR.filesystem_git_tree_oid(
            fixture.source, "fixture source with aliases"
        )
        write_json(fixture.campaign_path, fixture.campaign)
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
        self.assertTrue((output / "tap/Aliases/alpha").is_symlink())
        self.assertEqual(
            os.readlink(output / "tap/Aliases/alpha"),
            "../Formula/alpha.rb",
        )
        self.assertFalse(
            (output / "tap/Aliases/beta").exists()
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

    def test_closed_selection_accepts_only_supported_cellar_identities(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        handoff = fixture.root / "symbolic-cellar-handoff"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            handoff,
        )

        bottle_path = handoff / "payload/wasm32/build/bottle.json"

        def set_cellar(value: str) -> None:
            bottle = json.loads(bottle_path.read_text())
            bottle[f"{TAP_NAME}/alpha"]["bottle"]["cellar"] = value
            write_json(bottle_path, bottle)
            manifest_path = handoff / "handoff.json"
            manifest = json.loads(manifest_path.read_text())
            record = next(
                item
                for item in manifest["publications"][0]["files"]
                if item["path"]
                == "payload/wasm32/build/bottle.json"
            )
            record["bytes"] = bottle_path.stat().st_size
            record["sha256"] = sha256(bottle_path.read_bytes())
            write_json(manifest_path, manifest)

        observed_cellars: list[str] = []

        def merge_symbolic(**arguments: Any) -> None:
            observed_cellars.append(arguments["cellar"])
            fixture.merge_dependency(**arguments)

        accepted = (
            "/opt/kandelo/homebrew/Cellar",
            "any",
            "any_skip_relocation",
        )
        for position, cellar in enumerate(accepted):
            with self.subTest(accepted_cellar=cellar):
                set_cellar(cellar)
                EXECUTOR.prepare_selection(
                    campaign_path=fixture.campaign_path,
                    source_tap_root=fixture.source,
                    roots=["alpha"],
                    arch="wasm32",
                    handoff_roots=[handoff],
                    output=fixture.root / f"accepted-cellar-{position}",
                    bottle_merger=merge_symbolic,
                    sidecar_generator=fixture.generate_sidecars,
                    tap_validator=fixture.validate_tap,
                )
        self.assertEqual(observed_cellars, list(accepted))

        retired_prefix = json.loads(
            (ROOT / "homebrew/kandelo-guest-layout.json").read_text()
        )["retired_prefixes"][0]
        rejected = (
            f"{retired_prefix}/Cellar",
            "/usr/local/Cellar",
            "unknown_relocation_mode",
        )
        for position, cellar in enumerate(rejected):
            with self.subTest(rejected_cellar=cellar), self.assertRaisesRegex(
                EXECUTOR.ExecutorError,
                "bottle cellar is not the Kandelo prefix",
            ):
                set_cellar(cellar)
                EXECUTOR.prepare_selection(
                    campaign_path=fixture.campaign_path,
                    source_tap_root=fixture.source,
                    roots=["alpha"],
                    arch="wasm32",
                    handoff_roots=[handoff],
                    output=fixture.root / f"rejected-cellar-{position}",
                    bottle_merger=fixture.merge_dependency,
                    sidecar_generator=fixture.generate_sidecars,
                    tap_validator=fixture.validate_tap,
                )

    def test_closed_selection_release_is_deterministic_and_round_trips(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "selection-release-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        selection = fixture.root / "selection-release-candidate"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha"],
            arch="wasm32",
            handoff_roots=[alpha],
            output=selection,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )
        hidden = selection / "tap/.github/workflows/selection.yml"
        hidden.parent.mkdir(parents=True)
        hidden.write_text("name: preserved inside selection archive\n")
        executable = selection / "tap/scripts/selection-proof"
        executable.parent.mkdir()
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        alias = selection / "tap/Aliases/alpha"
        alias.parent.mkdir()
        os.symlink("../Formula/alpha.rb", alias)
        selection_value = json.loads(
            (selection / "selection.json").read_text()
        )
        selection_value["tap"]["prepared_tree_git_oid"] = (
            EXECUTOR.filesystem_git_tree_oid(
                selection / "tap",
                "selection with hidden and executable paths",
            )
        )
        write_json(selection / "selection.json", selection_value)
        first = fixture.root / "selection-release-first"
        second = fixture.root / "selection-release-second"
        EXECUTOR.prepare_selection_release(
            selection_root=selection, output=first
        )
        EXECUTOR.prepare_selection_release(
            selection_root=selection, output=second
        )
        self.assertEqual(
            (first / "release-manifest.json").read_bytes(),
            (second / "release-manifest.json").read_bytes(),
        )
        for name in (
            EXECUTOR.SELECTION_DESCRIPTOR_ASSET,
            EXECUTOR.SELECTION_ARCHIVE_ASSET,
        ):
            self.assertEqual(
                (first / "assets" / name).read_bytes(),
                (second / "assets" / name).read_bytes(),
            )
        manifest = json.loads(
            (first / "release-manifest.json").read_text()
        )
        self.assertIn(
            "not the complete tap catalog", manifest["body"]
        )
        descriptor, _payload, observed_manifest = (
            EXECUTOR.load_prepared_selection_release(first)
        )
        self.assertEqual(observed_manifest, manifest)
        inventory = descriptor["tap_archive"]["inventory"]
        self.assertEqual(
            descriptor["tap_archive"]["format"], "zip-stored-v2"
        )
        self.assertIn(
            ".github/workflows/selection.yml",
            {record["path"] for record in inventory},
        )
        executable_record = next(
            record
            for record in inventory
            if record["path"] == "scripts/selection-proof"
        )
        self.assertEqual(executable_record["mode"], "100755")
        alias_record = next(
            record
            for record in inventory
            if record["path"] == "Aliases/alpha"
        )
        self.assertEqual(alias_record["mode"], "120000")
        self.assertEqual(alias_record["target"], "../Formula/alpha.rb")

        snapshot = fixture.root / "selection-release-snapshot"
        EXECUTOR.snapshot_selection_release(
            prepared_root=first,
            output=snapshot,
        )
        self.assertEqual(
            EXECUTOR.filesystem_git_leaf_inventory(
                first, "prepared release"
            ),
            EXECUTOR.filesystem_git_leaf_inventory(
                snapshot, "snapshotted prepared release"
            ),
        )
        fetch_json, fetch_asset, _release = release_fetchers(first)
        output = fixture.root / "selection-release-readback"
        receipt = fixture.root / "selection-release-receipt.json"
        EXECUTOR.fetch_selection_release(
            repository=TAP_REPOSITORY,
            tag=manifest["tag"],
            output=output,
            receipt_output=receipt,
            json_fetcher=fetch_json,
            asset_fetcher=fetch_asset,
        )
        self.assertEqual(
            (selection / "selection.json").read_bytes(),
            (output / "selection.json").read_bytes(),
        )
        self.assertEqual(
            EXECUTOR.filesystem_git_tree_oid(
                selection / "tap", "source selected tap"
            ),
            EXECUTOR.filesystem_git_tree_oid(
                output / "tap", "downloaded selected tap"
            ),
        )
        self.assertTrue((output / "tap/Aliases/alpha").is_symlink())
        self.assertEqual(
            os.readlink(output / "tap/Aliases/alpha"),
            "../Formula/alpha.rb",
        )
        receipt_value = json.loads(receipt.read_text())
        self.assertEqual(
            receipt_value["visibility"],
            "public-anonymous-readback",
        )
        self.assertEqual(receipt_value["formula_count"], 1)
        verification = fixture.root / "selection-verification.json"
        EXECUTOR.verify_selection_readback(
            selection_root=output,
            receipt_path=receipt,
            output=verification,
        )
        report = json.loads(verification.read_text())
        self.assertEqual(
            report["kind"],
            "kandelo-homebrew-closed-selection-verification",
        )
        self.assertEqual(report["formulae"], ["alpha"])
        self.assertEqual(report["kandelo_abi"], 42)
        self.assertEqual(report["source_tap_commit"], SOURCE_TAP_COMMIT)
        self.assertEqual(
            report["readback"]["visibility"],
            "public-anonymous-readback",
        )

        receipt_mutations = {
            "architecture": lambda value: value.__setitem__(
                "arch", "wasm64"
            ),
            "Formula count": lambda value: value.__setitem__(
                "formula_count", 2
            ),
            "manifest digest": lambda value: value.__setitem__(
                "selection_manifest_sha256", "e" * 64
            ),
            "prepared tree": lambda value: value.__setitem__(
                "prepared_tree_git_oid", "f" * 40
            ),
            "release repository": lambda value: value.__setitem__(
                "repository", "example/other-tap"
            ),
            "release target": lambda value: value.__setitem__(
                "target_commitish", "e" * 40
            ),
            "roots": lambda value: value.__setitem__(
                "roots", ["beta"]
            ),
            "visibility": lambda value: value.__setitem__(
                "visibility", "authenticated-readback"
            ),
        }
        for position, (label, mutate) in enumerate(
            receipt_mutations.items()
        ):
            with self.subTest(receipt_mutation=label):
                changed = json.loads(receipt.read_text())
                mutate(changed)
                changed_receipt = (
                    fixture.root / f"changed-receipt-{position}.json"
                )
                write_json(changed_receipt, changed)
                rejected = fixture.root / f"rejected-report-{position}.json"
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    "unsupported|differs|canonical",
                ):
                    EXECUTOR.verify_selection_readback(
                        selection_root=output,
                        receipt_path=changed_receipt,
                        output=rejected,
                    )
                self.assertFalse(rejected.exists())

        (output / "tap/Formula/alpha.rb").write_text(
            "class Substituted < Formula\nend\n"
        )
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its prepared Git tree",
        ):
            EXECUTOR.verify_selection_readback(
                selection_root=output,
                receipt_path=receipt,
                output=fixture.root / "substituted-tree-report.json",
            )

    def test_materialize_campaign_source_uses_kandelo_authority(self) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        checkout = fixture.root / "materializer-source-checkout"
        subprocess.run(
            ["git", "clone", "-q", "--no-hardlinks", fixture.live, checkout],
            check=True,
        )
        subprocess.run(
            ["git", "checkout", "--detach", "--quiet", fixture.source_commit],
            cwd=checkout,
            check=True,
        )
        output = fixture.root / "materialized-campaign-source"
        EXECUTOR.materialize_campaign_source(
            campaign_path=fixture.campaign_path,
            source_tap_root=checkout,
            output=output,
        )
        self.assertEqual(
            EXECUTOR.filesystem_git_leaf_inventory(
                output, "materialized campaign source"
            ),
            EXECUTOR.filesystem_git_leaf_inventory(
                fixture.source, "expected sealed campaign source"
            ),
        )
        self.assertFalse(
            (output / ".github/workflows/dry-run-bottles.yml").exists()
        )

        subprocess.run(
            ["git", "checkout", "--detach", "--quiet", fixture.live_commit],
            cwd=checkout,
            check=True,
        )
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "exact commit",
        ):
            EXECUTOR.materialize_campaign_source(
                campaign_path=fixture.campaign_path,
                source_tap_root=checkout,
                output=fixture.root / "wrong-source-output",
            )

    def test_materialize_campaign_source_rechecks_successor_scope(
        self,
    ) -> None:
        fixture = FinalTapFixture()
        self.addCleanup(fixture.close)
        subprocess.run(
            [
                "git",
                "checkout",
                "--detach",
                "--quiet",
                fixture.source_commit,
            ],
            cwd=fixture.live,
            check=True,
        )
        scope_relative = (
            "Kandelo/campaigns/prefix-v1/successor/"
            "fixture-scope.json"
        )
        scope_path = fixture.live / scope_relative
        write_json(
            scope_path,
            {
                "kind": "fixture-successor-scope",
                "schema": 1,
            },
        )
        recovery_scope_payload = scope_path.read_bytes()
        scoped_recovery_commit = commit_repo(
            fixture.live,
            "bind fixture successor scope",
        )
        # The two Git authorities are deliberately distinct. The executor
        # must read the scope from recovery, not whichever bytes happen to be
        # present at the Formula source commit.
        write_json(
            scope_path,
            {
                "kind": "later-source-control-bytes",
                "schema": 1,
            },
        )
        scoped_source_commit = commit_repo(
            fixture.live,
            "advance Formula source control bytes",
        )

        campaign_sha256 = "7" * 64
        campaign_tag = (
            "homebrew-prefix-campaign-sha256-" + campaign_sha256
        )
        fixture.campaign["schema"] = 3
        fixture.campaign["authority"]["source_tap_commit"] = (
            scoped_source_commit
        )
        fixture.campaign["authority"]["predecessor_recovery_source"] = {
            "commit": scoped_recovery_commit,
            "repository": TAP_REPOSITORY,
        }
        fixture.campaign["authority"]["predecessor_recovery"] = [
            {
                "activation_commit": "3" * 40,
                "archive": {
                    "path": (
                        "Kandelo/campaigns/prefix-v1/"
                        "aborted-campaigns/"
                        f"{campaign_sha256}.json"
                    ),
                    "sha256": "4" * 64,
                },
                "campaign": {
                    "sha256": campaign_sha256,
                    "tag": campaign_tag,
                },
                "kandelo_commit": "5" * 40,
                "source_tap_commit": "6" * 40,
                "target_tree_git_oid": fixture.source_tree,
            }
        ]
        fixture.campaign["authority"]["successor_scope"] = {
            "path": scope_relative,
            "sha256": sha256(recovery_scope_payload),
        }
        alpha = fixture.campaign["formulae"][0]
        alpha["destination"]["admission"] = {
            "kind": "archived-predecessor-exact-presence",
            "method": "anonymous-oras-manifest-probe",
            "probe": {
                "digest": "sha256:" + "8" * 64,
                "kind": "manifest",
                "schema": 1,
                "status": "present",
            },
            "schema": 1,
        }
        for variant in alpha["variants"]:
            variant["reuse_source"] = {
                "arch": variant["arch"],
                "campaign_tag": campaign_tag,
                "handoff_tag": (
                    "homebrew-prefix-handoff-sha256-"
                    + ("9" if variant["arch"] == "wasm32" else "a")
                    * 64
                ),
                "kind": "predecessor-handoff",
            }
        write_json(fixture.campaign_path, fixture.campaign)

        checkout = fixture.root / "scoped-source-checkout"
        subprocess.run(
            ["git", "clone", "-q", "--no-hardlinks", fixture.live, checkout],
            check=True,
        )
        subprocess.run(
            [
                "git",
                "checkout",
                "--detach",
                "--quiet",
                scoped_source_commit,
            ],
            cwd=checkout,
            check=True,
        )
        output = fixture.root / "scoped-materialized-source"
        EXECUTOR.materialize_campaign_source(
            campaign_path=fixture.campaign_path,
            source_tap_root=checkout,
            output=output,
        )
        self.assertTrue((output / "Formula/alpha.rb").is_file())
        self.assertFalse((output / scope_relative).exists())

        fixture.campaign["authority"]["successor_scope"][
            "sha256"
        ] = "0" * 64
        write_json(fixture.campaign_path, fixture.campaign)
        rejected = fixture.root / "rejected-scoped-materialization"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "differs from its recovery authority",
        ):
            EXECUTOR.materialize_campaign_source(
                campaign_path=fixture.campaign_path,
                source_tap_root=checkout,
                output=rejected,
            )
        self.assertFalse(rejected.exists())

    def test_closed_selection_release_rejects_unsafe_tree_and_zip(
        self,
    ) -> None:
        fixture = Fixture(multi_arch=True)
        self.addCleanup(fixture.close)
        alpha = fixture.root / "unsafe-selection-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        selection = fixture.root / "unsafe-selection"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha"],
            arch="wasm32",
            handoff_roots=[alpha],
            output=selection,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )

        def add_link(tap: pathlib.Path, target: str) -> None:
            (tap / "Aliases").mkdir(exist_ok=True)
            os.symlink(target, tap / "Aliases/unsafe")

        def add_chain(tap: pathlib.Path) -> None:
            (tap / "Aliases").mkdir(exist_ok=True)
            os.symlink(
                "../Formula/alpha.rb", tap / "Aliases/first"
            )
            os.symlink("first", tap / "Aliases/unsafe")

        def add_cycle(tap: pathlib.Path) -> None:
            (tap / "Aliases").mkdir(exist_ok=True)
            os.symlink("second", tap / "Aliases/first")
            os.symlink("first", tap / "Aliases/second")

        def add_special_target(tap: pathlib.Path) -> None:
            (tap / "Aliases").mkdir(exist_ok=True)
            (tap / "targets").mkdir()
            os.mkfifo(tap / "targets/fifo")
            os.symlink("../targets/fifo", tap / "Aliases/unsafe")

        unsafe_cases = (
            ("absolute", lambda tap: add_link(tap, "/etc/passwd")),
            ("escape", lambda tap: add_link(tap, "../../outside")),
            (
                "control",
                lambda tap: add_link(tap, "../Formula/alpha.rb\n"),
            ),
            (
                "non-ASCII",
                lambda tap: add_link(tap, "../Formula/álpha.rb"),
            ),
            (
                "dangling",
                lambda tap: add_link(tap, "../Formula/missing.rb"),
            ),
            ("directory", lambda tap: add_link(tap, "../Formula")),
            ("chain", add_chain),
            ("cycle", add_cycle),
        )
        for label, configure in unsafe_cases:
            with self.subTest(unsafe_link=label):
                candidate = fixture.root / f"unsafe-selection-{label}"
                shutil.copytree(selection, candidate, symlinks=True)
                configure(candidate / "tap")
                selection_value = json.loads(
                    (candidate / "selection.json").read_text()
                )
                selection_value["tap"]["prepared_tree_git_oid"] = (
                    EXECUTOR.filesystem_git_tree_oid(
                        candidate / "tap", f"unsafe {label} tap"
                    )
                )
                write_json(candidate / "selection.json", selection_value)
                unsafe_output = (
                    fixture.root / f"unsafe-selection-release-{label}"
                )
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    "relative target|escapes|dangling|directory|another "
                    "link|special file|regular file",
                ):
                    EXECUTOR.prepare_selection_release(
                        selection_root=candidate,
                        output=unsafe_output,
                    )
                self.assertFalse(unsafe_output.exists())

        special_tap = fixture.root / "unsafe-selection-special-tap"
        shutil.copytree(selection / "tap", special_tap, symlinks=True)
        add_special_target(special_tap)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError, "special file|regular file"
        ):
            EXECUTOR.selection_tree_inventory(special_tap)

        prepared = fixture.root / "duplicate-selection-release"
        EXECUTOR.prepare_selection_release(
            selection_root=selection, output=prepared
        )
        descriptor_path = (
            prepared / "assets" / EXECUTOR.SELECTION_DESCRIPTOR_ASSET
        )
        archive_path = (
            prepared / "assets" / EXECUTOR.SELECTION_ARCHIVE_ASSET
        )
        descriptor = json.loads(descriptor_path.read_text())
        legacy_descriptor = json.loads(descriptor_path.read_text())
        legacy_descriptor["tap_archive"]["format"] = "zip-stored-v1"
        legacy_payload = EXECUTOR.pretty_json(legacy_descriptor)
        EXECUTOR.validate_selection_descriptor(
            legacy_descriptor, legacy_payload
        )
        legacy_tap = fixture.root / "legacy-selection-tap"
        EXECUTOR.extract_selection_archive(
            archive_path,
            legacy_tap,
            legacy_descriptor["tap_archive"]["inventory"],
            legacy_descriptor["tap_archive"]["format"],
        )
        self.assertEqual(
            EXECUTOR.filesystem_git_tree_oid(
                legacy_tap, "legacy selection readback"
            ),
            legacy_descriptor["tap_archive"]["tree_git_oid"],
        )
        first_record = descriptor["tap_archive"]["inventory"][0]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(archive_path, mode="a") as archive:
                info = zipfile.ZipInfo(
                    f"tap/{first_record['path']}",
                    date_time=(2000, 1, 1, 0, 0, 0),
                )
                info.create_system = 3
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = int(first_record["mode"], 8) << 16
                archive.writestr(info, b"duplicate")
        descriptor["tap_archive"]["bytes"] = archive_path.stat().st_size
        descriptor["tap_archive"]["sha256"] = sha256(
            archive_path.read_bytes()
        )
        write_json(descriptor_path, descriptor)
        manifest_path = prepared / "release-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        descriptor_payload = descriptor_path.read_bytes()
        descriptor_sha = sha256(descriptor_payload)
        manifest["tag"] = (
            f"homebrew-prefix-selection-sha256-{descriptor_sha}"
        )
        for record in manifest["assets"]:
            if record["name"] == EXECUTOR.SELECTION_DESCRIPTOR_ASSET:
                record["bytes"] = len(descriptor_payload)
                record["sha256"] = descriptor_sha
            elif record["name"] == EXECUTOR.SELECTION_ARCHIVE_ASSET:
                record["bytes"] = archive_path.stat().st_size
                record["sha256"] = sha256(archive_path.read_bytes())
        write_json(manifest_path, manifest)
        fetch_json, fetch_asset, _release = release_fetchers(prepared)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "inventory is incomplete|repeats a member",
        ):
            EXECUTOR.fetch_selection_release(
                repository=TAP_REPOSITORY,
                tag=manifest["tag"],
                output=fixture.root / "duplicate-readback",
                receipt_output=fixture.root / "duplicate-receipt.json",
                json_fetcher=fetch_json,
                asset_fetcher=fetch_asset,
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
                "selected provenance closure lacks handoffs.*alpha",
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
        alpha_publication = fixture.publication("alpha", "wasm32")
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
                        alpha_publication,
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

    def test_runtime_dependency_scope_fails_closed(self) -> None:
        mutations = {
            "outside scheduling graph": (
                "exact scheduling-dependency subset",
                [
                    {
                        "full_name": f"{TAP_NAME}/beta",
                        "version": "2.0",
                    }
                ],
            ),
            "wrong scheduling version": (
                "exact scheduling-dependency subset",
                [
                    {
                        "full_name": f"{TAP_NAME}/alpha",
                        "version": "9.9",
                    }
                ],
            ),
            "duplicate": (
                "must be unique and sorted",
                [
                    {
                        "full_name": f"{TAP_NAME}/alpha",
                        "version": "1.0",
                    },
                    {
                        "full_name": f"{TAP_NAME}/alpha",
                        "version": "1.0",
                    },
                ],
            ),
        }
        for label, (expected, runtime_dependencies) in mutations.items():
            with self.subTest(label=label):
                fixture = Fixture()
                self.addCleanup(fixture.close)
                fixture.formulae[1]["runtime_dependencies"] = (
                    runtime_dependencies
                )
                write_json(fixture.campaign_path, fixture.campaign)
                with self.assertRaisesRegex(
                    EXECUTOR.ExecutorError,
                    expected,
                ):
                    EXECUTOR.load_campaign(fixture.campaign_path)

        formula = make_formula(
            "gamma",
            "3.0",
            [("alpha", "1.0"), ("beta", "2.0")],
            ["wasm32"],
        )
        formula["runtime_dependencies"].reverse()
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "must be unique and sorted",
        ):
            EXECUTOR.dependency_names_for_field(
                formula,
                TAP_NAME,
                "runtime_dependencies",
            )

    def test_build_only_dependency_orders_without_becoming_runtime(
        self,
    ) -> None:
        fixture = Fixture(scoped_beta_dependency=True)
        self.addCleanup(fixture.close)
        _campaign, _payload, index = EXECUTOR.load_campaign(
            fixture.campaign_path
        )
        self.assertEqual(
            EXECUTOR.dependency_closure(
                fixture.campaign,
                index,
                "beta",
            ),
            ("alpha",),
        )
        self.assertEqual(
            EXECUTOR.runtime_dependency_closure(
                fixture.campaign,
                index,
                "beta",
            ),
            (),
        )
        alpha_handoff = fixture.root / "alpha-handoff"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha_handoff,
        )

        missing_output = fixture.root / "missing-build-dependency"
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "dependency handoffs differ from the exact campaign closure",
        ):
            fixture.derive(
                "beta",
                [("wasm32", fixture.publication("beta", "wasm32"))],
                [],
                missing_output,
            )
        self.assertFalse(missing_output.exists())

        beta_handoff = fixture.root / "beta-handoff"
        fixture.derive(
            "beta",
            [("wasm32", fixture.publication("beta", "wasm32"))],
            [alpha_handoff],
            beta_handoff,
        )
        manifest = json.loads(
            (beta_handoff / "handoff.json").read_text()
        )
        self.assertEqual(manifest["formula"]["dependencies"], [])
        self.assertEqual(
            [
                value["formula"]
                for value in manifest["dependency_handoffs"]
            ],
            ["alpha"],
        )
        sidecars = json.loads(
            (
                beta_handoff
                / "payload/wasm32/composition/sidecars-input.json"
            ).read_text()
        )
        self.assertEqual(sidecars["packages"][0]["dependencies"], [])

        runtime_selection = fixture.root / "runtime-only-selection"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["beta"],
            arch="wasm32",
            handoff_roots=[alpha_handoff, beta_handoff],
            output=runtime_selection,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )
        selection = json.loads(
            (runtime_selection / "selection.json").read_text()
        )
        self.assertEqual(
            [value["formula"] for value in selection["formulae"]],
            ["beta"],
        )
        self.assertFalse(
            (runtime_selection / "tap/Formula/alpha.rb").exists()
        )
        self.assertEqual(
            json.loads(
                (
                    runtime_selection / "tap/Kandelo/metadata.json"
                ).read_text()
            )["packages"],
            [{"name": "beta"}],
        )

        explicit_selection = fixture.root / "explicit-build-dependency"
        EXECUTOR.prepare_selection(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            roots=["alpha", "beta"],
            arch="wasm32",
            handoff_roots=[alpha_handoff, beta_handoff],
            output=explicit_selection,
            bottle_merger=fixture.merge_dependency,
            sidecar_generator=fixture.generate_sidecars,
            tap_validator=fixture.validate_tap,
        )
        explicit = json.loads(
            (explicit_selection / "selection.json").read_text()
        )
        self.assertEqual(
            [value["formula"] for value in explicit["formulae"]],
            ["alpha", "beta"],
        )
        self.assertEqual(
            len(
                {
                    value["formula"]
                    for value in explicit["formulae"]
                }
            ),
            2,
        )

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
            label="alpha/wasm32 publisher inputs",
        )
        self.assertEqual(observed["arch"], "wasm32")
        self.assertEqual(observed["tree"], fixture.source_tree)
        self.assertEqual(observed["checkout_commit"], expected)
        self.assertNotEqual(observed["checkout_commit"], target_commit)
        self.assertEqual(
            observed["formula"],
            formula_source("alpha"),
        )

    def test_destination_bound_build_is_reconstructed_exactly(self) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        # WHY: this fixture must exercise retired-prefix normalization without
        # becoming a second source literal for the retired guest identity.
        retired = json.loads(
            (
                ROOT / "homebrew/kandelo-guest-layout.json"
            ).read_text()
        )["retired_prefixes"][0]
        beta_payload = (
            b'class Beta < Formula\n'
            b'  desc "campaign executor fixture"\n'
            b'\n'
            b'  bottle do\n'
            b'    root_url "https://ghcr.io/v2/'
            b'kandelo-dev/homebrew-tap-core"\n'
            b'    sha256 cellar: "'
            + f"{retired}/Cellar".encode()
            + b'", wasm32_kandelo: "'
            + b"d" * 64
            + b'"\n'
            b'  end\n'
            b'\n'
            b'end\n'
        )
        beta_path = fixture.source / "Formula/beta.rb"
        beta_path.write_bytes(beta_payload)
        beta = fixture.formulae[1]
        beta["formula_source"]["sha256"] = sha256(beta_payload)
        beta["formula_source"][
            "identity_excluding_bottle_sha256"
        ] = EXECUTOR.CAMPAIGN_FORMULA.formula_identity(
            beta_path,
            repository_root=ROOT,
        )
        beta["destination"]["bottle_rebuild"] = 1
        beta["destination"]["reference"] = "2.0-1"
        fixture.source_tree = EXECUTOR.filesystem_git_tree_oid(
            fixture.source,
            "destination-bound fixture source",
        )
        fixture.campaign["authority"]["source_materialization"][
            "tree_git_oid"
        ] = fixture.source_tree
        write_json(fixture.campaign_path, fixture.campaign)

        destination_root = fixture.root / "expected-destination"
        shutil.copytree(fixture.source, destination_root)
        self.assertTrue(
            EXECUTOR.bind_campaign_formula_destination(
                destination_root,
                fixture.campaign,
                beta,
            )
        )
        destination_tree = EXECUTOR.filesystem_git_tree_oid(
            destination_root,
            "expected destination-bound checkout",
        )
        target_commit = EXECUTOR.deterministic_campaign_commit_oid(
            parent=SOURCE_TAP_COMMIT,
            tree=fixture.source_tree,
            label="sealed target source",
        )
        destination_commit = EXECUTOR.deterministic_campaign_commit_oid(
            parent=target_commit,
            tree=destination_tree,
            label="beta reserved bottle destination",
        )

        alpha = fixture.root / "destination-bound-alpha"
        fixture.derive(
            "alpha",
            [("wasm32", fixture.publication("alpha", "wasm32"))],
            [],
            alpha,
        )
        observed: dict[str, Any] = {}

        def capture(
            _campaign: dict[str, Any],
            _formula: dict[str, Any],
            _arch: str,
            publication: pathlib.Path,
            prepared_root: pathlib.Path,
            checkout_commit: str,
        ) -> None:
            observed["commit"] = checkout_commit
            observed["tree"] = EXECUTOR.filesystem_git_tree_oid(
                prepared_root,
                "observed destination-bound checkout",
            )
            observed["formula"] = (
                prepared_root / "Formula/beta.rb"
            ).read_text()
            observed["sidecars"] = json.loads(
                (
                    publication
                    / "composition/sidecars-input.json"
                ).read_text()
            )

        publication = fixture.publication("beta", "wasm32")
        fixture_output = fixture.root / "destination-bound-beta"
        EXECUTOR.derive_build(
            campaign_path=fixture.campaign_path,
            source_tap_root=fixture.source,
            formula_name="beta",
            publications=[("wasm32", publication)],
            dependency_roots=[alpha],
            output=fixture_output,
            validator=capture,
            dependency_merger=fixture.merge_dependency,
        )
        self.assertIn("    rebuild 1\n", observed["formula"])
        self.assertIn(
            'cellar: "/opt/kandelo/homebrew/Cellar"',
            observed["formula"],
        )
        self.assertNotIn(retired, observed["formula"])
        expected_commit = EXECUTOR.deterministic_campaign_commit_oid(
            parent=destination_commit,
            tree=observed["tree"],
            label="beta/wasm32 publisher inputs",
        )
        self.assertEqual(observed["commit"], expected_commit)
        prepared_digest = sha256(observed["formula"].encode())
        self.assertEqual(
            observed["sidecars"]["packages"][0][
                "formula_source_sha256"
            ],
            prepared_digest,
        )
        self.assertNotEqual(
            prepared_digest,
            beta["formula_source"]["sha256"],
        )

        substituted = fixture.publication("beta", "wasm32")
        sidecars_path = (
            substituted / "composition/sidecars-input.json"
        )
        sidecars = json.loads(sidecars_path.read_text())
        sidecars["packages"][0]["formula_source_sha256"] = "e" * 64
        write_json(sidecars_path, sidecars)
        with self.assertRaisesRegex(
            EXECUTOR.ExecutorError,
            "composition differs from the campaign",
        ):
            EXECUTOR.derive_build(
                campaign_path=fixture.campaign_path,
                source_tap_root=fixture.source,
                formula_name="beta",
                publications=[("wasm32", substituted)],
                dependency_roots=[alpha],
                output=fixture.root / "substituted-destination-beta",
                validator=lambda *_arguments: None,
                dependency_merger=fixture.merge_dependency,
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
                label=f"beta/{arch} publisher inputs",
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
