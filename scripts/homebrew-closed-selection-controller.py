#!/usr/bin/env python3
"""Admit and assemble one immutable closed-selection publish plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import runpy
import shutil
import stat
import sys
import tempfile
from typing import Any, NoReturn


sys.dont_write_bytecode = True

TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_WORKFLOW_REF = (
    f"{TAP_REPOSITORY}/.github/workflows/"
    "publish-closed-selection.yml@refs/heads/main"
)
PLAN_KIND = "kandelo-homebrew-closed-selection-publish-plan"
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9+_.-]{0,127}$")
CAMPAIGN_TAG = re.compile(
    r"^homebrew-prefix-campaign-sha256-([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
MAX_PLAN_BYTES = 64 * 1024
MAX_EVENT_BYTES = 256 * 1024
MAX_SELECTION_BYTES = 256 * 1024
MAX_FORMULAE = 128


class ControllerError(RuntimeError):
    """A fail-closed selection-controller error."""


def fail(message: str) -> NoReturn:
    raise ControllerError(message)


def reject_duplicate_keys(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def compact_json(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def exact_keys(
    value: Any,
    expected: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def regular_file(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        fail(f"{label} must be a regular non-symlink file")
    return path


def load_json_bytes(
    payload: bytes,
    label: str,
    maximum: int = MAX_PLAN_BYTES,
) -> Any:
    if len(payload) > maximum:
        fail(f"{label} exceeds the size ceiling")
    try:
        return json.loads(
            payload,
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid JSON: {error}")


def load_json_file(
    path: pathlib.Path,
    label: str,
    maximum: int = MAX_PLAN_BYTES,
) -> tuple[Any, bytes]:
    path = regular_file(path, label)
    try:
        # WHY: dispatch and artifact files are untrusted. Bound the read
        # itself so a false JSON file cannot consume runner memory before its
        # declared contract is checked.
        with path.open("rb") as stream:
            payload = stream.read(maximum + 1)
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    return load_json_bytes(payload, label, maximum), payload


def require_commit(value: Any, label: str) -> str:
    if not isinstance(value, str) or COMMIT.fullmatch(value) is None:
        fail(f"{label} must be a lowercase 40-character SHA")
    return value


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        fail(f"{label} must be a lowercase SHA-256")
    return value


def validate_plan(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "campaign_tag",
            "handoffs",
            "kandelo_commit",
            "kind",
            "roots",
            "schema",
            "source_tap_commit",
        },
        "selection publish plan",
    )
    if value["schema"] != 1 or value["kind"] != PLAN_KIND:
        fail("selection publish plan has an unsupported contract")
    if (
        not isinstance(value["campaign_tag"], str)
        or CAMPAIGN_TAG.fullmatch(value["campaign_tag"]) is None
    ):
        fail("selection publish plan has an invalid campaign tag")
    require_commit(value["kandelo_commit"], "plan Kandelo commit")
    require_commit(value["source_tap_commit"], "plan source tap commit")

    roots = value["roots"]
    if (
        not isinstance(roots, list)
        or not roots
        or len(roots) > MAX_FORMULAE
        or any(
            not isinstance(name, str) or FORMULA.fullmatch(name) is None
            for name in roots
        )
        or roots != sorted(set(roots))
    ):
        fail("selection publish roots must be unique and sorted")

    handoffs = value["handoffs"]
    if (
        not isinstance(handoffs, dict)
        or not handoffs
        or len(handoffs) > MAX_FORMULAE
    ):
        fail("selection publish handoffs are invalid")
    prior = ""
    for name, tag in handoffs.items():
        if (
            not isinstance(name, str)
            or FORMULA.fullmatch(name) is None
            or name <= prior
            or not isinstance(tag, str)
            or HANDOFF_TAG.fullmatch(tag) is None
        ):
            fail("selection publish handoffs must be sorted exact tags")
        prior = name
    if not set(roots).issubset(handoffs):
        fail("selection publish roots are absent from its handoffs")
    return value


def plan_digest(plan: dict[str, Any]) -> str:
    return hashlib.sha256(compact_json(plan)).hexdigest()


def write_new(path: pathlib.Path, payload: bytes, label: str) -> None:
    if path.exists() or path.is_symlink():
        fail(f"{label} already exists")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        fail(f"cannot write {label}: {error}")


def append_github_output(path: pathlib.Path, values: dict[str, str]) -> None:
    # WHY: one-line validated identities cannot inject another assignment into
    # GitHub's environment-file protocol.
    if any(
        "\n" in name
        or "\r" in name
        or "\n" in value
        or "\r" in value
        for name, value in values.items()
    ):
        fail("GitHub output contains a line break")
    try:
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            for name, value in values.items():
                stream.write(f"{name}={value}\n")
    except OSError as error:
        fail(f"cannot write GitHub output: {error}")


def admit(
    *,
    event_path: pathlib.Path,
    caller_sha: str,
    expected_caller_sha: str,
    github_ref: str,
    workflow_ref: str,
    selection_plan: str,
    selection_plan_sha256: str,
    plan_output: pathlib.Path,
    github_output: pathlib.Path,
) -> dict[str, str]:
    caller_sha = require_commit(caller_sha, "caller SHA")
    expected_caller_sha = require_commit(
        expected_caller_sha,
        "expected caller SHA",
    )
    # WHY: workflow_dispatch resolves a branch name when GitHub accepts the
    # request. The operator's last read of protected main can otherwise race
    # with that resolution and silently run a newer workflow commit.
    if caller_sha != expected_caller_sha:
        fail("workflow caller SHA differs from the expected caller SHA")
    if github_ref != "refs/heads/main" or workflow_ref != TAP_WORKFLOW_REF:
        fail("selection publication must run from the protected tap caller")
    event, _payload = load_json_file(
        event_path,
        "workflow-dispatch event",
        MAX_EVENT_BYTES,
    )
    if not isinstance(event, dict):
        fail("workflow-dispatch event must be an object")
    repository = event.get("repository")
    if (
        not isinstance(repository, dict)
        or str(repository.get("full_name", "")).lower() != TAP_REPOSITORY
        or repository.get("default_branch") != "main"
    ):
        fail("workflow-dispatch repository is not the protected tap")
    inputs = exact_keys(
        event.get("inputs"),
        {
            "expected_caller_sha",
            "selection_plan",
            "selection_plan_sha256",
        },
        "workflow-dispatch inputs",
    )
    # WHY: reusable-workflow inputs and the original dispatch event travel
    # through different GitHub contexts. Requiring both copies to agree makes
    # a future caller edit unable to substitute the expected commit or plan.
    if (
        inputs["expected_caller_sha"] != expected_caller_sha
        or inputs["selection_plan"] != selection_plan
        or inputs["selection_plan_sha256"] != selection_plan_sha256
    ):
        fail("reusable workflow inputs differ from the dispatch event")
    raw_plan = inputs["selection_plan"]
    expected_digest = require_sha256(
        inputs["selection_plan_sha256"],
        "selection plan digest",
    )
    if not isinstance(raw_plan, str):
        fail("selection plan input must be a string")
    plan = validate_plan(
        load_json_bytes(raw_plan.encode("utf-8"), "selection plan input")
    )
    canonical = compact_json(plan)
    # WHY: the digest binds the exact plan, while canonical encoding makes a
    # duplicate key, whitespace substitution, or truncated UI paste visible.
    if raw_plan != canonical.decode("utf-8").removesuffix("\n"):
        fail("selection plan input is not canonical compact JSON")
    observed_digest = hashlib.sha256(canonical).hexdigest()
    if observed_digest != expected_digest:
        fail("selection plan input differs from its SHA-256")
    write_new(plan_output, pretty_json(plan), "admitted selection plan")
    outputs = {
        "caller-sha": caller_sha,
        "campaign-tag": plan["campaign_tag"],
        "campaign-kandelo-commit": plan["kandelo_commit"],
        "plan-sha256": observed_digest,
        "source-tap-commit": plan["source_tap_commit"],
    }
    append_github_output(github_output, outputs)
    return outputs


def load_executor(path: pathlib.Path) -> dict[str, Any]:
    path = regular_file(path, "Kandelo selection executor").resolve()
    try:
        executor = runpy.run_path(str(path))
    except Exception as error:  # pragma: no cover - external import detail.
        fail(f"cannot load the Kandelo selection executor: {error}")
    for name in (
        "ExecutorError",
        "dependency_closure",
        "dependency_names",
        "fetch_release",
        "load_prepared_selection_release",
        "load_campaign",
        "prepare_selection",
        "prepare_selection_release",
    ):
        if name not in executor:
            fail(f"Kandelo selection executor lacks {name}")
    return executor


def topological_formulae(
    executor: dict[str, Any],
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    required: set[str],
) -> tuple[str, ...]:
    ordered: list[str] = []
    visited: set[str] = set()
    visiting: set[str] = set()
    tap_name = campaign["authority"]["tap_name"]

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"campaign dependency graph cycles at {name}")
        if name in visited:
            return
        if name not in index or name not in required:
            fail(f"selection dependency {name} is outside its exact closure")
        visiting.add(name)
        for dependency in executor["dependency_names"](
            index[name],
            tap_name,
        ):
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        ordered.append(name)

    for name in sorted(required):
        visit(name)
    return tuple(ordered)


def prepare(
    *,
    plan_path: pathlib.Path,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    executor_path: pathlib.Path,
    output: pathlib.Path,
) -> dict[str, Any]:
    plan, plan_payload = load_json_file(
        plan_path,
        "admitted selection plan",
    )
    plan = validate_plan(plan)
    if plan_payload != pretty_json(plan):
        fail("admitted selection plan is not canonical pretty JSON")
    if output.exists() or output.is_symlink():
        fail("selection preparation output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)

    executor = load_executor(executor_path)
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        campaign, campaign_payload, index = executor["load_campaign"](
            regular_file(campaign_path, "campaign manifest")
        )
        authority = campaign["authority"]
        match = CAMPAIGN_TAG.fullmatch(plan["campaign_tag"])
        assert match is not None
        if (
            hashlib.sha256(campaign_payload).hexdigest() != match.group(1)
            or authority["kandelo_commit"] != plan["kandelo_commit"]
            or authority["source_tap_commit"]
            != plan["source_tap_commit"]
            or authority["tap_repository"].lower() != TAP_REPOSITORY
        ):
            fail("campaign authority differs from the selection plan")

        required = set(plan["roots"])
        for root in plan["roots"]:
            if root not in index:
                fail(f"selection root {root} is absent from the campaign")
            required.update(
                executor["dependency_closure"](campaign, index, root)
            )
        if set(plan["handoffs"]) != required:
            missing = sorted(required - set(plan["handoffs"]))
            extra = sorted(set(plan["handoffs"]) - required)
            fail(
                "selection handoffs differ from the exact dependency "
                f"closure (missing={missing}, extra={extra})"
            )

        ordered = topological_formulae(
            executor,
            campaign,
            index,
            required,
        )
        handoff_root = temporary / "handoffs"
        receipt_root = temporary / "receipts"
        handoff_root.mkdir()
        receipt_root.mkdir()
        for formula in ordered:
            dependencies = executor["dependency_closure"](
                campaign,
                index,
                formula,
            )
            executor["fetch_release"](
                campaign_path=campaign_path,
                tag=plan["handoffs"][formula],
                output=handoff_root / formula,
                receipt_output=receipt_root / f"{formula}.json",
                dependency_roots=[
                    handoff_root / dependency
                    for dependency in dependencies
                ],
            )
        executor["prepare_selection"](
            campaign_path=campaign_path,
            source_tap_root=source_tap_root,
            roots=plan["roots"],
            arch="wasm32",
            handoff_roots=[handoff_root / name for name in ordered],
            output=temporary / "selection",
        )
        executor["prepare_selection_release"](
            selection_root=temporary / "selection",
            output=temporary / "release",
        )
        os.rename(temporary / "release", output)
    except ControllerError:
        raise
    except executor["ExecutorError"] as error:
        fail(str(error))
    finally:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
    return verify(
        selection_plan=compact_json(plan).decode("utf-8").removesuffix("\n"),
        selection_plan_sha256=plan_digest(plan),
        prepared_release=output,
        executor_path=executor_path,
    )


def expected_plan(
    selection_plan: str,
    selection_plan_sha256: str,
) -> dict[str, Any]:
    digest = require_sha256(
        selection_plan_sha256,
        "expected selection plan digest",
    )
    if not isinstance(selection_plan, str):
        fail("expected selection plan must be a string")
    plan = validate_plan(
        load_json_bytes(
            selection_plan.encode("utf-8"),
            "expected selection plan",
        )
    )
    canonical = compact_json(plan)
    if selection_plan != canonical.decode("utf-8").removesuffix("\n"):
        fail("expected selection plan is not canonical compact JSON")
    if hashlib.sha256(canonical).hexdigest() != digest:
        fail("expected selection plan differs from its SHA-256")
    return plan


def verify(
    *,
    selection_plan: str,
    selection_plan_sha256: str,
    prepared_release: pathlib.Path,
    executor_path: pathlib.Path,
) -> dict[str, Any]:
    plan = expected_plan(selection_plan, selection_plan_sha256)
    executor = load_executor(executor_path)
    try:
        descriptor, _descriptor_payload, _manifest = executor[
            "load_prepared_selection_release"
        ](prepared_release)
    except executor["ExecutorError"] as error:
        fail(str(error))
    selection = descriptor["selection_manifest"]["value"]
    selection_payload = pretty_json(selection)
    selection_tap = selection.get("tap") if isinstance(selection, dict) else None
    selection_tap_repository = (
        selection_tap.get("repository")
        if isinstance(selection_tap, dict)
        else None
    )
    if (
        not isinstance(selection, dict)
        or selection.get("kind")
        != "kandelo-homebrew-closed-selection-candidate"
        or selection.get("schema") != 1
        or selection.get("arch") != "wasm32"
        or selection.get("roots") != plan["roots"]
        or not isinstance(selection.get("campaign"), dict)
        or selection["campaign"].get("tag") != plan["campaign_tag"]
        or selection["campaign"].get("kandelo_commit")
        != plan["kandelo_commit"]
        or not isinstance(selection_tap_repository, str)
        or selection_tap_repository.lower() != TAP_REPOSITORY
        or selection_tap.get("source_commit")
        != plan["source_tap_commit"]
        or not isinstance(selection.get("formulae"), list)
        or not selection["formulae"]
        or len(selection["formulae"]) > MAX_FORMULAE
    ):
        fail("prepared selection authority differs from its plan")
    observed_handoffs: dict[str, str] = {}
    for record in selection["formulae"]:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("formula"), str)
            or not isinstance(record.get("handoff"), dict)
            or not isinstance(record["handoff"].get("tag"), str)
            or record["formula"] in observed_handoffs
        ):
            fail("prepared selection has an invalid Formula handoff")
        observed_handoffs[record["formula"]] = record["handoff"]["tag"]
    if observed_handoffs != plan["handoffs"]:
        fail("prepared selection handoffs differ from its plan")
    return {
        "formula_count": len(observed_handoffs),
        "plan_sha256": plan_digest(plan),
        "selection_sha256": hashlib.sha256(selection_payload).hexdigest(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    admit_parser = commands.add_parser("admit")
    admit_parser.add_argument("--event", type=pathlib.Path, required=True)
    admit_parser.add_argument("--caller-sha", required=True)
    admit_parser.add_argument("--expected-caller-sha", required=True)
    admit_parser.add_argument("--github-ref", required=True)
    admit_parser.add_argument("--workflow-ref", required=True)
    admit_parser.add_argument("--selection-plan", required=True)
    admit_parser.add_argument("--selection-plan-sha256", required=True)
    admit_parser.add_argument("--plan-out", type=pathlib.Path, required=True)
    admit_parser.add_argument(
        "--github-output", type=pathlib.Path, required=True
    )

    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--plan", type=pathlib.Path, required=True)
    prepare_parser.add_argument(
        "--campaign", type=pathlib.Path, required=True
    )
    prepare_parser.add_argument(
        "--source-tap-root", type=pathlib.Path, required=True
    )
    prepare_parser.add_argument(
        "--executor", type=pathlib.Path, required=True
    )
    prepare_parser.add_argument("--out", type=pathlib.Path, required=True)

    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--selection-plan", required=True)
    verify_parser.add_argument("--selection-plan-sha256", required=True)
    verify_parser.add_argument(
        "--prepared-release", type=pathlib.Path, required=True
    )
    verify_parser.add_argument(
        "--executor", type=pathlib.Path, required=True
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "admit":
            admit(
                event_path=arguments.event,
                caller_sha=arguments.caller_sha,
                expected_caller_sha=arguments.expected_caller_sha,
                github_ref=arguments.github_ref,
                workflow_ref=arguments.workflow_ref,
                selection_plan=arguments.selection_plan,
                selection_plan_sha256=arguments.selection_plan_sha256,
                plan_output=arguments.plan_out,
                github_output=arguments.github_output,
            )
            print("homebrew-closed-selection-controller: admitted exact plan")
        elif arguments.command == "prepare":
            summary = prepare(
                plan_path=arguments.plan,
                campaign_path=arguments.campaign,
                source_tap_root=arguments.source_tap_root,
                executor_path=arguments.executor,
                output=arguments.out,
            )
            print(
                "homebrew-closed-selection-controller: prepared "
                f"{summary['formula_count']} Formulae"
            )
        elif arguments.command == "verify":
            verify(
                selection_plan=arguments.selection_plan,
                selection_plan_sha256=arguments.selection_plan_sha256,
                prepared_release=arguments.prepared_release,
                executor_path=arguments.executor,
            )
            print("homebrew-closed-selection-controller: verified exact plan")
        else:  # pragma: no cover - argparse owns command selection.
            raise AssertionError(arguments.command)
        return 0
    except ControllerError as error:
        print(
            f"homebrew-closed-selection-controller: {error}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
