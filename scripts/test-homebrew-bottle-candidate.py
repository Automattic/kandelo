#!/usr/bin/env python3
"""Regression tests for pre-merge Homebrew bottle candidates."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts/homebrew-bottle-candidate.py"
RELEASE_VALIDATOR = (
    ROOT / "scripts/validate-immutable-github-release-manifest.py"
)


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_json(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def git(root: pathlib.Path, *arguments: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        input=input_text,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


class CandidateFixture:
    def __init__(self, root: pathlib.Path, arch: str) -> None:
        self.root = root
        self.arch = arch
        self.kandelo = root / "kandelo"
        self.tap = root / "tap"
        self.inputs = root / "inputs"
        self.inputs.mkdir(parents=True)
        self._git_repositories()
        self._package_input()
        self._build_and_oci()
        self._evidence()

    def _git_repositories(self) -> None:
        self.kandelo.mkdir()
        git(self.kandelo, "init", "--quiet", "--initial-branch=main")
        git(self.kandelo, "config", "user.name", "test")
        git(self.kandelo, "config", "user.email", "test@example.invalid")
        (self.kandelo / "base.txt").write_text("base\n")
        git(self.kandelo, "add", "base.txt")
        git(self.kandelo, "commit", "--quiet", "-m", "base")
        self.base = git(self.kandelo, "rev-parse", "HEAD")
        git(self.kandelo, "switch", "--quiet", "-c", "candidate")
        (self.kandelo / "abi.txt").write_text("43\n")
        (self.kandelo / "abi").mkdir()
        (self.kandelo / "abi/snapshot.json").write_text('{"abi":43}\n')
        (self.kandelo / "homebrew").mkdir()
        (self.kandelo / "homebrew/kandelo-guest-layout.json").write_text(
            '{"prefix":"/opt/kandelo/homebrew"}\n'
        )
        git(self.kandelo, "add", "abi.txt", "abi", "homebrew")
        git(self.kandelo, "commit", "--quiet", "-m", "abi candidate")
        self.producer = git(self.kandelo, "rev-parse", "HEAD")
        self.producer_tree = git(self.kandelo, "rev-parse", "HEAD^{tree}")
        merge = git(
            self.kandelo,
            "commit-tree",
            self.producer_tree,
            "-p",
            self.base,
            "-p",
            self.producer,
            input_text="merge candidate\n",
        )
        git(self.kandelo, "branch", "-f", "main", merge)
        git(self.kandelo, "switch", "--quiet", "main")
        self.merge = merge

        self.tap.mkdir()
        git(self.tap, "init", "--quiet", "--initial-branch=main")
        git(self.tap, "config", "user.name", "test")
        git(self.tap, "config", "user.email", "test@example.invalid")
        (self.tap / "Formula").mkdir()
        (self.tap / "Formula/zlib.rb").write_text("class Zlib < Formula\nend\n")
        git(self.tap, "add", "Formula/zlib.rb")
        git(self.tap, "commit", "--quiet", "-m", "formula source")
        self.tap_source = git(self.tap, "rev-parse", "HEAD")
        self.tap_prepared = git(
            self.tap,
            "commit-tree",
            git(self.tap, "rev-parse", "HEAD^{tree}"),
            "-p",
            self.tap_source,
            input_text="prepared candidate Formula\n",
        )
        (self.tap / ".github/workflows").mkdir(parents=True)
        (self.tap / ".github/workflows/candidate-bottles.yml").write_text(
            "name: candidate\n"
        )
        git(self.tap, "add", ".github/workflows/candidate-bottles.yml")
        git(self.tap, "commit", "--quiet", "-m", "candidate caller")
        self.tap_caller = git(self.tap, "rev-parse", "HEAD")

    def _package_input(self) -> None:
        archives = []
        for package, arch in (("rootfs", "wasm32"), ("rootfs", "wasm64")):
            payload = f"{package}-{arch}-archive".encode()
            archives.append(
                {
                    "package": package,
                    "arch": arch,
                    "version": "1.0.0",
                    "revision": 0,
                    "cache_key_sha": sha256(f"{package}-{arch}".encode()),
                    "name": f"{package}-1.0.0-abi43-{arch}-test.tar.zst",
                    "sha256": sha256(payload),
                    "bytes": len(payload),
                }
            )
        self.package_input = {
            "schema": 1,
            "kind": "kandelo-homebrew-candidate-package-input",
            "repository": "Automattic/kandelo",
            "producer_commit": self.producer,
            "abi": 43,
            "expected_ledger_sha256": sha256(b"complete-ledger"),
            "index": {"sha256": sha256(b"index"), "bytes": 5},
            "staging_release": {
                "tag": "pr-42-staging-run-700-attempt-1",
                "release_id": 900,
                "target_commit": self.producer,
                "immutable": True,
                "pr_number": 42,
                "run_id": 700,
                "attempt": 1,
            },
            "archives": archives,
        }
        self.package_path = self.inputs / "package-input.json"
        write_json(self.package_path, self.package_input)

    def _build_and_oci(self) -> None:
        self.build = self.inputs / "build"
        self.oci = self.inputs / "oci"
        self.build.mkdir()
        (self.oci / "layout/blobs/sha256").mkdir(parents=True)
        bottle = f"exact-{self.arch}-bottle".encode()
        bottle_sha = sha256(bottle)
        (self.build / "bottle.tar.gz").write_bytes(bottle)
        write_json(self.build / "bottle.json", {"fixture": True})
        write_json(self.build / "dependency-provenance.json", {"dependencies": []})
        dependency = (self.build / "dependency-provenance.json").read_bytes()
        manifest = {
            "schema": 4,
            "formula": "zlib",
            "arch": self.arch,
            "release_tag": "bottles-abi-v43",
            "tap_repository": "Kandelo-dev/homebrew-tap-core",
            "tap_name": "kandelo-dev/tap-core",
            "tap_commit": self.tap_source,
            "tap_checkout_commit": self.tap_prepared,
            "kandelo_commit": self.producer,
            "bottle_root_url": (
                "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
            ),
            "bottle": {
                "archive": "bottle.tar.gz",
                "json": "bottle.json",
                "tag": f"{self.arch}_kandelo",
                "cellar": "/opt/kandelo/homebrew/Cellar",
                "sha256": bottle_sha,
                "bytes": len(bottle),
            },
            "dependency_provenance": {
                "json": "dependency-provenance.json",
                "sha256": sha256(dependency),
                "bytes": len(dependency),
            },
        }
        write_json(self.build / "manifest.json", manifest)

        config = b'{"architecture":"wasm"}'
        oci_manifest = b'{"schemaVersion":2}'
        config_sha = sha256(config)
        manifest_sha = sha256(oci_manifest)
        for digest, payload in (
            (bottle_sha, bottle),
            (config_sha, config),
            (manifest_sha, oci_manifest),
        ):
            (self.oci / "layout/blobs/sha256" / digest).write_bytes(payload)
        write_json(self.oci / "layout/oci-layout", {"imageLayoutVersion": "1.0.0"})
        write_json(
            self.oci / "layout/index.json",
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [],
            },
        )
        self.oci_receipt = {
            "schema": 2,
            "kind": "child",
            "formula": "zlib",
            "arch": self.arch,
            "abi": 43,
            "pkg_version": "1.3.1",
            "formula_revision": 0,
            "bottle_rebuild": 7,
            "formula_source_identity_sha256": sha256(b"formula identity"),
            "formula_source_sha256": sha256(b"formula source"),
            "source_closure_sha256": sha256(b"source closure"),
            "kandelo_commit": self.producer,
            "tap_commit": self.tap_source,
            "tap_repository": "Kandelo-dev/homebrew-tap-core",
            "tap_name": "kandelo-dev/tap-core",
            "top_ref": "1.3.1-7",
            "bottle": {
                "bytes": len(bottle),
                "sha256": bottle_sha,
                "url": (
                    "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/"
                    f"zlib/blobs/sha256:{bottle_sha}"
                ),
            },
            "oci": {
                "config": {
                    "digest": f"sha256:{config_sha}",
                    "mediaType": "application/vnd.oci.image.config.v1+json",
                    "size": len(config),
                },
                "diff_id": f"sha256:{bottle_sha}",
                "homebrew_ref": f"1.3.1.{self.arch}_kandelo.7",
                "manifest": {
                    "digest": f"sha256:{manifest_sha}",
                    "size": len(oci_manifest),
                },
                "platform": {
                    "architecture": "wasm",
                    "os": "kandelo",
                    "variant": self.arch,
                },
                "transport_tag": f"sha256-{manifest_sha}",
            },
        }
        write_json(self.oci / "receipt.json", self.oci_receipt)

    def _evidence(self) -> None:
        self.source = {
            "kandelo_repository": "Automattic/kandelo",
            "workflow_authority_commit": self.base,
            "base_commit": self.base,
            "producer_commit": self.producer,
            "producer_tree": self.producer_tree,
            "merge_method": "merge",
            "pr_number": 42,
            "abi": 43,
            "abi_snapshot_sha256": sha256(
                (self.kandelo / "abi/snapshot.json").read_bytes()
            ),
            "guest_layout": {
                "path": "homebrew/kandelo-guest-layout.json",
                "sha256": sha256(
                    (
                        self.kandelo
                        / "homebrew/kandelo-guest-layout.json"
                    ).read_bytes()
                ),
            },
            "release_tag": "bottles-abi-v43",
            "tap_repository": "Kandelo-dev/homebrew-tap-core",
            "tap_name": "kandelo-dev/tap-core",
            "tap_commit": self.tap_source,
            "tap_checkout_commit": self.tap_prepared,
            "tap_checkout_tree": git(
                self.tap, "rev-parse", f"{self.tap_prepared}^{{tree}}"
            ),
            "prefix_campaign_tag": (
                "homebrew-prefix-campaign-candidate-pr-77-run-900-"
                "attempt-2-sha256-" + "3" * 64
            ),
            "prefix_campaign_layout_sha256": sha256(b"campaign layout"),
        }
        self.source_path = self.inputs / "source.json"
        write_json(self.source_path, self.source)
        attempt = 1
        self.run = {
            "schema": 1,
            "repository": "Kandelo-dev/homebrew-tap-core",
            "workflow_path": ".github/workflows/candidate-bottles.yml",
            "caller_commit": self.tap_caller,
            "event": "repository_dispatch",
            "run_id": 800,
            "run_attempt": attempt,
            "status": "in_progress",
            "conclusion": None,
            "artifacts": [
                {
                    "id": 1001,
                    "name": f"homebrew-build-handoff-zlib-{self.arch}-attempt-1",
                    "bytes": 100,
                    "digest": f"sha256:{sha256(b'build artifact')}",
                    "run_id": 800,
                    "run_attempt": attempt,
                },
                {
                    "id": 1002,
                    "name": f"homebrew-oci-child-zlib-{self.arch}-attempt-1",
                    "bytes": 200,
                    "digest": f"sha256:{sha256(b'oci artifact')}",
                    "run_id": 800,
                    "run_attempt": attempt,
                },
                {
                    "id": 1003,
                    "name": (
                        "homebrew-candidate-package-input-zlib-"
                        f"{self.arch}-attempt-1"
                    ),
                    "bytes": 300,
                    "digest": f"sha256:{sha256(b'package input artifact')}",
                    "run_id": 800,
                    "run_attempt": attempt,
                },
            ],
        }
        self.run_path = self.inputs / "run.json"
        write_json(self.run_path, self.run)
        self.destination = {
            "formula": "zlib",
            "remote": "ghcr.io/kandelo-dev/homebrew-tap-core/zlib",
            "child_ref": self.oci_receipt["oci"]["transport_tag"],
            "child_digest": None,
            "homebrew_ref": self.oci_receipt["oci"]["homebrew_ref"],
            "homebrew_ref_status": "available",
            "top_ref": self.oci_receipt["top_ref"],
            "child_status": "missing",
            "top_status": "missing",
            "top_digest": None,
            "observed_at": "2026-08-01T20:00:00Z",
        }
        self.destination_path = self.inputs / "destination.json"
        write_json(self.destination_path, self.destination)
        self.dependencies: list[dict[str, object]] = []
        self.dependencies_path = self.inputs / "dependencies.json"
        write_json(self.dependencies_path, self.dependencies)
        self.pr = {
            "number": 42,
            "state": "MERGED",
            "baseRefName": "main",
            "headRefOid": self.producer,
            "mergeCommit": {"oid": self.merge},
        }
        self.pr_path = self.inputs / "pr.json"
        write_json(self.pr_path, self.pr)
        self.completed_run = {**self.run, "status": "completed", "conclusion": "success"}
        self.completed_run_path = self.inputs / "completed-run.json"
        write_json(self.completed_run_path, self.completed_run)
        package_payload = json.dumps(
            self.package_input, indent=2, sort_keys=True
        ).encode() + b"\n"
        self.admitted = {
            "schema": 1,
            "kind": "kandelo-homebrew-admitted-candidate-package-input",
            "validated_against_main": self.merge,
            "candidate_package_input_sha256": sha256(package_payload),
            "package_input": self.package_input,
        }
        self.admitted_path = self.inputs / "admitted.json"
        write_json(self.admitted_path, self.admitted)

    def prepare(self, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        self.prepared = self.root / "prepared"
        result = subprocess.run(
            [
                "python3",
                str(TOOL),
                "prepare",
                "--source",
                str(self.source_path),
                "--run-evidence",
                str(self.run_path),
                "--destination",
                str(self.destination_path),
                "--dependencies",
                str(self.dependencies_path),
                "--package-input",
                str(self.package_path),
                "--build-handoff",
                str(self.build),
                "--oci-child",
                str(self.oci),
                "--out",
                str(self.prepared),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if expect_success and result.returncode != 0:
            raise AssertionError(result.stderr)
        return result

    def materialize(self, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        git(self.tap, "checkout", "--quiet", "--detach", self.tap_prepared)
        tag = (self.prepared / "tag.txt").read_text().strip()
        self.out_build = self.root / "materialized/build"
        self.out_oci = self.root / "materialized/oci"
        self.out_package = self.root / "materialized/package-input.json"
        self.out_receipt = self.root / "materialized/promotion.json"
        result = subprocess.run(
            [
                "python3",
                str(TOOL),
                "materialize",
                "--candidate-root",
                str(self.prepared / "assets"),
                "--candidate-tag",
                tag,
                "--completed-run-evidence",
                str(self.completed_run_path),
                "--kandelo-root",
                str(self.kandelo),
                "--tap-root",
                str(self.tap),
                "--merge-commit",
                self.merge,
                "--current-kandelo-main",
                self.merge,
                "--current-tap-main",
                self.tap_caller,
                "--admitted-package-input",
                str(self.admitted_path),
                "--dependencies",
                str(self.dependencies_path),
                "--out-build-handoff",
                str(self.out_build),
                "--out-oci-child",
                str(self.out_oci),
                "--out-package-input",
                str(self.out_package),
                "--out-receipt",
                str(self.out_receipt),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if expect_success and result.returncode != 0:
            raise AssertionError(result.stderr)
        return result


class BottleCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def fixture(self, arch: str = "wasm32") -> CandidateFixture:
        return CandidateFixture(self.root / arch, arch)

    def test_two_architectures_round_trip_exact_bytes(self) -> None:
        for arch in ("wasm32", "wasm64"):
            fixture = self.fixture(arch)
            fixture.prepare()
            fixture.materialize()
            self.assertEqual(
                (fixture.build / "bottle.tar.gz").read_bytes(),
                (fixture.out_build / "bottle.tar.gz").read_bytes(),
            )
            source_blobs = sorted(
                (fixture.oci / "layout/blobs/sha256").iterdir()
            )
            promoted_blobs = sorted(
                (fixture.out_oci / "layout/blobs/sha256").iterdir()
            )
            self.assertEqual(
                [(path.name, path.read_bytes()) for path in source_blobs],
                [(path.name, path.read_bytes()) for path in promoted_blobs],
            )
            receipt = json.loads(fixture.out_receipt.read_text())
            self.assertEqual(
                receipt["source"]["producer_commit"], fixture.producer
            )
            self.assertEqual(receipt["merge_commit"], fixture.merge)

    def test_prepared_release_uses_the_shared_immutable_contract(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        stage = fixture.root / "validated-release-assets"
        normalized = fixture.root / "validated-release.json"
        result = subprocess.run(
            [
                "python3",
                str(RELEASE_VALIDATOR),
                "--manifest",
                str(fixture.prepared / "release-manifest.json"),
                "--asset-root",
                str(fixture.prepared / "assets"),
                "--stage-dir",
                str(stage),
                "--out-manifest",
                str(normalized),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            sorted(path.name for path in stage.iterdir()),
            sorted(path.name for path in (fixture.prepared / "assets").iterdir()),
        )

    def test_package_input_binds_the_complete_validated_ledger(self) -> None:
        fixture = self.fixture()
        expected_entries = []
        snapshot_entries = []
        for archive in fixture.package_input["archives"]:
            expected_entries.append(
                {
                    "package": archive["package"],
                    "kind": "program",
                    "arch": archive["arch"],
                    "version": archive["version"],
                    "revision": archive["revision"],
                    "cache_key_sha": archive["cache_key_sha"],
                    "git_inputs": [],
                }
            )
            snapshot_entries.append(
                {
                    "package": archive["package"],
                    "kind": "program",
                    "arch": archive["arch"],
                    "version": archive["version"],
                    "revision": archive["revision"],
                    "cache_key_sha": archive["cache_key_sha"],
                    "current": True,
                    "asset": archive["name"],
                    "archive_sha256": archive["sha256"],
                    "size": archive["bytes"],
                }
            )
        expected = fixture.root / "expected.json"
        snapshot = fixture.root / "snapshot.json"
        release = fixture.root / "release.json"
        index = fixture.root / "index.toml"
        output = fixture.root / "created-package-input.json"
        write_json(
            expected,
            {"abi_version": 43, "entries": expected_entries},
        )
        write_json(
            snapshot,
            {
                "abi_version": 43,
                "release_tag": fixture.package_input["staging_release"]["tag"],
                "complete_current": True,
                "entries": snapshot_entries,
            },
        )
        write_json(
            release,
            {
                "schema": 1,
                "repository": "Automattic/kandelo",
                **fixture.package_input["staging_release"],
            },
        )
        index.write_text("abi_version = 43\n")
        result = subprocess.run(
            [
                "python3",
                str(TOOL),
                "package-input",
                "--expected-ledger",
                str(expected),
                "--snapshot",
                str(snapshot),
                "--release-evidence",
                str(release),
                "--index",
                str(index),
                "--producer-commit",
                fixture.producer,
                "--abi",
                "43",
                "--out",
                str(output),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        created = json.loads(output.read_text())
        self.assertEqual(created["archives"], fixture.package_input["archives"])
        self.assertEqual(
            created["staging_release"], fixture.package_input["staging_release"]
        )

    def test_package_input_admission_requires_the_exact_merge_tree(self) -> None:
        fixture = self.fixture()
        output = fixture.root / "admitted-by-tool.json"
        result = subprocess.run(
            [
                "python3",
                str(TOOL),
                "admit-package-input",
                "--candidate-package-input",
                str(fixture.package_path),
                "--regenerated-package-input",
                str(fixture.package_path),
                "--producer-commit",
                fixture.producer,
                "--validated-main",
                fixture.merge,
                "--validated-main-root",
                str(fixture.kandelo),
                "--out",
                str(output),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        admitted = json.loads(output.read_text())
        self.assertEqual(admitted["validated_against_main"], fixture.merge)

        changed = fixture.root / "changed-package-input.json"
        value = dict(fixture.package_input)
        value["expected_ledger_sha256"] = "4" * 64
        write_json(changed, value)
        rejected = subprocess.run(
            [
                "python3",
                str(TOOL),
                "admit-package-input",
                "--candidate-package-input",
                str(fixture.package_path),
                "--regenerated-package-input",
                str(changed),
                "--producer-commit",
                fixture.producer,
                "--validated-main",
                fixture.merge,
                "--validated-main-root",
                str(fixture.kandelo),
                "--out",
                str(fixture.root / "rejected.json"),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("differs from the sealed candidate", rejected.stderr)

    def test_promotion_receipt_binds_reconstructed_artifacts(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        fixture.materialize()
        command = [
            "python3",
            str(TOOL),
            "validate-promotion",
            "--receipt",
            str(fixture.out_receipt),
            "--candidate-tag",
            (fixture.prepared / "tag.txt").read_text().strip(),
            "--producer-commit",
            fixture.producer,
            "--merge-commit",
            fixture.merge,
            "--tap-commit",
            fixture.tap_source,
            "--tap-checkout-commit",
            fixture.tap_prepared,
            "--campaign-tag",
            fixture.source["prefix_campaign_tag"],
            "--campaign-layout-sha256",
            fixture.source["prefix_campaign_layout_sha256"],
            "--formula",
            "zlib",
            "--arch",
            fixture.arch,
            "--build-handoff",
            str(fixture.out_build),
            "--oci-child",
            str(fixture.out_oci),
            "--package-input",
            str(fixture.out_package),
        ]
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        (fixture.out_build / "bottle.tar.gz").write_bytes(b"changed")
        rejected = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("differs from its build manifest", rejected.stderr)

    def test_promotion_requires_the_exact_package_input(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        fixture.materialize()
        value = json.loads(fixture.out_package.read_text())
        value["archives"][0]["revision"] += 1
        write_json(fixture.out_package, value)
        command = [
            "python3",
            str(TOOL),
            "validate-promotion",
            "--receipt",
            str(fixture.out_receipt),
            "--candidate-tag",
            (fixture.prepared / "tag.txt").read_text().strip(),
            "--producer-commit",
            fixture.producer,
            "--merge-commit",
            fixture.merge,
            "--tap-commit",
            fixture.tap_source,
            "--tap-checkout-commit",
            fixture.tap_prepared,
            "--campaign-tag",
            fixture.source["prefix_campaign_tag"],
            "--campaign-layout-sha256",
            fixture.source["prefix_campaign_layout_sha256"],
            "--formula",
            "zlib",
            "--arch",
            fixture.arch,
            "--build-handoff",
            str(fixture.out_build),
            "--oci-child",
            str(fixture.out_oci),
            "--package-input",
            str(fixture.out_package),
        ]
        rejected = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("differs from its receipt", rejected.stderr)

    def test_promotion_rejects_an_extra_recorded_file(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        fixture.materialize()
        receipt = json.loads(fixture.out_receipt.read_text())
        receipt["files"].append(
            {
                "asset_name": "unexpected.bin",
                "bytes": 1,
                "path": "unexpected.bin",
                "sha256": sha256(b"x"),
            }
        )
        write_json(fixture.out_receipt, receipt)
        command = [
            "python3",
            str(TOOL),
            "validate-promotion",
            "--receipt",
            str(fixture.out_receipt),
            "--candidate-tag",
            (fixture.prepared / "tag.txt").read_text().strip(),
            "--producer-commit",
            fixture.producer,
            "--merge-commit",
            fixture.merge,
            "--tap-commit",
            fixture.tap_source,
            "--tap-checkout-commit",
            fixture.tap_prepared,
            "--campaign-tag",
            fixture.source["prefix_campaign_tag"],
            "--campaign-layout-sha256",
            fixture.source["prefix_campaign_layout_sha256"],
            "--formula",
            "zlib",
            "--arch",
            fixture.arch,
            "--build-handoff",
            str(fixture.out_build),
            "--oci-child",
            str(fixture.out_oci),
            "--package-input",
            str(fixture.out_package),
        ]
        rejected = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("exact artifact files", rejected.stderr)

    def test_candidate_authority_must_equal_the_base(self) -> None:
        fixture = self.fixture()
        fixture.source["workflow_authority_commit"] = fixture.producer
        write_json(fixture.source_path, fixture.source)
        result = fixture.prepare(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must equal its protected base", result.stderr)

    def test_substituted_release_asset_is_rejected(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        asset = fixture.prepared / "assets/build-bottle.tar.gz"
        asset.write_bytes(b"substituted")
        result = fixture.materialize(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from candidate.json", result.stderr)

    def test_partial_or_changed_package_generation_is_rejected(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        admitted = json.loads(fixture.admitted_path.read_text())
        admitted["package_input"]["archives"].pop()
        write_json(fixture.admitted_path, admitted)
        result = fixture.materialize(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not contain the candidate archives", result.stderr)

    def test_wrong_merge_parent_is_rejected(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        wrong = git(
            fixture.kandelo,
            "commit-tree",
            fixture.producer_tree,
            "-p",
            fixture.producer,
            input_text="wrong merge\n",
        )
        git(fixture.kandelo, "reset", "--hard", wrong)
        fixture.merge = wrong
        fixture.pr["mergeCommit"]["oid"] = wrong
        write_json(fixture.pr_path, fixture.pr)
        fixture.admitted["validated_against_main"] = wrong
        write_json(fixture.admitted_path, fixture.admitted)
        result = fixture.materialize(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not preserve the prepared base", result.stderr)

    def test_failed_workflow_run_is_rejected(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        failed = {**fixture.completed_run, "conclusion": "failure"}
        write_json(fixture.completed_run_path, failed)
        result = fixture.materialize(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conclusion is not successful", result.stderr)

    def test_dependency_substitution_is_rejected(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        dependencies = [
            {
                "formula": "dependency",
                "manifest_sha256": "3" * 64,
                "tag": "homebrew-prefix-handoff-sha256-" + "3" * 64,
            }
        ]
        write_json(fixture.dependencies_path, dependencies)
        result = fixture.materialize(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("activation dependencies differ", result.stderr)

    def test_unsorted_dependencies_are_rejected(self) -> None:
        fixture = self.fixture()
        fixture.dependencies = [
            {
                "formula": "z-last",
                "manifest_sha256": "1" * 64,
                "tag": "homebrew-prefix-handoff-sha256-" + "1" * 64,
            },
            {
                "formula": "a-first",
                "manifest_sha256": "2" * 64,
                "tag": "homebrew-prefix-handoff-sha256-" + "2" * 64,
            },
        ]
        write_json(fixture.dependencies_path, fixture.dependencies)
        result = fixture.prepare(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unique and sorted", result.stderr)

    def test_existing_homebrew_ref_requires_new_rebuild(self) -> None:
        fixture = self.fixture()
        fixture.destination["child_status"] = "present"
        fixture.destination["child_digest"] = \
            fixture.oci_receipt["oci"]["manifest"]["digest"]
        fixture.destination["homebrew_ref_status"] = "occupied"
        fixture.destination["top_status"] = "present"
        fixture.destination["top_digest"] = "sha256:" + "4" * 64
        write_json(fixture.destination_path, fixture.destination)
        result = fixture.prepare(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not collision-free", result.stderr)
        self.assertFalse((fixture.root / "prepared").exists())

        fixture.destination["child_status"] = "missing"
        fixture.destination["child_digest"] = None
        fixture.destination["homebrew_ref_status"] = "available"
        fixture.destination["top_status"] = "present"
        fixture.destination["top_digest"] = "sha256:" + "4" * 64
        write_json(fixture.destination_path, fixture.destination)
        fixture.prepare()
        self.assertTrue((fixture.prepared / "assets/candidate.json").is_file())

    def test_ambiguous_artifact_set_is_rejected(self) -> None:
        fixture = self.fixture()
        extra = dict(fixture.run["artifacts"][0])
        extra["id"] = 1004
        extra["name"] = "unexpected"
        fixture.run["artifacts"].append(extra)
        write_json(fixture.run_path, fixture.run)
        result = fixture.prepare(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exactly three candidate artifacts", result.stderr)

    def test_output_retry_does_not_overwrite_completed_result(self) -> None:
        fixture = self.fixture()
        fixture.prepare()
        original = (fixture.prepared / "assets/candidate.json").read_bytes()
        result = fixture.prepare(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not already exist", result.stderr)
        self.assertEqual(
            original, (fixture.prepared / "assets/candidate.json").read_bytes()
        )


if __name__ == "__main__":
    unittest.main()
