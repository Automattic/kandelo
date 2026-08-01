#!/usr/bin/env python3
"""Seal and admit a noncanonical Homebrew campaign for an unmerged PR.

Candidate code may derive the campaign only in a credential-free job.  Code
from the pull request never publishes it.  Protected-main code validates the
result, seals an immutable release, and later admits it only when one exact
merge commit preserves the candidate tree unchanged.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
EXECUTOR_PATH = ROOT / "scripts/homebrew-prefix-campaign-executor.py"
CAMPAIGN_PATH = ROOT / "scripts/homebrew-prefix-campaign.py"

COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
CANDIDATE_TAG = re.compile(
    r"^homebrew-prefix-campaign-candidate-pr-([1-9][0-9]*)-run-"
    r"([1-9][0-9]*)-attempt-([1-9][0-9]*)-sha256-([0-9a-f]{64})$"
)
ARTIFACT_DIGEST = re.compile(r"^sha256:([0-9a-f]{64})$")

MAX_JSON_BYTES = 64 * 1024 * 1024


class CandidateCampaignError(ValueError):
    """Candidate campaign evidence did not satisfy its closed contract."""


def fail(message: str) -> NoReturn:
    raise CandidateCampaignError(message)


def load_tool(name: str, path: pathlib.Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        fail(f"cannot load reviewed tool {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


EXECUTOR = load_tool("homebrew_candidate_campaign_executor", EXECUTOR_PATH)


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(
    value: Any,
    label: str,
    pattern: re.Pattern[str] | None = None,
    maximum: int = 4096,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value.encode()) > maximum
        or "\0" in value
        or "\n" in value
        or "\r" in value
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        fail(f"{label} is invalid")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} is invalid")
    return value


def normalized_repository(value: Any, label: str) -> str:
    return require_string(value, label, REPOSITORY).lower()


def regular_file(
    path: pathlib.Path, label: str, maximum: int = MAX_JSON_BYTES
) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"cannot inspect {label}: {error}")
    if not path.is_file() or path.is_symlink():
        fail(f"{label} must be a regular non-symlink file")
    if metadata.st_size < 1 or metadata.st_size > maximum:
        fail(f"{label} is outside its byte bound")
    return path


def load_json(
    path: pathlib.Path, label: str, *, canonical: bool = True
) -> tuple[Any, bytes]:
    payload = regular_file(path, label).read_bytes()
    try:
        value = json.loads(
            payload.decode(),
            object_pairs_hook=reject_duplicates,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if canonical and payload != pretty_json(value):
        fail(f"{label} is not canonical pretty JSON")
    return value, payload


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        path.lstat()
    except OSError as error:
        fail(f"cannot inspect {label}: {error}")
    if not path.is_dir() or path.is_symlink():
        fail(f"{label} must be one real directory")
    return path.resolve()


def run_git(root: pathlib.Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        fail(
            f"git {' '.join(arguments)} failed: "
            f"{result.stderr.strip()[:4096]}"
        )
    return result.stdout.strip()


def exact_git_checkout(
    root: pathlib.Path, expected: str, label: str
) -> pathlib.Path:
    root = real_directory(root, label)
    require_string(expected, f"{label} commit", COMMIT)
    if pathlib.Path(run_git(root, "rev-parse", "--show-toplevel")) != root:
        fail(f"{label} is not its Git worktree root")
    if run_git(root, "rev-parse", "HEAD") != expected:
        fail(f"{label} is not at its expected commit")
    if run_git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        fail(f"{label} is not clean")
    return root


def require_ancestor(
    root: pathlib.Path, ancestor: str, descendant: str, label: str
) -> None:
    result = subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", ancestor,
         descendant],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if result.returncode != 0:
        fail(f"{label} is not on protected main history")


def source_file(root: pathlib.Path, relative: str, label: str) -> pathlib.Path:
    current = root
    parts = pathlib.PurePosixPath(relative).parts
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink() or not current.is_dir():
            fail(f"{label} parent must be a real directory")
    path = regular_file(current / parts[-1], label)
    if path.resolve().parent != current.resolve():
        fail(f"{label} escaped its source root")
    return path


def validate_source(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "abi",
            "abi_snapshot",
            "base_commit",
            "guest_layout",
            "kandelo_repository",
            "kind",
            "native_homebrew_commit",
            "old_metadata",
            "pr_number",
            "producer_commit",
            "producer_tree",
            "schema",
            "source_tap_commit",
            "source_tap_tree",
            "tap_name",
            "tap_repository",
            "tap_workflow_authority_commit",
            "workflow_authority_commit",
        },
        "candidate campaign source",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-prefix-campaign-candidate-source"
    ):
        fail("candidate campaign source has an unsupported contract")
    if normalized_repository(
        value["kandelo_repository"], "Kandelo repository"
    ) != "automattic/kandelo":
        fail("candidate campaign names another Kandelo repository")
    if normalized_repository(
        value["tap_repository"], "tap repository"
    ) != "kandelo-dev/homebrew-tap-core":
        fail("candidate campaign v1 names another tap repository")
    if normalized_repository(
        value["tap_name"], "tap name"
    ) != "kandelo-dev/tap-core":
        fail("candidate campaign v1 names another tap")
    require_int(value["pr_number"], "candidate campaign PR", 1)
    require_int(value["abi"], "candidate campaign ABI", 1)
    for field in (
        "base_commit",
        "producer_commit",
        "producer_tree",
        "source_tap_commit",
        "source_tap_tree",
        "tap_workflow_authority_commit",
        "workflow_authority_commit",
        "native_homebrew_commit",
    ):
        require_string(value[field], field.replace("_", " "), COMMIT)
    for field, expected_path in (
        ("abi_snapshot", "abi/snapshot.json"),
        ("guest_layout", "homebrew/kandelo-guest-layout.json"),
        ("old_metadata", "Kandelo/metadata.json"),
    ):
        record = exact_keys(
            value[field], {"path", "sha256"}, field.replace("_", " ")
        )
        if record["path"] != expected_path:
            fail(f"candidate campaign {field} path is not canonical")
        require_string(record["sha256"], f"{field} SHA-256", SHA256)
    if value["workflow_authority_commit"] != value["base_commit"]:
        fail("candidate campaign v1 validator authority must be its base")
    return value


def describe_source(arguments: argparse.Namespace) -> None:
    producer = exact_git_checkout(
        pathlib.Path(arguments.kandelo_root),
        arguments.producer_commit,
        "candidate Kandelo source",
    )
    tap = exact_git_checkout(
        pathlib.Path(arguments.tap_root),
        arguments.source_tap_commit,
        "candidate tap source",
    )
    snapshot_path = source_file(producer, "abi/snapshot.json", "ABI snapshot")
    snapshot, snapshot_payload = load_json(snapshot_path, "ABI snapshot")
    if not isinstance(snapshot, dict):
        fail("ABI snapshot must be an object")
    abi = require_int(snapshot.get("abi_version"), "ABI snapshot version", 1)
    layout_path = source_file(
        producer,
        "homebrew/kandelo-guest-layout.json",
        "guest layout",
    )
    _layout, layout_payload = load_json(layout_path, "guest layout")
    roots_path = source_file(
        producer,
        "homebrew/homebrew-native-compatibility-roots.json",
        "native Homebrew roots",
    )
    roots, _roots_payload = load_json(roots_path, "native Homebrew roots")
    if not isinstance(roots, dict):
        fail("native Homebrew roots must be an object")
    native_commit = require_string(
        roots.get("homebrew_commit"), "native Homebrew commit", COMMIT
    )
    metadata_path = source_file(
        tap, "Kandelo/metadata.json", "old tap metadata"
    )
    _metadata, metadata_payload = load_json(
        metadata_path, "old tap metadata"
    )
    source = validate_source(
        {
            "schema": 1,
            "kind": "kandelo-homebrew-prefix-campaign-candidate-source",
            "kandelo_repository": arguments.kandelo_repository,
            "pr_number": arguments.pr_number,
            "base_commit": arguments.base_commit,
            "producer_commit": arguments.producer_commit,
            "producer_tree": run_git(producer, "rev-parse", "HEAD^{tree}"),
            "workflow_authority_commit": arguments.workflow_authority_commit,
            "abi": abi,
            "abi_snapshot": {
                "path": "abi/snapshot.json",
                "sha256": sha256_bytes(snapshot_payload),
            },
            "guest_layout": {
                "path": "homebrew/kandelo-guest-layout.json",
                "sha256": sha256_bytes(layout_payload),
            },
            "tap_repository": arguments.tap_repository,
            "tap_name": arguments.tap_name,
            "source_tap_commit": arguments.source_tap_commit,
            "source_tap_tree": run_git(tap, "rev-parse", "HEAD^{tree}"),
            "tap_workflow_authority_commit": (
                arguments.tap_workflow_authority_commit
            ),
            "old_metadata": {
                "path": "Kandelo/metadata.json",
                "sha256": sha256_bytes(metadata_payload),
            },
            "native_homebrew_commit": native_commit,
        }
    )
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate campaign source output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pretty_json(source))


def validate_run(value: Any, source: dict[str, Any]) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "artifacts",
            "caller_commit",
            "conclusion",
            "event",
            "repository",
            "run_attempt",
            "run_id",
            "schema",
            "status",
            "workflow_path",
        },
        "candidate campaign run",
    )
    if value["schema"] != 1:
        fail("candidate campaign run has an unsupported contract")
    if normalized_repository(
        value["repository"], "candidate campaign run repository"
    ) != normalized_repository(source["tap_repository"], "tap repository"):
        fail("candidate campaign run belongs to another repository")
    if (
        value["workflow_path"] != ".github/workflows/candidate-campaign.yml"
        or value["event"] != "repository_dispatch"
        or value["caller_commit"]
        != source["tap_workflow_authority_commit"]
    ):
        fail("candidate campaign run did not use its reviewed caller")
    run_id = require_int(value["run_id"], "candidate campaign run ID", 1)
    attempt = require_int(
        value["run_attempt"], "candidate campaign run attempt", 1
    )
    if value["status"] not in ("in_progress", "completed"):
        fail("candidate campaign run status is invalid")
    if value["conclusion"] not in (None, "success"):
        fail("candidate campaign run did not succeed")
    if value["status"] == "completed" and value["conclusion"] != "success":
        fail("completed candidate campaign run is not successful")
    artifacts = value["artifacts"]
    if not isinstance(artifacts, list) or len(artifacts) != 1:
        fail("candidate campaign run must bind exactly one artifact")
    artifact = exact_keys(
        artifacts[0],
        {"bytes", "digest", "id", "name", "run_attempt", "run_id"},
        "candidate campaign artifact",
    )
    expected_name = (
        f"homebrew-candidate-campaign-derivation-attempt-{attempt}"
    )
    if artifact["name"] != expected_name:
        fail("candidate campaign run names another artifact")
    require_int(artifact["id"], "candidate campaign artifact ID", 1)
    require_int(artifact["bytes"], "candidate campaign artifact bytes", 1)
    require_string(
        artifact["digest"], "candidate campaign artifact digest",
        ARTIFACT_DIGEST,
    )
    if artifact["run_id"] != run_id or artifact["run_attempt"] != attempt:
        fail("candidate campaign artifact belongs to another run")
    return value


def validate_campaign_authority(
    campaign: dict[str, Any], source: dict[str, Any]
) -> None:
    authority = campaign["authority"]
    if (
        authority.get("kandelo_commit") != source["producer_commit"]
        or authority.get("current_kandelo_abi") != source["abi"]
        or authority.get("old_tap_commit") != source["source_tap_commit"]
        or authority.get("source_tap_commit")
        != source["source_tap_commit"]
        or str(authority.get("tap_repository", "")).lower()
        != source["tap_repository"].lower()
        or str(authority.get("tap_name", "")).lower()
        != source["tap_name"].lower()
        or authority.get("native_homebrew_commit")
        != source["native_homebrew_commit"]
        or authority.get("abi_snapshot") != source["abi_snapshot"]
        or authority.get("guest_layout") != source["guest_layout"]
        or authority.get("old_metadata") != source["old_metadata"]
    ):
        fail("candidate campaign authority differs from its exact sources")


def candidate_tag(
    manifest_payload: bytes, source: dict[str, Any], run: dict[str, Any]
) -> str:
    return (
        "homebrew-prefix-campaign-candidate-pr-"
        f"{source['pr_number']}-run-{run['run_id']}-attempt-"
        f"{run['run_attempt']}-sha256-{sha256_bytes(manifest_payload)}"
    )


def validate_manifest(
    value: Any,
    payload: bytes,
    campaign_payload: bytes,
    expected_tag: str | None = None,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {"campaign", "kind", "run", "schema", "source"},
        "candidate campaign manifest",
    )
    if (
        value["schema"] != 1
        or value["kind"] != "kandelo-homebrew-prefix-campaign-candidate"
    ):
        fail("candidate campaign manifest has an unsupported contract")
    source = validate_source(value["source"])
    run = validate_run(value["run"], source)
    campaign_record = exact_keys(
        value["campaign"], {"bytes", "sha256"}, "candidate campaign asset"
    )
    if (
        campaign_record["bytes"] != len(campaign_payload)
        or campaign_record["sha256"] != sha256_bytes(campaign_payload)
    ):
        fail("candidate campaign asset differs from its manifest")
    if expected_tag is not None:
        match = CANDIDATE_TAG.fullmatch(expected_tag)
        if (
            match is None
            or int(match.group(1)) != source["pr_number"]
            or int(match.group(2)) != run["run_id"]
            or int(match.group(3)) != run["run_attempt"]
            or match.group(4) != sha256_bytes(payload)
        ):
            fail("candidate campaign tag differs from its manifest")
    return value


def prepare(arguments: argparse.Namespace) -> None:
    source, _source_payload = load_json(
        pathlib.Path(arguments.source), "candidate campaign source"
    )
    source = validate_source(source)
    run, _run_payload = load_json(
        pathlib.Path(arguments.run_evidence), "candidate campaign run"
    )
    run = validate_run(run, source)
    campaign_path = pathlib.Path(arguments.campaign)
    campaign, campaign_payload, _index = EXECUTOR.load_campaign(campaign_path)
    validate_campaign_authority(campaign, source)
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate campaign output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        assets = temporary / "assets"
        assets.mkdir()
        campaign_asset = assets / "campaign.json"
        shutil.copyfile(campaign_path, campaign_asset)
        if campaign_asset.read_bytes() != campaign_payload:
            fail("candidate campaign changed while copied")
        manifest = {
            "schema": 1,
            "kind": "kandelo-homebrew-prefix-campaign-candidate",
            "source": source,
            "run": run,
            "campaign": {
                "bytes": len(campaign_payload),
                "sha256": sha256_bytes(campaign_payload),
            },
        }
        manifest_payload = pretty_json(manifest)
        validate_manifest(manifest, manifest_payload, campaign_payload)
        manifest_asset = assets / "candidate-campaign.json"
        manifest_asset.write_bytes(manifest_payload)
        tag = candidate_tag(manifest_payload, source, run)
        release_assets = [
            {
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in sorted(assets.iterdir(), key=lambda path: path.name)
        ]
        release = {
            "schema": 1,
            "repository": source["tap_repository"],
            "tag": tag,
            "target_commitish": run["caller_commit"],
            "title": f"Kandelo candidate campaign for PR #{source['pr_number']}",
            "body": (
                "Run-bound, noncanonical campaign evidence. It cannot "
                "publish bottles until an exact-head merge is admitted."
            ),
            "assets": release_assets,
            "preferred_asset_names": [
                asset["name"] for asset in release_assets
            ],
            "accepted_existing_asset_sets": [],
        }
        (temporary / "release-manifest.json").write_bytes(
            pretty_json(release)
        )
        (temporary / "tag.txt").write_text(f"{tag}\n")
        os.replace(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def describe_release(arguments: argparse.Namespace) -> None:
    manifest, manifest_payload = load_json(
        pathlib.Path(arguments.candidate), "candidate campaign manifest"
    )
    campaign_path = pathlib.Path(arguments.campaign)
    _campaign, campaign_payload, _index = EXECUTOR.load_campaign(campaign_path)
    manifest = validate_manifest(
        manifest, manifest_payload, campaign_payload, arguments.candidate_tag
    )
    validate_campaign_authority(_campaign, manifest["source"])
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate campaign description already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        pretty_json(
            {
                "schema": 1,
                "kind": (
                    "kandelo-homebrew-prefix-campaign-candidate-description"
                ),
                "candidate_tag": arguments.candidate_tag,
                "candidate_sha256": sha256_bytes(manifest_payload),
                "campaign_sha256": sha256_bytes(campaign_payload),
                "manifest": manifest,
            }
        )
    )


def fetch_release(arguments: argparse.Namespace) -> None:
    repository = normalized_repository(arguments.repository, "release repository")
    tag = require_string(arguments.tag, "candidate campaign tag")
    match = CANDIDATE_TAG.fullmatch(tag)
    if match is None:
        fail("candidate campaign release tag is invalid")
    output = pathlib.Path(arguments.out)
    candidate_output = pathlib.Path(arguments.candidate_out)
    receipt_output = pathlib.Path(arguments.receipt_out)
    for path, label in (
        (output, "campaign output"),
        (candidate_output, "candidate manifest output"),
        (receipt_output, "candidate readback receipt"),
    ):
        if path.exists() or path.is_symlink():
            fail(f"{label} already exists")
        path.parent.mkdir(parents=True, exist_ok=True)
    assets, release = EXECUTOR.release_assets(repository, tag)
    if set(assets) != {"campaign.json", "candidate-campaign.json"}:
        fail("candidate campaign release has an unexpected asset inventory")
    if assets["candidate-campaign.json"]["sha256"] != match.group(4):
        fail("candidate campaign release differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=".candidate-campaign-readback-", dir=output.parent)
    )
    try:
        staged_campaign = temporary / "campaign.json"
        staged_candidate = temporary / "candidate-campaign.json"
        EXECUTOR.fetch_one_asset(assets, "campaign.json", staged_campaign)
        EXECUTOR.fetch_one_asset(
            assets, "candidate-campaign.json", staged_candidate
        )
        candidate, candidate_payload = load_json(
            staged_candidate, "candidate campaign manifest"
        )
        campaign, campaign_payload, _index = EXECUTOR.load_campaign(
            staged_campaign
        )
        candidate = validate_manifest(
            candidate, candidate_payload, campaign_payload, tag
        )
        validate_campaign_authority(campaign, candidate["source"])
        if release.get("target_commitish") != candidate["run"]["caller_commit"]:
            fail("candidate campaign release targets another caller")
        receipt = {
            "schema": 1,
            "kind": "kandelo-homebrew-prefix-campaign-candidate-readback",
            "repository": repository,
            "tag": tag,
            "release_id": require_int(
                release.get("id"), "candidate campaign release ID", 1
            ),
            "target_commitish": release["target_commitish"],
            "candidate_sha256": sha256_bytes(candidate_payload),
            "campaign_sha256": sha256_bytes(campaign_payload),
        }
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(pretty_json(receipt))
        os.link(staged_campaign, output)
        try:
            os.link(staged_candidate, candidate_output)
            os.link(staged_receipt, receipt_output)
        except OSError:
            output.unlink(missing_ok=True)
            candidate_output.unlink(missing_ok=True)
            receipt_output.unlink(missing_ok=True)
            raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def validate_completed_run(
    completed: Any, recorded: dict[str, Any], source: dict[str, Any]
) -> None:
    completed = validate_run(completed, source)
    expected = dict(recorded)
    expected["status"] = "completed"
    expected["conclusion"] = "success"
    if completed != expected:
        fail("completed candidate campaign run differs from sealed evidence")


def validate_exact_merge(
    main_root: pathlib.Path,
    producer_root: pathlib.Path,
    source: dict[str, Any],
    merge_commit: str,
    current_main: str,
) -> None:
    main_root = exact_git_checkout(main_root, merge_commit, "merged Kandelo")
    producer_root = exact_git_checkout(
        producer_root, source["producer_commit"], "candidate producer"
    )
    # WHY: Git branch and PR-head metadata can move after merge. The immutable
    # merge object below proves the exact base and producer more directly.
    parents = run_git(main_root, "show", "-s", "--format=%P", merge_commit)
    if parents != f"{source['base_commit']} {source['producer_commit']}":
        fail("candidate campaign merge did not preserve [base, exact head]")
    producer_tree = run_git(
        producer_root, "rev-parse", "HEAD^{tree}"
    )
    merge_tree = run_git(main_root, "rev-parse", "HEAD^{tree}")
    if producer_tree != source["producer_tree"] or merge_tree != producer_tree:
        fail("candidate campaign merge tree differs from the candidate")
    require_string(current_main, "current Kandelo main", COMMIT)
    require_ancestor(main_root, merge_commit, current_main, "candidate merge")
    require_ancestor(
        main_root,
        source["workflow_authority_commit"],
        current_main,
        "candidate campaign validator authority",
    )


def recorded_probe_dependencies(
    campaign_module: Any, campaign: dict[str, Any]
) -> Any:
    probes: dict[tuple[str, str], dict[str, Any]] = {}
    for formula in campaign["formulae"]:
        destination = formula.get("destination")
        if not isinstance(destination, dict):
            fail("candidate campaign Formula lacks destination evidence")
        admission = destination.get("admission")
        if not isinstance(admission, dict) or not isinstance(
            admission.get("probe"), dict
        ):
            fail("candidate campaign Formula lacks a bounded destination probe")
        key = (destination.get("remote"), destination.get("reference"))
        if (
            any(not isinstance(item, str) or not item for item in key)
            or key in probes
        ):
            fail("candidate campaign repeats a destination identity")
        probes[key] = admission["probe"]

    def probe(
        remote: str, reference: str, _kandelo_root: pathlib.Path
    ) -> dict[str, Any]:
        key = (remote, reference)
        if key not in probes:
            fail("candidate campaign derivation requested an unsealed destination")
        return json.loads(json.dumps(probes[key]))

    # WHY: registry absence is time-sensitive. A sibling candidate may be
    # promoted after this campaign was sealed. Reuse only the recorded probe
    # while rederiving every source-controlled decision. Each selected bottle
    # still performs its own live collision probe immediately before upload.
    return campaign_module.CampaignDependencies(probe_destination=probe)


def admit(arguments: argparse.Namespace) -> None:
    candidate, candidate_payload = load_json(
        pathlib.Path(arguments.candidate), "candidate campaign manifest"
    )
    campaign_path = pathlib.Path(arguments.campaign)
    campaign, campaign_payload, _index = EXECUTOR.load_campaign(campaign_path)
    candidate = validate_manifest(
        candidate,
        candidate_payload,
        campaign_payload,
        arguments.candidate_tag,
    )
    source = candidate["source"]
    validate_campaign_authority(campaign, source)
    completed, _completed_payload = load_json(
        pathlib.Path(arguments.completed_run_evidence),
        "completed candidate campaign run",
    )
    validate_completed_run(completed, candidate["run"], source)
    main_root = pathlib.Path(arguments.kandelo_main_root)
    producer_root = pathlib.Path(arguments.producer_root)
    validate_exact_merge(
        main_root,
        producer_root,
        source,
        arguments.merge_commit,
        arguments.current_kandelo_main,
    )
    tap_root = exact_git_checkout(
        pathlib.Path(arguments.tap_root),
        source["source_tap_commit"],
        "candidate campaign tap source",
    )
    if run_git(tap_root, "rev-parse", "HEAD^{tree}") != source["source_tap_tree"]:
        fail("candidate campaign tap tree differs from its source evidence")
    require_ancestor(
        tap_root,
        source["source_tap_commit"],
        arguments.current_tap_main,
        "candidate campaign tap source",
    )
    require_ancestor(
        tap_root,
        source["tap_workflow_authority_commit"],
        arguments.current_tap_main,
        "candidate campaign tap workflow authority",
    )
    native_root = exact_git_checkout(
        pathlib.Path(arguments.native_brew_root),
        source["native_homebrew_commit"],
        "candidate native Homebrew",
    )
    main_root = exact_git_checkout(
        main_root, arguments.merge_commit, "merged Kandelo"
    )
    campaign_tool = main_root / "scripts/homebrew-prefix-campaign.py"
    campaign_module = load_tool(
        "homebrew_candidate_campaign_recheck", campaign_tool
    )
    options = campaign_module.CampaignOptions(
        kandelo_root=producer_root,
        kandelo_commit=source["producer_commit"],
        old_tap_root=tap_root,
        old_tap_commit=source["source_tap_commit"],
        source_tap_root=tap_root,
        source_tap_commit=source["source_tap_commit"],
        native_brew_root=native_root,
        native_brew_commit=source["native_homebrew_commit"],
        metadata_sha256=source["old_metadata"]["sha256"],
        guest_layout_sha256=source["guest_layout"]["sha256"],
        jobs=campaign_module.MAX_JOBS,
    )
    regenerated = campaign_module.derive_campaign(
        options, recorded_probe_dependencies(campaign_module, campaign)
    )
    if campaign_module.pretty_json(regenerated) != campaign_payload:
        fail("protected main regenerated a different candidate campaign")
    receipt = {
        "schema": 1,
        "kind": "kandelo-homebrew-prefix-campaign-candidate-admission",
        "candidate_tag": arguments.candidate_tag,
        "candidate_sha256": sha256_bytes(candidate_payload),
        "campaign_sha256": sha256_bytes(campaign_payload),
        "producer_commit": source["producer_commit"],
        "merge_commit": arguments.merge_commit,
        "validated_against_main": arguments.merge_commit,
        "source_tap_commit": source["source_tap_commit"],
        "tap_workflow_authority_commit": source[
            "tap_workflow_authority_commit"
        ],
        "abi": source["abi"],
        "abi_snapshot_sha256": source["abi_snapshot"]["sha256"],
        "guest_layout_sha256": source["guest_layout"]["sha256"],
        "run_id": candidate["run"]["run_id"],
        "run_attempt": candidate["run"]["run_attempt"],
    }
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate campaign admission output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pretty_json(receipt))


def validate_admission_value(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "abi",
            "abi_snapshot_sha256",
            "campaign_sha256",
            "candidate_sha256",
            "candidate_tag",
            "guest_layout_sha256",
            "kind",
            "merge_commit",
            "producer_commit",
            "run_attempt",
            "run_id",
            "schema",
            "source_tap_commit",
            "tap_workflow_authority_commit",
            "validated_against_main",
        },
        "candidate campaign admission",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-prefix-campaign-candidate-admission"
    ):
        fail("candidate campaign admission has an unsupported contract")
    for field in (
        "abi_snapshot_sha256",
        "campaign_sha256",
        "candidate_sha256",
        "guest_layout_sha256",
    ):
        require_string(value[field], field.replace("_", " "), SHA256)
    for field in (
        "merge_commit",
        "producer_commit",
        "source_tap_commit",
        "tap_workflow_authority_commit",
        "validated_against_main",
    ):
        require_string(value[field], field.replace("_", " "), COMMIT)
    require_int(value["abi"], "candidate campaign admission ABI", 1)
    require_int(value["run_id"], "candidate campaign admission run", 1)
    require_int(
        value["run_attempt"], "candidate campaign admission attempt", 1
    )
    match = CANDIDATE_TAG.fullmatch(
        require_string(value["candidate_tag"], "candidate campaign tag")
    )
    if (
        match is None
        or match.group(4) != value["candidate_sha256"]
        or int(match.group(2)) != value["run_id"]
        or int(match.group(3)) != value["run_attempt"]
        or value["validated_against_main"] != value["merge_commit"]
    ):
        fail("candidate campaign admission is internally inconsistent")
    return value


def validate_admission(arguments: argparse.Namespace) -> None:
    value, _payload = load_json(
        pathlib.Path(arguments.receipt), "candidate campaign admission"
    )
    value = validate_admission_value(value)
    expected = {
        "candidate_tag": arguments.candidate_tag,
        "producer_commit": arguments.producer_commit,
        "merge_commit": arguments.merge_commit,
        "source_tap_commit": arguments.source_tap_commit,
        "abi": arguments.abi,
        "guest_layout_sha256": arguments.guest_layout_sha256,
    }
    for field, wanted in expected.items():
        if value[field] != wanted:
            fail(
                "candidate campaign admission differs from publication "
                f"field {field}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    source = commands.add_parser("describe-source")
    source.add_argument("--kandelo-root", required=True)
    source.add_argument("--kandelo-repository", required=True)
    source.add_argument("--base-commit", required=True)
    source.add_argument("--producer-commit", required=True)
    source.add_argument("--workflow-authority-commit", required=True)
    source.add_argument("--pr-number", required=True, type=int)
    source.add_argument("--tap-root", required=True)
    source.add_argument("--tap-repository", required=True)
    source.add_argument("--tap-name", required=True)
    source.add_argument("--source-tap-commit", required=True)
    source.add_argument("--tap-workflow-authority-commit", required=True)
    source.add_argument("--out", required=True)

    prepare_command = commands.add_parser("prepare")
    prepare_command.add_argument("--source", required=True)
    prepare_command.add_argument("--run-evidence", required=True)
    prepare_command.add_argument("--campaign", required=True)
    prepare_command.add_argument("--out", required=True)

    describe = commands.add_parser("describe-release")
    describe.add_argument("--candidate", required=True)
    describe.add_argument("--campaign", required=True)
    describe.add_argument("--candidate-tag", required=True)
    describe.add_argument("--out", required=True)

    fetch = commands.add_parser("fetch-release")
    fetch.add_argument("--repository", required=True)
    fetch.add_argument("--tag", required=True)
    fetch.add_argument("--out", required=True)
    fetch.add_argument("--candidate-out", required=True)
    fetch.add_argument("--receipt-out", required=True)

    admission = commands.add_parser("admit")
    admission.add_argument("--candidate", required=True)
    admission.add_argument("--campaign", required=True)
    admission.add_argument("--candidate-tag", required=True)
    admission.add_argument("--completed-run-evidence", required=True)
    admission.add_argument("--kandelo-main-root", required=True)
    admission.add_argument("--producer-root", required=True)
    admission.add_argument("--tap-root", required=True)
    admission.add_argument("--native-brew-root", required=True)
    admission.add_argument("--merge-commit", required=True)
    admission.add_argument("--current-kandelo-main", required=True)
    admission.add_argument("--current-tap-main", required=True)
    admission.add_argument("--out", required=True)

    validate = commands.add_parser("validate-admission")
    validate.add_argument("--receipt", required=True)
    validate.add_argument("--candidate-tag", required=True)
    validate.add_argument("--producer-commit", required=True)
    validate.add_argument("--merge-commit", required=True)
    validate.add_argument("--source-tap-commit", required=True)
    validate.add_argument("--abi", required=True, type=int)
    validate.add_argument("--guest-layout-sha256", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "describe-source":
            describe_source(arguments)
        elif arguments.command == "prepare":
            prepare(arguments)
        elif arguments.command == "describe-release":
            describe_release(arguments)
        elif arguments.command == "fetch-release":
            fetch_release(arguments)
        elif arguments.command == "admit":
            admit(arguments)
        else:
            validate_admission(arguments)
    except (
        CandidateCampaignError,
        EXECUTOR.ExecutorError,
        OSError,
        subprocess.SubprocessError,
    ) as error:
        print(f"homebrew-candidate-campaign: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
