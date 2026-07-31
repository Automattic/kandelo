#!/usr/bin/env python3
"""Adversarial tests for prefix-campaign publisher checkout preparation."""

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
from types import SimpleNamespace
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent
TOOL = ROOT / "scripts/homebrew-prefix-campaign-publisher.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "homebrew_prefix_campaign_publisher_tested", TOOL
)
assert SPEC is not None and SPEC.loader is not None
PUBLISHER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PUBLISHER
SPEC.loader.exec_module(PUBLISHER)
CAMPAIGN = PUBLISHER.CAMPAIGN
EXECUTOR = PUBLISHER.EXECUTOR
PROVENANCE_SPEC = importlib.util.spec_from_file_location(
    "homebrew_dependency_provenance_campaign_test",
    ROOT / "scripts/homebrew-dependency-provenance.py",
)
assert (
    PROVENANCE_SPEC is not None
    and PROVENANCE_SPEC.loader is not None
)
PROVENANCE = importlib.util.module_from_spec(PROVENANCE_SPEC)
sys.modules[PROVENANCE_SPEC.name] = PROVENANCE
PROVENANCE_SPEC.loader.exec_module(PROVENANCE)

TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"
ALPHA_FORMULA_KEY = f"{TAP_NAME}/alpha"
KANDELO_COMMIT = "a" * 40


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


GUEST_LAYOUT_SHA256 = sha256(
    (ROOT / "homebrew/kandelo-guest-layout.json").read_bytes()
)


