#!/usr/bin/env python3
"""Adversarial tests for pre-merge Homebrew campaign evidence."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest


ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOL_PATH = ROOT / "scripts/homebrew-candidate-campaign.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "homebrew_candidate_campaign_test_tool", TOOL_PATH
)
assert SPEC is not None and SPEC.loader is not None
TOOL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TOOL
SPEC.loader.exec_module(TOOL)

KANDELO_REPOSITORY = "Automattic/kandelo"
TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"


def write_json(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(TOOL.pretty_json(value))


def run(root: pathlib.Path, *arguments: str) -> str:
    result = subprocess.run(
        list(arguments),
        cwd=root,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def git(root: pathlib.Path, *arguments: str) -> str:
    return run(root, "git", *arguments)


def commit(root: pathlib.Path, message: str) -> str:
    git(root, "add", "-A")
    git(
        root,
        "-c",
        "user.name=Candidate Campaign Test",
        "-c",
        "user.email=candidate@example.invalid",
        "commit",
        "-m",
        message,
    )
    return git(root, "rev-parse", "HEAD")


def formula_record() -> dict[str, object]:
    return {
        "dependencies": [],
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
            "reference": "1.0",
            "remote": f"ghcr.io/{TAP_REPOSITORY}/alpha",
        },
        "formula_source": {
            "identity_excluding_bottle_sha256": "8" * 64,
            "path": "Formula/alpha.rb",
            "sha256": "9" * 64,
        },
        "name": "alpha",
        "source_kind": "reviewed-new-entrant",
        "variants": [
            {
                "arch": "wasm32",
                "build_input": {"kind": "formula-source"},
                "disposition": {
                    "kind": "required-build",
                    "reasons": ["new-campaign-entrant"],
                },
                "selected_by": "reviewed-campaign-input",
            }
        ],
        "version": "1.0",
    }


class CandidateCampaignFixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="homebrew-candidate-campaign-test-"
        )
        self.root = pathlib.Path(self.temporary.name)
        self.base = "1" * 40
        self.producer = "2" * 40
        self.producer_tree = "3" * 40
        self.tap = "4" * 40
        self.tap_tree = "5" * 40
        self.tap_authority = "6" * 40
        self.native = "7" * 40
        self.source = {
            "schema": 1,
            "kind": "kandelo-homebrew-prefix-campaign-candidate-source",
            "kandelo_repository": KANDELO_REPOSITORY,
            "pr_number": 77,
            "base_commit": self.base,
            "producer_commit": self.producer,
            "producer_tree": self.producer_tree,
            "workflow_authority_commit": self.base,
            "abi": 43,
            "abi_snapshot": {
                "path": "abi/snapshot.json",
                "sha256": "a" * 64,
            },
            "guest_layout": {
                "path": "homebrew/kandelo-guest-layout.json",
                "sha256": "b" * 64,
            },
            "tap_repository": TAP_REPOSITORY,
            "tap_name": TAP_NAME,
            "source_tap_commit": self.tap,
            "source_tap_tree": self.tap_tree,
            "tap_workflow_authority_commit": self.tap_authority,
            "old_metadata": {
                "path": "Kandelo/metadata.json",
                "sha256": "c" * 64,
            },
            "native_homebrew_commit": self.native,
        }
        self.run = {
            "schema": 1,
            "repository": TAP_REPOSITORY,
            "workflow_path": ".github/workflows/candidate-campaign.yml",
            "caller_commit": self.tap_authority,
            "event": "repository_dispatch",
            "run_id": 900,
            "run_attempt": 2,
            "status": "in_progress",
            "conclusion": None,
            "artifacts": [
                {
                    "id": 901,
                    "name": (
                        "homebrew-candidate-campaign-derivation-attempt-2"
                    ),
                    "bytes": 1234,
                    "digest": "sha256:" + "d" * 64,
                    "run_id": 900,
                    "run_attempt": 2,
                }
            ],
        }
        self.campaign = {
            "schema": 2,
            "kind": "kandelo-homebrew-guest-prefix-campaign",
            "authority": {
                "abi_snapshot": self.source["abi_snapshot"],
                "current_kandelo_abi": 43,
                "guest_layout": self.source["guest_layout"],
                "kandelo_commit": self.producer,
                "native_homebrew_commit": self.native,
                "old_metadata": self.source["old_metadata"],
                "old_tap_commit": self.tap,
                "source_materialization": {
                    "kind": "exact-git-tree-v1",
                    "tree_git_oid": self.tap_tree,
                },
                "source_tap_commit": self.tap,
                "tap_name": TAP_NAME,
                "tap_repository": TAP_REPOSITORY,
            },
            "formulae": [formula_record()],
        }
        self.source_path = self.root / "source.json"
        self.run_path = self.root / "run.json"
        self.campaign_path = self.root / "campaign.json"
        write_json(self.source_path, self.source)
        write_json(self.run_path, self.run)
        write_json(self.campaign_path, self.campaign)

    def close(self) -> None:
        self.temporary.cleanup()


class CandidateCampaignTests(unittest.TestCase):
    def test_prepare_uses_noncanonical_content_addressed_namespace(self) -> None:
        fixture = CandidateCampaignFixture()
        self.addCleanup(fixture.close)
        output = fixture.root / "prepared"
        TOOL.prepare(
            types.SimpleNamespace(
                source=str(fixture.source_path),
                run_evidence=str(fixture.run_path),
                campaign=str(fixture.campaign_path),
                out=str(output),
            )
        )
        tag = (output / "tag.txt").read_text().strip()
        self.assertRegex(tag, TOOL.CANDIDATE_TAG)
        self.assertNotRegex(tag, TOOL.EXECUTOR.CAMPAIGN_TAG)
        release = json.loads((output / "release-manifest.json").read_text())
        self.assertEqual(release["target_commitish"], fixture.tap_authority)
        self.assertEqual(
            {asset["name"] for asset in release["assets"]},
            {"campaign.json", "candidate-campaign.json"},
        )
        description = fixture.root / "description.json"
        TOOL.describe_release(
            types.SimpleNamespace(
                candidate=str(output / "assets/candidate-campaign.json"),
                campaign=str(output / "assets/campaign.json"),
                candidate_tag=tag,
                out=str(description),
            )
        )
        described = json.loads(description.read_text())
        self.assertEqual(described["manifest"]["source"], fixture.source)
        self.assertEqual(
            described["campaign_sha256"],
            TOOL.sha256_file(fixture.campaign_path),
        )

    def test_prepare_rejects_campaign_from_another_producer(self) -> None:
        fixture = CandidateCampaignFixture()
        self.addCleanup(fixture.close)
        fixture.campaign["authority"]["kandelo_commit"] = "e" * 40
        write_json(fixture.campaign_path, fixture.campaign)
        with self.assertRaisesRegex(
            TOOL.CandidateCampaignError, "authority differs"
        ):
            TOOL.prepare(
                types.SimpleNamespace(
                    source=str(fixture.source_path),
                    run_evidence=str(fixture.run_path),
                    campaign=str(fixture.campaign_path),
                    out=str(fixture.root / "rejected"),
                )
            )

    def test_exact_merge_rejects_premerge_and_admits_preserved_head(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="candidate-campaign-merge-test-"
        ) as temporary_name:
            root = pathlib.Path(temporary_name)
            repository = root / "repository"
            repository.mkdir()
            git(repository, "init", "-q", "-b", "main")
            (repository / "value").write_text("base\n")
            base = commit(repository, "base")
            git(repository, "checkout", "-q", "-b", "candidate")
            (repository / "value").write_text("candidate\n")
            producer = commit(repository, "candidate")
            producer_tree = git(repository, "rev-parse", "HEAD^{tree}")
            producer_root = root / "producer"
            run(root, "git", "clone", "-q", str(repository), str(producer_root))
            git(producer_root, "checkout", "-q", producer)

            source = {
                "pr_number": 77,
                "base_commit": base,
                "producer_commit": producer,
                "producer_tree": producer_tree,
                "workflow_authority_commit": base,
            }
            with self.assertRaisesRegex(
                TOOL.CandidateCampaignError,
                r"preserve \[base, exact head\]",
            ):
                TOOL.validate_exact_merge(
                    producer_root,
                    producer_root,
                    source,
                    producer,
                    producer,
                )

            git(repository, "checkout", "-q", "main")
            git(
                repository,
                "-c",
                "user.name=Candidate Campaign Test",
                "-c",
                "user.email=candidate@example.invalid",
                "merge",
                "--no-ff",
                "--no-edit",
                "candidate",
            )
            merged = git(repository, "rev-parse", "HEAD")
            self.assertEqual(
                git(repository, "show", "-s", "--format=%P", merged),
                f"{base} {producer}",
            )
            TOOL.validate_exact_merge(
                repository,
                producer_root,
                source,
                merged,
                merged,
            )

    def test_admission_validator_binds_merge_source_abi_and_layout(self) -> None:
        tag = (
            "homebrew-prefix-campaign-candidate-pr-77-run-900-attempt-2-"
            "sha256-" + "d" * 64
        )
        receipt = {
            "schema": 1,
            "kind": "kandelo-homebrew-prefix-campaign-candidate-admission",
            "candidate_tag": tag,
            "candidate_sha256": "d" * 64,
            "campaign_sha256": "e" * 64,
            "producer_commit": "1" * 40,
            "merge_commit": "2" * 40,
            "validated_against_main": "2" * 40,
            "source_tap_commit": "3" * 40,
            "tap_workflow_authority_commit": "4" * 40,
            "abi": 43,
            "abi_snapshot_sha256": "5" * 64,
            "guest_layout_sha256": "6" * 64,
            "run_id": 900,
            "run_attempt": 2,
        }
        with tempfile.TemporaryDirectory(
            prefix="candidate-campaign-admission-test-"
        ) as temporary_name:
            path = pathlib.Path(temporary_name) / "receipt.json"
            write_json(path, receipt)
            arguments = types.SimpleNamespace(
                receipt=str(path),
                candidate_tag=tag,
                producer_commit="1" * 40,
                merge_commit="2" * 40,
                source_tap_commit="3" * 40,
                abi=43,
                guest_layout_sha256="6" * 64,
            )
            TOOL.validate_admission(arguments)
            arguments.abi = 42
            with self.assertRaisesRegex(
                TOOL.CandidateCampaignError, "publication field abi"
            ):
                TOOL.validate_admission(arguments)


if __name__ == "__main__":
    unittest.main()
