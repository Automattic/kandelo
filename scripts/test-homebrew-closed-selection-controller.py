#!/usr/bin/env python3
"""Regression tests for closed-selection publication admission."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/homebrew-closed-selection-controller.py"
SPEC = importlib.util.spec_from_file_location(
    "homebrew_closed_selection_controller",
    SCRIPT,
)
assert SPEC is not None and SPEC.loader is not None
CONTROLLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROLLER)


class FakeExecutorError(RuntimeError):
    pass


class ClosedSelectionControllerTests(unittest.TestCase):
    CALLER_SHA = "3" * 40

    def setUp(self) -> None:
        self.campaign = {
            "authority": {
                "kandelo_commit": "1" * 40,
                "source_tap_commit": "2" * 40,
                "tap_name": "kandelo-dev/tap-core",
                "tap_repository": "kandelo-dev/homebrew-tap-core",
            },
            "formulae": [],
            "kind": "kandelo-homebrew-guest-prefix-campaign",
            "schema": 2,
        }
        self.campaign_payload = (
            json.dumps(self.campaign, indent=2, sort_keys=True) + "\n"
        ).encode()
        self.index = {
            "dep": {
                "dependencies": [],
                "runtime_dependencies": [],
                "name": "dep",
                "version": "1",
            },
            "root": {
                "dependencies": [
                    {
                        "full_name": "kandelo-dev/tap-core/dep",
                        "version": "1",
                    }
                ],
                "runtime_dependencies": [
                    {
                        "full_name": "kandelo-dev/tap-core/dep",
                        "version": "1",
                    }
                ],
                "name": "root",
                "version": "1",
            },
        }
        self.plan = {
            "campaign_tag": (
                "homebrew-prefix-campaign-sha256-"
                + hashlib.sha256(self.campaign_payload).hexdigest()
            ),
            "handoffs": {
                "dep": "homebrew-prefix-handoff-sha256-" + "a" * 64,
                "root": "homebrew-prefix-handoff-sha256-" + "b" * 64,
            },
            "kandelo_commit": "1" * 40,
            "kind": CONTROLLER.PLAN_KIND,
            "roots": ["root"],
            "schema": 1,
            "source_tap_commit": "2" * 40,
        }

    def event(self, plan: dict | None = None) -> dict:
        selected = self.plan if plan is None else plan
        compact = CONTROLLER.compact_json(selected).decode().rstrip("\n")
        return {
            "inputs": {
                "expected_caller_sha": self.CALLER_SHA,
                "selection_plan": compact,
                "selection_plan_sha256": hashlib.sha256(
                    CONTROLLER.compact_json(selected)
                ).hexdigest(),
            },
            "repository": {
                "default_branch": "main",
                "full_name": "Kandelo-dev/Homebrew-Tap-Core",
            },
        }

    def admit(
        self,
        event: dict,
        *,
        caller_sha: str | None = None,
        expected_caller_sha: str | None = None,
    ) -> tuple[dict, str, bytes]:
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            event_path = temporary / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")
            plan_path = temporary / "plan.json"
            output_path = temporary / "github-output"
            output_path.touch()
            result = CONTROLLER.admit(
                event_path=event_path,
                caller_sha=caller_sha or self.CALLER_SHA,
                expected_caller_sha=(
                    expected_caller_sha or self.CALLER_SHA
                ),
                github_ref="refs/heads/main",
                workflow_ref=CONTROLLER.TAP_WORKFLOW_REF,
                selection_plan=event["inputs"]["selection_plan"],
                selection_plan_sha256=(
                    event["inputs"]["selection_plan_sha256"]
                ),
                plan_output=plan_path,
                github_output=output_path,
            )
            return result, output_path.read_text(), plan_path.read_bytes()

    def test_admit_binds_canonical_plan_and_digest(self) -> None:
        result, outputs, plan_payload = self.admit(self.event())
        self.assertEqual(result["caller-sha"], self.CALLER_SHA)
        self.assertEqual(result["campaign-kandelo-commit"], "1" * 40)
        self.assertEqual(
            result["source-tap-commit"],
            "2" * 40,
        )
        self.assertIn(
            f"plan-sha256={CONTROLLER.plan_digest(self.plan)}\n",
            outputs,
        )
        self.assertEqual(plan_payload, CONTROLLER.pretty_json(self.plan))

    def test_admit_rejects_non_main_caller(self) -> None:
        event = self.event()
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            event_path = temporary / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")
            github_output = temporary / "output"
            github_output.touch()
            with self.assertRaisesRegex(
                CONTROLLER.ControllerError,
                "protected tap caller",
            ):
                CONTROLLER.admit(
                    event_path=event_path,
                    caller_sha=self.CALLER_SHA,
                    expected_caller_sha=self.CALLER_SHA,
                    github_ref="refs/heads/feature",
                    workflow_ref=CONTROLLER.TAP_WORKFLOW_REF,
                    selection_plan=event["inputs"]["selection_plan"],
                    selection_plan_sha256=(
                        event["inputs"]["selection_plan_sha256"]
                    ),
                    plan_output=temporary / "plan.json",
                    github_output=github_output,
                )

    def test_admit_rejects_digest_substitution(self) -> None:
        event = self.event()
        event["inputs"]["selection_plan_sha256"] = "0" * 64
        with self.assertRaisesRegex(
            CONTROLLER.ControllerError,
            "differs from its SHA-256",
        ):
            self.admit(event)

    def test_admit_rejects_reusable_input_substitution(self) -> None:
        event = self.event()
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            event_path = temporary / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")
            github_output = temporary / "output"
            github_output.touch()
            with self.assertRaisesRegex(
                CONTROLLER.ControllerError,
                "differ from the dispatch event",
            ):
                CONTROLLER.admit(
                    event_path=event_path,
                    caller_sha=self.CALLER_SHA,
                    expected_caller_sha=self.CALLER_SHA,
                    github_ref="refs/heads/main",
                    workflow_ref=CONTROLLER.TAP_WORKFLOW_REF,
                    selection_plan="{}",
                    selection_plan_sha256=(
                        event["inputs"]["selection_plan_sha256"]
                    ),
                    plan_output=temporary / "plan.json",
                    github_output=github_output,
                )

    def test_admit_rejects_resolved_caller_mismatch_before_writing(self) -> None:
        event = self.event()
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            event_path = temporary / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")
            plan_path = temporary / "plan.json"
            output_path = temporary / "github-output"
            output_path.touch()
            with self.assertRaisesRegex(
                CONTROLLER.ControllerError,
                "caller SHA differs from the expected caller SHA",
            ):
                CONTROLLER.admit(
                    event_path=event_path,
                    caller_sha="4" * 40,
                    expected_caller_sha=self.CALLER_SHA,
                    github_ref="refs/heads/main",
                    workflow_ref=CONTROLLER.TAP_WORKFLOW_REF,
                    selection_plan=event["inputs"]["selection_plan"],
                    selection_plan_sha256=(
                        event["inputs"]["selection_plan_sha256"]
                    ),
                    plan_output=plan_path,
                    github_output=output_path,
                )
            self.assertFalse(plan_path.exists())
            self.assertEqual(output_path.read_bytes(), b"")

    def test_admit_rejects_dispatch_caller_substitution(self) -> None:
        event = self.event()
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            event_path = temporary / "event.json"
            event_path.write_text(json.dumps(event), encoding="utf-8")
            output_path = temporary / "github-output"
            output_path.touch()
            with self.assertRaisesRegex(
                CONTROLLER.ControllerError,
                "differ from the dispatch event",
            ):
                CONTROLLER.admit(
                    event_path=event_path,
                    caller_sha="4" * 40,
                    expected_caller_sha="4" * 40,
                    github_ref="refs/heads/main",
                    workflow_ref=CONTROLLER.TAP_WORKFLOW_REF,
                    selection_plan=event["inputs"]["selection_plan"],
                    selection_plan_sha256=(
                        event["inputs"]["selection_plan_sha256"]
                    ),
                    plan_output=temporary / "plan.json",
                    github_output=output_path,
                )

    def test_admit_rejects_missing_or_extra_dispatch_input(self) -> None:
        for key, value in (
            ("expected_caller_sha", None),
            ("unexpected", "value"),
        ):
            with self.subTest(key=key, value=value):
                event = self.event()
                if value is None:
                    del event["inputs"][key]
                else:
                    event["inputs"][key] = value
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "must contain exactly",
                ):
                    self.admit(event)

    def test_admit_rejects_noncanonical_plan(self) -> None:
        event = self.event()
        event["inputs"]["selection_plan"] = json.dumps(
            self.plan,
            indent=2,
        )
        with self.assertRaisesRegex(
            CONTROLLER.ControllerError,
            "not canonical compact JSON",
        ):
            self.admit(event)

    def test_plan_rejects_incomplete_handoff_inventory(self) -> None:
        plan = json.loads(json.dumps(self.plan))
        del plan["handoffs"]["root"]
        with self.assertRaisesRegex(
            CONTROLLER.ControllerError,
            "roots are absent",
        ):
            CONTROLLER.validate_plan(plan)

    def fake_executor(
        self,
        calls: list[tuple],
        *,
        selected_formulae: tuple[str, ...] = ("dep", "root"),
    ) -> dict:
        def dependency_names(formula: dict, _tap_name: str) -> tuple[str, ...]:
            return tuple(
                item["full_name"].removeprefix(
                    "kandelo-dev/tap-core/"
                )
                for item in formula["dependencies"]
            )

        def dependency_closure(
            _campaign: dict,
            _index: dict,
            name: str,
        ) -> tuple[str, ...]:
            return ("dep",) if name == "root" else ()

        def runtime_selected_formula_order(
            _campaign: dict,
            index: dict,
            roots: list[str],
        ) -> tuple[str, ...]:
            ordered: list[str] = []
            visited: set[str] = set()

            def visit(name: str) -> None:
                if name in visited:
                    return
                for dependency in index[name].get(
                    "runtime_dependencies",
                    index[name]["dependencies"],
                ):
                    visit(
                        dependency["full_name"].removeprefix(
                            "kandelo-dev/tap-core/"
                        )
                    )
                visited.add(name)
                ordered.append(name)

            for root in roots:
                visit(root)
            return tuple(ordered)

        def fetch_release(**arguments) -> None:
            dependencies = tuple(
                pathlib.Path(path).name
                for path in arguments["dependency_roots"]
            )
            calls.append(
                ("fetch", arguments["output"].name, dependencies)
            )
            arguments["output"].mkdir()
            arguments["receipt_output"].write_text("{}\n")

        def prepare_selection(**arguments) -> None:
            calls.append(
                (
                    "prepare",
                    tuple(path.name for path in arguments["handoff_roots"]),
                )
            )
            output = arguments["output"]
            (output / "tap").mkdir(parents=True)
            selection = {
                "arch": "wasm32",
                "campaign": {
                    "kandelo_commit": self.plan["kandelo_commit"],
                    "tag": self.plan["campaign_tag"],
                },
                "formulae": [
                    {
                        "formula": name,
                        "handoff": {"tag": self.plan["handoffs"][name]},
                    }
                    for name in selected_formulae
                ],
                "kind": "kandelo-homebrew-closed-selection-candidate",
                "roots": ["root"],
                "schema": 1,
                "tap": {
                    "prepared_tree_git_oid": "c" * 40,
                    "repository": "kandelo-dev/homebrew-tap-core",
                    "source_commit": self.plan["source_tap_commit"],
                },
            }
            (output / "selection.json").write_bytes(
                CONTROLLER.pretty_json(selection)
            )

        def prepare_selection_release(**arguments) -> None:
            self.write_fake_release(
                arguments["output"],
                json.loads(
                    (
                        arguments["selection_root"] / "selection.json"
                    ).read_text()
                ),
            )

        def load_prepared_selection_release(
            prepared_root: pathlib.Path,
        ) -> tuple[dict, bytes, dict]:
            return self.load_fake_release(prepared_root)

        return {
            "ExecutorError": FakeExecutorError,
            "dependency_closure": dependency_closure,
            "dependency_names": dependency_names,
            "fetch_release": fetch_release,
            "load_prepared_selection_release": (
                load_prepared_selection_release
            ),
            "load_campaign": lambda _path: (
                self.campaign,
                self.campaign_payload,
                self.index,
            ),
            "prepare_selection": prepare_selection,
            "prepare_selection_release": prepare_selection_release,
            "runtime_selected_formula_order": (
                runtime_selected_formula_order
            ),
        }

    def write_fake_release(
        self,
        output: pathlib.Path,
        selection: dict,
    ) -> None:
        assets = output / "assets"
        assets.mkdir(parents=True)
        archive = CONTROLLER.compact_json(
            {
                "prepared_tree_git_oid": selection["tap"][
                    "prepared_tree_git_oid"
                ]
            }
        )
        archive_path = assets / "closed-selection.zip"
        archive_path.write_bytes(archive)
        descriptor = {
            "selection_manifest": {"value": selection},
            "tap_archive": {
                "bytes": len(archive),
                "sha256": hashlib.sha256(archive).hexdigest(),
            },
        }
        descriptor_payload = CONTROLLER.pretty_json(descriptor)
        (assets / "closed-selection.json").write_bytes(
            descriptor_payload
        )
        manifest = {
            "archive_sha256": descriptor["tap_archive"]["sha256"],
            "descriptor_sha256": hashlib.sha256(
                descriptor_payload
            ).hexdigest(),
        }
        (output / "release-manifest.json").write_bytes(
            CONTROLLER.pretty_json(manifest)
        )

    def load_fake_release(
        self,
        prepared_root: pathlib.Path,
    ) -> tuple[dict, bytes, dict]:
        observed = {
            path.relative_to(prepared_root).as_posix()
            for path in prepared_root.rglob("*")
            if path.is_file()
        }
        if observed != set(CONTROLLER.PREPARED_RELEASE_PATHS):
            raise FakeExecutorError("fake release has unexpected files")
        descriptor_payload = (
            prepared_root / "assets/closed-selection.json"
        ).read_bytes()
        descriptor = json.loads(descriptor_payload)
        archive = (
            prepared_root / "assets/closed-selection.zip"
        ).read_bytes()
        archive_record = descriptor["tap_archive"]
        if (
            archive_record["bytes"] != len(archive)
            or archive_record["sha256"]
            != hashlib.sha256(archive).hexdigest()
        ):
            raise FakeExecutorError("fake archive differs")
        manifest = json.loads(
            (prepared_root / "release-manifest.json").read_bytes()
        )
        expected_manifest = {
            "archive_sha256": archive_record["sha256"],
            "descriptor_sha256": hashlib.sha256(
                descriptor_payload
            ).hexdigest(),
        }
        if manifest != expected_manifest:
            raise FakeExecutorError("fake manifest differs")
        return descriptor, descriptor_payload, manifest

    def test_real_executor_exposes_the_required_contract(self) -> None:
        executor = CONTROLLER.load_executor(
            ROOT / "scripts/homebrew-prefix-campaign-executor.py"
        )
        self.assertEqual(
            executor["ExecutorError"].__name__,
            "ExecutorError",
        )

    def test_prepare_fetches_dependencies_before_roots(self) -> None:
        calls: list[tuple] = []
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            plan_path = temporary / "plan.json"
            plan_path.write_bytes(CONTROLLER.pretty_json(self.plan))
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            source_root = temporary / "source"
            source_root.mkdir()
            executor_path = temporary / "executor.py"
            executor_path.touch()
            output = temporary / "prepared"
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor(calls),
            ):
                summary = CONTROLLER.prepare(
                    plan_path=plan_path,
                    campaign_path=campaign_path,
                    source_tap_root=source_root,
                    executor_path=executor_path,
                    output=output,
                )
            self.assertEqual(summary["formula_count"], 2)
            self.assertEqual(
                calls,
                [
                    ("fetch", "dep", ()),
                    ("fetch", "root", ("dep",)),
                    ("prepare", ("dep", "root")),
                ],
            )
            self.assertTrue(
                (output / "assets/closed-selection.json").is_file()
            )

    def test_prepare_verifies_proof_only_handoff_without_selecting_it(
        self,
    ) -> None:
        calls: list[tuple] = []
        self.index["root"]["runtime_dependencies"] = []
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            plan_path = temporary / "plan.json"
            plan_path.write_bytes(CONTROLLER.pretty_json(self.plan))
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            source_root = temporary / "source"
            source_root.mkdir()
            executor_path = temporary / "executor.py"
            executor_path.touch()
            output = temporary / "prepared"
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor(
                    calls,
                    selected_formulae=("root",),
                ),
            ):
                summary = CONTROLLER.prepare(
                    plan_path=plan_path,
                    campaign_path=campaign_path,
                    source_tap_root=source_root,
                    executor_path=executor_path,
                    output=output,
                )
        self.assertEqual(summary["formula_count"], 1)
        self.assertEqual(
            calls,
            [
                ("fetch", "dep", ()),
                ("fetch", "root", ("dep",)),
                ("prepare", ("dep", "root")),
            ],
        )

    def test_prepare_rejects_extra_handoff_before_fetch(self) -> None:
        plan = json.loads(json.dumps(self.plan))
        plan["handoffs"] = {
            "dep": plan["handoffs"]["dep"],
            "extra": "homebrew-prefix-handoff-sha256-" + "c" * 64,
            "root": plan["handoffs"]["root"],
        }
        calls: list[tuple] = []
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            plan_path = temporary / "plan.json"
            plan_path.write_bytes(CONTROLLER.pretty_json(plan))
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            source_root = temporary / "source"
            source_root.mkdir()
            executor_path = temporary / "executor.py"
            executor_path.touch()
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor(calls),
            ):
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "exact dependency closure",
                ):
                    CONTROLLER.prepare(
                        plan_path=plan_path,
                        campaign_path=campaign_path,
                        source_tap_root=source_root,
                        executor_path=executor_path,
                        output=temporary / "prepared",
                    )
        self.assertEqual(calls, [])

    def test_verify_rejects_handoff_substitution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            plan_path = temporary / "plan.json"
            plan_path.write_bytes(CONTROLLER.pretty_json(self.plan))
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            prepared = temporary / "prepared"
            prepared.mkdir()
            value = {
                "arch": "wasm32",
                "campaign": {
                    "kandelo_commit": self.plan["kandelo_commit"],
                    "tag": self.plan["campaign_tag"],
                },
                "formulae": [
                    {
                        "formula": "dep",
                        "handoff": {
                            "tag": "homebrew-prefix-handoff-sha256-"
                            + "f" * 64
                        },
                    },
                    {
                        "formula": "root",
                        "handoff": {
                            "tag": self.plan["handoffs"]["root"]
                        },
                    },
                ],
                "kind": "kandelo-homebrew-closed-selection-candidate",
                "roots": ["root"],
                "schema": 1,
                "tap": {
                    "repository": "kandelo-dev/homebrew-tap-core",
                    "source_commit": self.plan["source_tap_commit"],
                },
            }
            value["tap"]["prepared_tree_git_oid"] = "c" * 40
            self.write_fake_release(prepared, value)
            plan_input = CONTROLLER.compact_json(self.plan).decode().rstrip(
                "\n"
            )
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor([]),
            ):
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "handoffs differ",
                ):
                    CONTROLLER.verify(
                        selection_plan=plan_input,
                        selection_plan_sha256=CONTROLLER.plan_digest(
                            self.plan
                        ),
                        prepared_release=prepared,
                        campaign_path=campaign_path,
                        executor_path=temporary / "executor.py",
                    )
            value["formulae"][0]["handoff"]["tag"] = (
                self.plan["handoffs"]["dep"]
            )
            value["tap"]["repository"] = None
            for child in sorted(prepared.rglob("*"), reverse=True):
                if child.is_file():
                    child.unlink()
                else:
                    child.rmdir()
            prepared.rmdir()
            self.write_fake_release(prepared, value)
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor([]),
            ):
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "authority differs",
                ):
                    CONTROLLER.verify(
                        selection_plan=plan_input,
                        selection_plan_sha256=CONTROLLER.plan_digest(
                            self.plan
                        ),
                        prepared_release=prepared,
                        campaign_path=campaign_path,
                        executor_path=temporary / "executor.py",
                    )

    def test_verify_rejects_omitted_runtime_dependency(self) -> None:
        selection = {
            "arch": "wasm32",
            "campaign": {
                "kandelo_commit": self.plan["kandelo_commit"],
                "tag": self.plan["campaign_tag"],
            },
            "formulae": [
                {
                    "formula": "root",
                    "handoff": {
                        "tag": self.plan["handoffs"]["root"],
                    },
                }
            ],
            "kind": "kandelo-homebrew-closed-selection-candidate",
            "roots": ["root"],
            "schema": 1,
            "tap": {
                "repository": "kandelo-dev/homebrew-tap-core",
                "source_commit": self.plan["source_tap_commit"],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            prepared = temporary / "prepared"
            prepared.mkdir()
            selection["tap"]["prepared_tree_git_oid"] = "c" * 40
            self.write_fake_release(prepared, selection)
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor([]),
            ), self.assertRaisesRegex(
                CONTROLLER.ControllerError,
                "handoffs differ",
            ):
                CONTROLLER.verify(
                    selection_plan=(
                        CONTROLLER.compact_json(self.plan)
                        .decode()
                        .rstrip("\n")
                    ),
                    selection_plan_sha256=CONTROLLER.plan_digest(
                        self.plan
                    ),
                    prepared_release=prepared,
                    campaign_path=campaign_path,
                    executor_path=temporary / "executor.py",
                )

    def test_verify_rejects_coherent_artifact_plan_substitution(self) -> None:
        substituted = json.loads(json.dumps(self.plan))
        substituted["roots"] = ["dep"]
        substituted["handoffs"] = {
            "dep": substituted["handoffs"]["dep"],
        }
        selection = {
            "arch": "wasm32",
            "campaign": {
                "kandelo_commit": substituted["kandelo_commit"],
                "tag": substituted["campaign_tag"],
            },
            "formulae": [
                {
                    "formula": "dep",
                    "handoff": {
                        "tag": substituted["handoffs"]["dep"],
                    },
                }
            ],
            "kind": "kandelo-homebrew-closed-selection-candidate",
            "roots": ["dep"],
            "schema": 1,
            "tap": {
                "repository": "kandelo-dev/homebrew-tap-core",
                "source_commit": substituted["source_tap_commit"],
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            prepared = temporary / "prepared"
            prepared.mkdir()
            selection["tap"]["prepared_tree_git_oid"] = "c" * 40
            self.write_fake_release(prepared, selection)
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=self.fake_executor([]),
            ):
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "authority differs from its plan",
                ):
                    CONTROLLER.verify(
                        selection_plan=(
                            CONTROLLER.compact_json(self.plan)
                            .decode()
                            .rstrip("\n")
                        ),
                        selection_plan_sha256=CONTROLLER.plan_digest(
                            self.plan
                        ),
                        prepared_release=prepared,
                        campaign_path=campaign_path,
                        executor_path=temporary / "executor.py",
                    )

    def test_reconstruct_rejects_coherent_archive_substitution(self) -> None:
        calls: list[tuple] = []
        plan_input = CONTROLLER.compact_json(self.plan).decode().rstrip(
            "\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            temporary = pathlib.Path(directory)
            plan_path = temporary / "plan.json"
            plan_path.write_bytes(CONTROLLER.pretty_json(self.plan))
            campaign_path = temporary / "campaign.json"
            campaign_path.write_bytes(self.campaign_payload)
            source_root = temporary / "source"
            source_root.mkdir()
            executor_path = temporary / "executor.py"
            executor_path.touch()
            prepared = temporary / "prepared"
            executor = self.fake_executor(calls)
            with mock.patch.object(
                CONTROLLER,
                "load_executor",
                return_value=executor,
            ):
                CONTROLLER.prepare(
                    plan_path=plan_path,
                    campaign_path=campaign_path,
                    source_tap_root=source_root,
                    executor_path=executor_path,
                    output=prepared,
                )
                summary = CONTROLLER.reconstruct_and_verify(
                    selection_plan=plan_input,
                    selection_plan_sha256=CONTROLLER.plan_digest(
                        self.plan
                    ),
                    prepared_release=prepared,
                    campaign_path=campaign_path,
                    source_tap_root=source_root,
                    executor_path=executor_path,
                )
                self.assertEqual(summary["formula_count"], 2)
                descriptor, _payload, _manifest = (
                    self.load_fake_release(prepared)
                )
                substituted = descriptor["selection_manifest"]["value"]
                substituted["tap"]["prepared_tree_git_oid"] = "d" * 40
                for child in sorted(prepared.rglob("*"), reverse=True):
                    if child.is_file():
                        child.unlink()
                    else:
                        child.rmdir()
                prepared.rmdir()
                self.write_fake_release(prepared, substituted)

                # The old semantic check admits this internally coherent
                # artifact because its Formula names and claimed handoff tags
                # are unchanged. Independent reconstruction must reject its
                # substituted archive, descriptor, and manifest bytes.
                CONTROLLER.verify(
                    selection_plan=plan_input,
                    selection_plan_sha256=CONTROLLER.plan_digest(
                        self.plan
                    ),
                    prepared_release=prepared,
                    campaign_path=campaign_path,
                    executor_path=executor_path,
                )
                with self.assertRaisesRegex(
                    CONTROLLER.ControllerError,
                    "differs from its independent reconstruction",
                ):
                    CONTROLLER.reconstruct_and_verify(
                        selection_plan=plan_input,
                        selection_plan_sha256=CONTROLLER.plan_digest(
                            self.plan
                        ),
                        prepared_release=prepared,
                        campaign_path=campaign_path,
                        source_tap_root=source_root,
                        executor_path=executor_path,
                    )


if __name__ == "__main__":
    unittest.main()