def run(arguments: list[str], root: pathlib.Path) -> str:
    result = subprocess.run(
        arguments,
        cwd=root,
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout.strip()


def write_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(EXECUTOR.pretty_json(value))


def commit(root: pathlib.Path, message: str) -> str:
    run(["git", "add", "-A"], root)
    run(
        [
            "git",
            "-c",
            "user.name=Campaign Publisher Test",
            "-c",
            "user.email=campaign-publisher@example.invalid",
            "commit",
            "-m",
            message,
        ],
        root,
    )
    return run(["git", "rev-parse", "HEAD"], root)


def formula(name: str, description: str) -> bytes:
    class_name = "".join(part.title() for part in name.split("-"))
    return (
        f"class {class_name} < Formula\n"
        f'  desc "{description}"\n'
        "end\n"
    ).encode()


def file_identity(payload: bytes) -> dict[str, Any]:
    return {
        "blob_git_oid": CAMPAIGN.git_object_id("blob", payload),
        "bytes": len(payload),
        "mode": "100644",
        "sha256": sha256(payload),
    }


class Fixture:
    def __init__(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="homebrew-prefix-publisher-test-"
        )
        self.root = pathlib.Path(self.temporary.name)
        self.tap = self.root / "tap"
        self.tap.mkdir()
        run(["git", "init", "-q"], self.tap)
        (self.tap / "Formula").mkdir()
        base_payloads = {
            name: formula(name, "live base")
            for name in ("alpha", "beta")
        }
        for name, payload in base_payloads.items():
            (self.tap / f"Formula/{name}.rb").write_bytes(payload)
        self.base_commit = commit(self.tap, "base tap")
        self.base_tree = run(
            ["git", "rev-parse", f"{self.base_commit}^{{tree}}"],
            self.tap,
        )

        self.target_payloads = {
            name: formula(name, "sealed campaign target")
            for name in ("alpha", "beta")
        }
        for name, payload in self.target_payloads.items():
            (self.tap / f"Formula/{name}.rb").write_bytes(payload)
        self.target_commit = commit(self.tap, "target tap")
        self.target_tree = run(
            ["git", "rev-parse", f"{self.target_commit}^{{tree}}"],
            self.tap,
        )
        run(
            ["git", "checkout", "--detach", self.base_commit],
            self.tap,
        )

        source_root = (
            self.tap / "Kandelo/campaigns/prefix-v1/source"
        )
        (source_root / "Formula").mkdir(parents=True)
        records: list[dict[str, Any]] = []
        for name in ("alpha", "beta"):
            target = self.target_payloads[name]
            (source_root / f"Formula/{name}.rb").write_bytes(target)
            records.append(
                {
                    "base": file_identity(base_payloads[name]),
                    "path": f"Formula/{name}.rb",
                    "target": file_identity(target),
                }
            )
        manifest = {
            "base": {
                "commit": self.base_commit,
                "tree_git_oid": self.base_tree,
            },
            "campaign": "prefix-v1",
            "files": records,
            "kind": "kandelo-homebrew-prefix-campaign-source-overlay",
            "schema": 1,
            "source_root": "Kandelo/campaigns/prefix-v1/source",
            "target_tree_git_oid": self.target_tree,
        }
        manifest_path = self.tap / CAMPAIGN.SOURCE_MANIFEST_PATH
        write_json(manifest_path, manifest)
        materializer = self.tap / CAMPAIGN.SOURCE_MATERIALIZER_PATH
        materializer.parent.mkdir(parents=True, exist_ok=True)
        materializer.write_text(
            "#!/usr/bin/env python3\n"
            "raise SystemExit('publisher executed untrusted tap code')\n",
            encoding="utf-8",
        )
        materializer.chmod(0o755)
        write_json(
            self.tap / CAMPAIGN.SOURCE_AUTHORITY_PATH,
            {
                "target_source": {
                    "manifest_path": CAMPAIGN.SOURCE_MANIFEST_PATH,
                    "manifest_sha256": sha256(
                        manifest_path.read_bytes()
                    ),
                    "source_root": (
                        "Kandelo/campaigns/prefix-v1/source"
                    ),
                    "source_tree_git_oid": (
                        CAMPAIGN.filesystem_git_tree_oid(
                            source_root, "publisher test source overlay"
                        )
                    ),
                    "target_tree_git_oid": self.target_tree,
                }
            },
        )
        self.source_commit = commit(self.tap, "sealed source overlay")
        probe = self.root / "materialization-probe"
        _snapshot, self.source_materialization = (
            CAMPAIGN.candidate_source_snapshot(
                CAMPAIGN.git_authority(
                    self.tap,
                    self.source_commit,
                    "publisher test tap",
                ),
                self.source_commit,
                probe,
            )
        )
        shutil.rmtree(probe)

        self.formulae = [
            self.formula_record("alpha", "1.0", []),
            self.formula_record("beta", "2.0", [("alpha", "1.0")]),
        ]
        self.campaign = {
            "authority": {
                "current_kandelo_abi": 42,
                "guest_layout": {
                    "path": "homebrew/kandelo-guest-layout.json",
                    "sha256": GUEST_LAYOUT_SHA256,
                },
                "kandelo_commit": KANDELO_COMMIT,
                "source_materialization": self.source_materialization,
                "source_tap_commit": self.source_commit,
                "tap_name": TAP_NAME,
                "tap_repository": TAP_REPOSITORY,
            },
            "formulae": self.formulae,
            "kind": "kandelo-homebrew-guest-prefix-campaign",
            "schema": 1,
        }
        self.campaign_path = self.root / "campaign.json"
        write_json(self.campaign_path, self.campaign)
        self.campaign_tag = (
            "homebrew-prefix-campaign-sha256-"
            + sha256(self.campaign_path.read_bytes())
        )
        self.alpha_handoff = self.make_alpha_handoff()
        self.alpha_tag = EXECUTOR.handoff_tag(
            (self.alpha_handoff / "handoff.json").read_bytes()
        )

    def close(self) -> None:
        self.temporary.cleanup()

    def formula_record(
        self,
        name: str,
        version: str,
        dependencies: list[tuple[str, str]],
    ) -> dict[str, Any]:
        payload = self.target_payloads[name]
        return {
            "dependencies": [
                {
                    "full_name": f"{TAP_NAME}/{dependency}",
                    "version": dependency_version,
                }
                for dependency, dependency_version in dependencies
            ],
            "destination": {
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
            "source_kind": "fixture",
            "variants": [
                {
                    "arch": "wasm32",
                    "disposition": {
                        "kind": "required-build",
                        "reasons": ["fixture"],
                    },
                    "selected_by": "fixture",
                }
            ],
            "version": version,
        }

    def make_alpha_handoff(self) -> pathlib.Path:
        root = self.root / "alpha-handoff"
        publication = root / "payload/wasm32"
        archive_payload = b"fixture build/bottle.tar.gz\n"
        for relative in EXECUTOR.PUBLICATION_FILES:
            path = publication / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if relative == "build/bottle.json":
                write_json(
                    path,
                    {
                        ALPHA_FORMULA_KEY: {
                            "bottle": {
                                "cellar": "/opt/kandelo/homebrew/Cellar",
                                "rebuild": 0,
                                "root_url": (
                                    "https://ghcr.io/v2/"
                                    f"{TAP_REPOSITORY}"
                                ),
                                "tags": {
                                    "wasm32_kandelo": {
                                        "all_files": [
                                            ".brew/alpha.rb",
                                            "INSTALL_RECEIPT.json",
                                            "bin/alpha",
                                        ],
                                        "local_filename": (
                                            "alpha--1.0.wasm32_kandelo."
                                            "bottle.tar.gz"
                                        ),
                                        "path_exec_files": ["bin/alpha"],
                                        "sha256": sha256(archive_payload),
                                        "tab": {
                                            "runtime_dependencies": []
                                        },
                                    }
                                },
                            },
                            "formula": {
                                "name": "alpha",
                                "path": (
                                    "Library/Taps/kandelo-dev/"
                                    "homebrew-tap-core/Formula/alpha.rb"
                                ),
                                "pkg_version": "1.0",
                            },
                        }
                    },
                )
            elif relative.endswith(".json"):
                write_json(path, {"fixture": relative})
            elif relative == "build/bottle.tar.gz":
                path.write_bytes(archive_payload)
            else:
                path.write_bytes(f"fixture {relative}\n".encode())
        files = [
            EXECUTOR.file_record(
                publication / relative,
                f"payload/wasm32/{relative}",
                EXECUTOR.publication_asset_name("wasm32", relative),
            )
            for relative in EXECUTOR.PUBLICATION_FILES
        ]
        manifest = {
            "campaign": {
                "sha256": sha256(self.campaign_path.read_bytes())
            },
            "dependency_handoffs": [],
            "formula": EXECUTOR.campaign_formula_evidence(
                self.campaign, self.formulae[0]
            ),
            "kind": "kandelo-homebrew-prefix-formula-handoff",
            "publications": [
                {"arch": "wasm32", "files": files, "kind": "build"}
            ],
            "schema": EXECUTOR.HANDOFF_SCHEMA,
            "source": {
                "kandelo_commit": KANDELO_COMMIT,
                "source_tap_commit": self.source_commit,
                "target_tree_git_oid": self.target_tree,
                "tap_name": TAP_NAME,
                "tap_repository": TAP_REPOSITORY,
            },
        }
        write_json(root / "handoff.json", manifest)
        EXECUTOR.load_handoff(
            root, self.campaign, self.campaign_path.read_bytes()
        )
        return root

    def rewrite_alpha_bottle(
        self,
        mutate: Callable[[dict[str, Any]], None],
    ) -> None:
        bottle_path = (
            self.alpha_handoff
            / "payload/wasm32/build/bottle.json"
        )
        bottle = json.loads(bottle_path.read_text())
        mutate(bottle)
        write_json(bottle_path, bottle)
        handoff_path = self.alpha_handoff / "handoff.json"
        handoff = json.loads(handoff_path.read_text())
        record = next(
            record
            for record in handoff["publications"][0]["files"]
            if record["path"] == "payload/wasm32/build/bottle.json"
        )
        record["bytes"] = bottle_path.stat().st_size
        record["sha256"] = sha256(bottle_path.read_bytes())
        write_json(handoff_path, handoff)
        self.alpha_tag = EXECUTOR.handoff_tag(
            handoff_path.read_bytes()
        )

    def fetch_campaign(
        self,
        repository: str,
        tag: str,
        output: pathlib.Path,
        receipt: pathlib.Path,
    ) -> None:
        self.assert_equal(repository, TAP_REPOSITORY)
        self.assert_equal(tag, self.campaign_tag)
        shutil.copy2(self.campaign_path, output)
        write_json(receipt, {"fixture": "campaign readback"})

    def fetch_handoff(
        self,
        _campaign_path: pathlib.Path,
        tag: str,
        output: pathlib.Path,
        receipt: pathlib.Path,
        dependency_roots: list[pathlib.Path],
    ) -> None:
        self.assert_equal(tag, self.alpha_tag)
        self.assert_equal(dependency_roots, [])
        shutil.copytree(self.alpha_handoff, output)
        write_json(receipt, {"fixture": "handoff readback"})

    @staticmethod
    def assert_equal(actual: Any, expected: Any) -> None:
        if actual != expected:
            raise AssertionError(f"{actual!r} != {expected!r}")

    def merge_dependency(self, **arguments: Any) -> None:
        self.assert_equal(arguments["formula"], "alpha")
        self.assert_equal(arguments["arch"], "wasm32")
        self.assert_equal(arguments["release_tag"], "bottles-abi-v42")
        canonical = json.loads(
            pathlib.Path(arguments["bottle_json"]).read_text()
        )
        self.assert_equal(list(canonical), ["alpha"])
        self.assert_equal(
            list(
                canonical["alpha"]["bottle"]["tags"][
                    "wasm32_kandelo"
                ]
            ),
            ["sha256"],
        )
        path = pathlib.Path(arguments["tap_root"]) / "Formula/alpha.rb"
        path.write_bytes(
            path.read_bytes() + b"# fixture sealed dependency bottle\n"
        )

    def dependencies(self) -> PUBLISHER.PreparationDependencies:
        return PUBLISHER.PreparationDependencies(
            fetch_campaign=self.fetch_campaign,
            fetch_handoff=self.fetch_handoff,
            merge_dependency=self.merge_dependency,
        )

    def dependency_json(self) -> str:
        return PUBLISHER.compact_json(
            {
                "dependencies": [
                    {"formula": "alpha", "tag": self.alpha_tag}
                ],
                "schema": 1,
            }
        )

    def prepare(
        self,
        *,
        dependency_request: str | None = None,
        arch: str | None = "wasm32",
    ) -> dict[str, Any]:
        return PUBLISHER.prepare(
            tap_root=self.tap,
            kandelo_commit=KANDELO_COMMIT,
            tap_repository=TAP_REPOSITORY,
            tap_name=TAP_NAME,
            source_tap_commit=self.source_commit,
            campaign_tag=self.campaign_tag,
            dependency_request=(
                dependency_request
                if dependency_request is not None
                else self.dependency_json()
            ),
            formula="beta",
            arch=arch,
            work_root=self.root / "publisher-work",
            receipt_output=self.root / "publisher-receipt.json",
            github_env=self.root / "github.env",
            github_output=self.root / "github.output",
            dependencies=self.dependencies(),
        )


class PrefixCampaignPublisherTests(unittest.TestCase):
    def test_dependency_provenance_selects_only_the_campaign_cellar(
        self,
    ) -> None:
        self.assertEqual(
            PROVENANCE.selected_bottle_cellars(
                SimpleNamespace(
                    prefix_campaign_layout_sha256=GUEST_LAYOUT_SHA256
                )
            ),
            (
                "any",
                "any_skip_relocation",
                "/opt/kandelo/homebrew/Cellar",
            ),
        )
        self.assertNotIn(
            "/home/linuxbrew/.linuxbrew/Cellar",
            PROVENANCE.selected_bottle_cellars(
                SimpleNamespace(
                    prefix_campaign_layout_sha256=GUEST_LAYOUT_SHA256
                )
            ),
        )
        with self.assertRaisesRegex(
            PROVENANCE.ProvenanceError,
            "differs from campaign authority",
        ):
            PROVENANCE.selected_bottle_cellars(
                SimpleNamespace(prefix_campaign_layout_sha256="0" * 64)
            )

    def test_sealed_target_and_dependency_bottle_become_clean_snapshot(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        receipt = fixture.prepare()
        self.assertEqual(
            (fixture.tap / "Formula/beta.rb").read_bytes(),
            fixture.target_payloads["beta"],
        )
        self.assertTrue(
            (fixture.tap / "Formula/alpha.rb")
            .read_bytes()
            .endswith(b"# fixture sealed dependency bottle\n")
        )
        self.assertEqual(
            run(["git", "status", "--short"], fixture.tap), ""
        )
        self.assertEqual(
            run(["git", "rev-parse", "HEAD"], fixture.tap),
            receipt["preparation"]["commit"],
        )
        self.assertEqual(
            receipt["campaign"]["guest_layout"],
            {
                "path": "homebrew/kandelo-guest-layout.json",
                "sha256": GUEST_LAYOUT_SHA256,
            },
        )
        self.assertIn(
            "KANDELO_HOMEBREW_PREFIX_CAMPAIGN_LAYOUT_SHA256="
            f"{GUEST_LAYOUT_SHA256}\n",
            (fixture.root / "github.env").read_text(),
        )
        self.assertEqual(
            (fixture.root / "github.output").read_text(),
            "prefix-campaign-layout-sha256="
            f"{GUEST_LAYOUT_SHA256}\n",
        )
        self.assertEqual(
            run(
                [
                    "git",
                    "rev-parse",
                    f"{receipt['source']['materialized_commit']}^",
                ],
                fixture.tap,
            ),
            fixture.source_commit,
        )
        PUBLISHER.verify(
            tap_root=fixture.tap,
            receipt_path=fixture.root / "publisher-receipt.json",
        )
        resolved = fixture.root / "resolved-taps.json"
        subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/homebrew-dependency-taps.py"),
                "resolve",
                "--tap-root",
                str(fixture.tap),
                "--tap-name",
                TAP_NAME,
                "--tap-repository",
                TAP_REPOSITORY,
                "--tap-commit",
                fixture.source_commit,
                "--checkout-commit",
                receipt["preparation"]["commit"],
                "--out",
                str(resolved),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        resolved_value = json.loads(resolved.read_text())
        self.assertEqual(resolved_value["schema"], 2)
        self.assertEqual(
            resolved_value["primary"]["tap_commit"],
            fixture.source_commit,
        )
        self.assertEqual(
            resolved_value["primary"]["checkout_commit"],
            receipt["preparation"]["commit"],
        )
        prior_resolved = os.environ.get(
            "KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"
        )
        os.environ["KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"] = str(
            resolved
        )
        try:
            contexts = PROVENANCE.resolved_tap_contexts(
                SimpleNamespace(
                    tap_name=TAP_NAME,
                    tap_repository=TAP_REPOSITORY,
                    tap_commit=fixture.source_commit,
                    tap_checkout_commit=receipt["preparation"]["commit"],
                    tap_root=str(fixture.tap),
                )
            )
        finally:
            if prior_resolved is None:
                os.environ.pop(
                    "KANDELO_HOMEBREW_RESOLVED_TAPS_FILE", None
                )
            else:
                os.environ[
                    "KANDELO_HOMEBREW_RESOLVED_TAPS_FILE"
                ] = prior_resolved
        self.assertEqual(
            contexts[TAP_NAME]["checkout_commit"],
            receipt["preparation"]["commit"],
        )

    def test_source_only_preparation_still_validates_exact_closure(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        receipt = fixture.prepare(arch=None)
        self.assertEqual(receipt["fetched_dependency_handoffs"], [])
        self.assertEqual(
            receipt["preparation"]["tree_git_oid"],
            fixture.target_tree,
        )
        self.assertEqual(
            (fixture.tap / "Formula/alpha.rb").read_bytes(),
            fixture.target_payloads["alpha"],
        )

    def test_noncanonical_or_incomplete_dependency_request_is_rejected(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(
            PUBLISHER.PublisherCampaignError, "canonical compact"
        ):
            fixture.prepare(
                dependency_request=json.dumps(
                    {
                        "dependencies": [
                            {
                                "formula": "alpha",
                                "tag": fixture.alpha_tag,
                            }
                        ],
                        "schema": 1,
                    }
                )
            )

        fixture = Fixture()
        self.addCleanup(fixture.close)
        with self.assertRaisesRegex(
            PUBLISHER.PublisherCampaignError, "exact Formula closure"
        ):
            fixture.prepare(
                dependency_request='{"dependencies":[],"schema":1}'
            )

    def test_dirty_source_and_post_preparation_mutation_fail_closed(
        self,
    ) -> None:
        fixture = Fixture()
        self.addCleanup(fixture.close)
        (fixture.tap / "untracked").write_text("unexpected\n")
        with self.assertRaisesRegex(
            PUBLISHER.PublisherCampaignError, "must be clean"
        ):
            fixture.prepare()

        fixture = Fixture()
        self.addCleanup(fixture.close)
        fixture.prepare()
        (fixture.tap / "Formula/beta.rb").write_text("tampered\n")
        with self.assertRaisesRegex(
            PUBLISHER.PublisherCampaignError, "changed after"
        ):
            PUBLISHER.verify(
                tap_root=fixture.tap,
                receipt_path=fixture.root / "publisher-receipt.json",
            )

    def test_bottle_metadata_must_match_the_sealed_handoff(
        self,
    ) -> None:
        mutations = {
            "digest differs": lambda value: value[ALPHA_FORMULA_KEY]["bottle"][
                "tags"
            ]["wasm32_kandelo"].update({"sha256": "f" * 64}),
            "root URL": lambda value: value[ALPHA_FORMULA_KEY][
                "bottle"
            ].update({"root_url": "https://ghcr.io/v2/example/wrong"}),
            "cellar": lambda value: value[ALPHA_FORMULA_KEY][
                "bottle"
            ].update({"cellar": "/home/linuxbrew/.linuxbrew/Cellar"}),
            "identity": lambda value: value[ALPHA_FORMULA_KEY][
                "formula"
            ].update({"pkg_version": "9.9"}),
        }
        for message, mutate in mutations.items():
            with self.subTest(message=message):
                fixture = Fixture()
                self.addCleanup(fixture.close)
                fixture.rewrite_alpha_bottle(mutate)
                with self.assertRaises(
                    PUBLISHER.PublisherCampaignError
                ):
                    fixture.prepare()


if __name__ == "__main__":
    unittest.main(verbosity=2)
