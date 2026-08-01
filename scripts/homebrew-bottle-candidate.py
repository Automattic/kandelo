#!/usr/bin/env python3
"""Seal and re-materialize one pre-merge Homebrew bottle candidate.

The command deliberately does not build Formulae, execute candidate code, or
write to GitHub.  A reviewed workflow validates the ordinary build handoff and
OCI child before calling ``prepare``.  A protected-main workflow calls
``materialize`` after proving the exact merge and package-generation facts.

Candidate files are separate release assets.  There is no candidate archive
to extract in a credentialed job.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, NoReturn


SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
STAGING_TAG = re.compile(
    r"^pr-([1-9][0-9]*)-staging-run-([1-9][0-9]*)-attempt-"
    r"([1-9][0-9]*)$"
)
CANDIDATE_TAG = re.compile(
    r"^homebrew-bottle-candidate-pr-([1-9][0-9]*)-run-"
    r"([1-9][0-9]*)-attempt-([1-9][0-9]*)-sha256-"
    r"([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
ARTIFACT_DIGEST = re.compile(r"^sha256:([0-9a-f]{64})$")
OCI_DIGEST = ARTIFACT_DIGEST
OCI_TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
PKG_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")

MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
MAX_OCI_BLOBS = 8
MAX_DEPENDENCIES = 256
MAX_PACKAGE_ARCHIVES = 1024

BUILD_FILES = (
    ("manifest.json", "build-manifest.json"),
    ("bottle.json", "build-bottle.json"),
    ("dependency-provenance.json", "build-dependency-provenance.json"),
    ("bottle.tar.gz", "build-bottle.tar.gz"),
)


def validate_expected_package_ledger(value: Any, abi: int) -> dict[str, Any]:
    value = exact_keys(
        value,
        {"abi_version", "entries"},
        "expected package ledger",
    )
    if value["abi_version"] != abi:
        fail("expected package ledger has the wrong ABI")
    entries = value["entries"]
    if (
        not isinstance(entries, list)
        or not entries
        or len(entries) > MAX_PACKAGE_ARCHIVES
    ):
        fail("expected package ledger is empty or too large")
    identities: list[tuple[str, str]] = []
    for position, entry in enumerate(entries):
        entry = exact_keys(
            entry,
            {
                "arch",
                "cache_key_sha",
                "git_inputs",
                "kind",
                "package",
                "revision",
                "version",
            },
            f"expected package #{position}",
        )
        package = require_string(
            entry["package"], f"expected package #{position}", FORMULA
        )
        arch = require_string(entry["arch"], f"expected arch #{position}")
        if arch not in ("wasm32", "wasm64"):
            fail("expected package ledger has an invalid architecture")
        if entry["kind"] not in ("library", "program"):
            fail("expected package ledger has an invalid package kind")
        require_string(entry["version"], "expected package version", PKG_VERSION)
        require_int(entry["revision"], "expected package revision")
        require_string(entry["cache_key_sha"], "expected cache key", SHA256)
        if not isinstance(entry["git_inputs"], list):
            fail("expected package git inputs are not an array")
        identities.append((package, arch))
    if identities != sorted(set(identities)):
        fail("expected package ledger must be unique and sorted")
    return value


def validate_package_snapshot(value: Any, expected: dict[str, Any]) -> dict[str, Any]:
    value = exact_keys(
        value,
        {"abi_version", "complete_current", "entries", "release_tag"},
        "validated package snapshot",
    )
    if (
        value["abi_version"] != expected["abi_version"]
        or value["complete_current"] is not True
    ):
        fail("validated package snapshot is not complete and current")
    entries = value["entries"]
    if not isinstance(entries, list) or len(entries) != len(expected["entries"]):
        fail("validated package snapshot does not cover the full ledger")
    expected_by_identity = {
        (entry["package"], entry["arch"]): entry for entry in expected["entries"]
    }
    seen: set[tuple[str, str]] = set()
    for position, entry in enumerate(entries):
        entry = exact_keys(
            entry,
            {
                "arch",
                "archive_sha256",
                "asset",
                "cache_key_sha",
                "current",
                "kind",
                "package",
                "revision",
                "size",
                "version",
            },
            f"validated package snapshot entry #{position}",
        )
        identity = (entry["package"], entry["arch"])
        wanted = expected_by_identity.get(identity)
        if identity in seen or wanted is None:
            fail("validated package snapshot has an unexpected package")
        seen.add(identity)
        if (
            entry["current"] is not True
            or entry["kind"] != wanted["kind"]
            or entry["version"] != wanted["version"]
            or entry["revision"] != wanted["revision"]
            or entry["cache_key_sha"] != wanted["cache_key_sha"]
        ):
            fail("validated package snapshot differs from the expected ledger")
        name = require_string(entry["asset"], "validated package asset", maximum=255)
        if "/" in name or "\\" in name or name in (".", ".."):
            fail("validated package snapshot has an unsafe asset name")
        require_string(entry["archive_sha256"], "package archive SHA-256", SHA256)
        require_int(entry["size"], "package archive bytes", 1)
    if seen != set(expected_by_identity):
        fail("validated package snapshot omits an expected package")
    return value


def create_package_input(arguments: argparse.Namespace) -> None:
    abi = require_int(arguments.abi, "candidate package ABI", 1)
    producer = require_string(
        arguments.producer_commit, "candidate package producer", COMMIT
    )
    expected, _ = load_json(
        pathlib.Path(arguments.expected_ledger), "expected package ledger"
    )
    expected = validate_expected_package_ledger(expected, abi)
    snapshot, _ = load_json(
        pathlib.Path(arguments.snapshot), "validated package snapshot"
    )
    snapshot = validate_package_snapshot(snapshot, expected)
    release, _ = load_json(
        pathlib.Path(arguments.release_evidence), "package release evidence"
    )
    release = exact_keys(
        release,
        {
            "attempt",
            "immutable",
            "pr_number",
            "release_id",
            "repository",
            "run_id",
            "schema",
            "tag",
            "target_commit",
        },
        "package release evidence",
    )
    if release["schema"] != 1:
        fail("package release evidence has an unsupported schema")
    if normalized_repository(release["repository"]) != "automattic/kandelo":
        fail("package release evidence has the wrong repository")
    match = STAGING_TAG.fullmatch(require_string(release["tag"], "staging tag"))
    if match is None:
        fail("package release evidence has an invalid staging tag")
    pr_number = require_int(release["pr_number"], "package PR number", 1)
    run_id = require_int(release["run_id"], "package run ID", 1)
    attempt = require_int(release["attempt"], "package run attempt", 1)
    if tuple(map(int, match.groups())) != (pr_number, run_id, attempt):
        fail("package release tag differs from its run identity")
    require_int(release["release_id"], "package release ID", 1)
    if release["immutable"] is not True or release["target_commit"] != producer:
        fail("package release is not immutable at the candidate producer")
    if snapshot["release_tag"] != release["tag"]:
        fail("validated package snapshot names a different release")
    index = regular_file(
        pathlib.Path(arguments.index), "validated package index", MAX_JSON_BYTES
    )
    archives = []
    expected_by_identity = {
        (entry["package"], entry["arch"]): entry for entry in expected["entries"]
    }
    for entry in snapshot["entries"]:
        wanted = expected_by_identity[(entry["package"], entry["arch"])]
        archives.append(
            {
                "package": entry["package"],
                "arch": entry["arch"],
                "version": wanted["version"],
                "revision": wanted["revision"],
                "cache_key_sha": wanted["cache_key_sha"],
                "name": entry["asset"],
                "sha256": entry["archive_sha256"],
                "bytes": entry["size"],
            }
        )
    archives.sort(key=lambda item: (item["package"], item["arch"]))
    package_input = {
        "schema": 1,
        "kind": "kandelo-homebrew-candidate-package-input",
        "repository": "Automattic/kandelo",
        "producer_commit": producer,
        "abi": abi,
        "expected_ledger_sha256": sha256_bytes(canonical_json(expected)),
        "index": {"sha256": sha256_file(index), "bytes": index.stat().st_size},
        "staging_release": {
            "tag": release["tag"],
            "release_id": release["release_id"],
            "target_commit": producer,
            "immutable": True,
            "pr_number": pr_number,
            "run_id": run_id,
            "attempt": attempt,
        },
        "archives": archives,
    }
    validate_package_input(package_input)
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate package input output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pretty_json(package_input))


def admit_package_input(arguments: argparse.Namespace) -> None:
    candidate_path = pathlib.Path(arguments.candidate_package_input)
    regenerated_path = pathlib.Path(arguments.regenerated_package_input)
    candidate, candidate_payload = load_json(
        candidate_path, "candidate package input"
    )
    regenerated, regenerated_payload = load_json(
        regenerated_path, "regenerated package input"
    )
    candidate = validate_package_input(candidate)
    regenerated = validate_package_input(regenerated)
    if (
        candidate_payload != pretty_json(candidate)
        or regenerated_payload != pretty_json(regenerated)
    ):
        fail("candidate package admission requires canonical JSON inputs")
    if candidate_payload != regenerated_payload:
        fail("regenerated package input differs from the sealed candidate")
    producer = require_string(
        arguments.producer_commit, "candidate package producer", COMMIT
    )
    validated_main = require_string(
        arguments.validated_main, "package validation main", COMMIT
    )
    if candidate["producer_commit"] != producer:
        fail("candidate package input names another producer")
    main_root = exact_git_checkout(
        pathlib.Path(arguments.validated_main_root),
        validated_main,
        "package validation main checkout",
    )
    producer_tree = run_git(main_root, "rev-parse", f"{producer}^{{tree}}")
    main_tree = run_git(main_root, "rev-parse", f"{validated_main}^{{tree}}")
    if producer_tree != main_tree:
        fail("package producer tree differs from validated main")
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("admitted package input output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    admission = {
        "schema": 1,
        "kind": "kandelo-homebrew-admitted-candidate-package-input",
        "validated_against_main": validated_main,
        "candidate_package_input_sha256": sha256_bytes(candidate_payload),
        "package_input": candidate,
    }
    output.write_bytes(pretty_json(admission))


class CandidateError(ValueError):
    """A candidate did not satisfy its bounded data contract."""


def fail(message: str) -> NoReturn:
    raise CandidateError(message)


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON object repeats key {key!r}")
        result[key] = value
    return result


def load_json(path: pathlib.Path, label: str) -> tuple[Any, bytes]:
    path = regular_file(path, label, MAX_JSON_BYTES)
    payload = path.read_bytes()
    try:
        value = json.loads(payload, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    return value, payload


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} has unexpected fields")
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
        or "\x00" in value
        or "\n" in value
        or "\r" in value
    ):
        fail(f"{label} is not a bounded string")
    if pattern is not None and pattern.fullmatch(value) is None:
        fail(f"{label} has an invalid format")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} is not an integer greater than or equal to {minimum}")
    return value


def regular_file(
    path: pathlib.Path, label: str, maximum: int = MAX_FILE_BYTES
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


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        path.lstat()
    except OSError as error:
        fail(f"cannot inspect {label}: {error}")
    if not path.is_dir() or path.is_symlink():
        fail(f"{label} must be a real directory")
    return path.resolve()


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def file_record(path: pathlib.Path, logical_path: str, asset_name: str) -> dict[str, Any]:
    path = regular_file(path, logical_path)
    if (
        "/" in asset_name
        or "\\" in asset_name
        or asset_name in ("", ".", "..", "candidate.json")
        or len(asset_name.encode()) > 255
    ):
        fail(f"asset name for {logical_path} is unsafe")
    return {
        "asset_name": asset_name,
        "bytes": path.stat().st_size,
        "path": logical_path,
        "sha256": sha256_file(path),
    }


def normalized_repository(value: str) -> str:
    require_string(value, "repository", REPOSITORY)
    return value.lower()


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
        detail = result.stderr.strip()[:2048]
        fail(f"git {' '.join(arguments)} failed: {detail}")
    return result.stdout.strip()


def exact_git_checkout(root: pathlib.Path, expected: str, label: str) -> pathlib.Path:
    root = real_directory(root, label)
    require_string(expected, f"{label} commit", COMMIT)
    if run_git(root, "rev-parse", "HEAD") != expected:
        fail(f"{label} is not at its expected commit")
    if run_git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        fail(f"{label} is not clean")
    return root


def source_contract_file(
    root: pathlib.Path, relative: str, label: str
) -> pathlib.Path:
    current = root
    parts = pathlib.PurePosixPath(relative).parts
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink() or not current.is_dir():
            fail(f"{label} parent must be a real directory")
    result = regular_file(current / parts[-1], label, MAX_JSON_BYTES)
    if result.resolve().parent != current.resolve():
        fail(f"{label} escaped its exact source root")
    return result


def describe_source(arguments: argparse.Namespace) -> None:
    root = exact_git_checkout(
        pathlib.Path(arguments.root),
        arguments.producer_commit,
        "candidate source checkout",
    )
    if pathlib.Path(run_git(root, "rev-parse", "--show-toplevel")) != root:
        fail("candidate source checkout is not the Git worktree root")
    snapshot = source_contract_file(
        root, "abi/snapshot.json", "candidate ABI snapshot"
    )
    layout = source_contract_file(
        root,
        "homebrew/kandelo-guest-layout.json",
        "candidate guest layout",
    )
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate source description output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        pretty_json(
            {
                "schema": 1,
                "producer_commit": arguments.producer_commit,
                "producer_tree": run_git(root, "rev-parse", "HEAD^{tree}"),
                "abi_snapshot_sha256": sha256_file(snapshot),
                "guest_layout_sha256": sha256_file(layout),
            }
        )
    )


def require_ancestor(root: pathlib.Path, ancestor: str, descendant: str, label: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", ancestor, descendant],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        fail(f"{label} is not on protected main history")


def validate_package_input(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "abi",
            "archives",
            "expected_ledger_sha256",
            "index",
            "kind",
            "producer_commit",
            "repository",
            "schema",
            "staging_release",
        },
        "candidate package input",
    )
    if value["schema"] != 1 or value["kind"] != "kandelo-homebrew-candidate-package-input":
        fail("candidate package input has an unsupported contract")
    if normalized_repository(value["repository"]) != "automattic/kandelo":
        fail("candidate package input has the wrong repository")
    require_int(value["abi"], "candidate package ABI", 1)
    require_string(value["producer_commit"], "package producer commit", COMMIT)
    require_string(
        value["expected_ledger_sha256"], "expected package ledger SHA-256", SHA256
    )
    index = exact_keys(
        value["index"], {"bytes", "sha256"}, "candidate package index"
    )
    require_int(index["bytes"], "candidate package index bytes", 1)
    require_string(index["sha256"], "candidate package index SHA-256", SHA256)
    staging = exact_keys(
        value["staging_release"],
        {
            "attempt",
            "immutable",
            "pr_number",
            "release_id",
            "run_id",
            "tag",
            "target_commit",
        },
        "candidate staging release",
    )
    match = STAGING_TAG.fullmatch(
        require_string(staging["tag"], "candidate staging tag")
    )
    if match is None:
        fail("candidate staging release tag is invalid")
    pr_number = require_int(staging["pr_number"], "candidate PR number", 1)
    run_id = require_int(staging["run_id"], "candidate staging run", 1)
    attempt = require_int(staging["attempt"], "candidate staging attempt", 1)
    if tuple(map(int, match.groups())) != (pr_number, run_id, attempt):
        fail("candidate staging tag differs from its run identity")
    require_int(staging["release_id"], "candidate staging release ID", 1)
    if staging["immutable"] is not True:
        fail("candidate staging release is not immutable")
    if staging["target_commit"] != value["producer_commit"]:
        fail("candidate staging release targets a different producer")
    archives = value["archives"]
    if (
        not isinstance(archives, list)
        or not archives
        or len(archives) > MAX_PACKAGE_ARCHIVES
    ):
        fail("candidate package archive ledger is empty or too large")
    identities: list[tuple[str, str]] = []
    names: set[str] = set()
    for position, archive in enumerate(archives):
        archive = exact_keys(
            archive,
            {
                "arch",
                "bytes",
                "cache_key_sha",
                "name",
                "package",
                "revision",
                "sha256",
                "version",
            },
            f"candidate package archive #{position}",
        )
        package = require_string(
            archive["package"], f"candidate package #{position}", FORMULA
        )
        arch = require_string(archive["arch"], f"candidate arch #{position}")
        if arch not in ("wasm32", "wasm64"):
            fail("candidate package archive has an invalid architecture")
        require_string(archive["version"], "candidate package version", PKG_VERSION)
        require_int(archive["revision"], "candidate package revision")
        require_string(archive["cache_key_sha"], "candidate cache key", SHA256)
        name = require_string(archive["name"], "candidate archive name", maximum=255)
        if "/" in name or "\\" in name or name in (".", "..") or name in names:
            fail("candidate package archive names are unsafe or duplicated")
        names.add(name)
        require_string(archive["sha256"], "candidate archive SHA-256", SHA256)
        require_int(archive["bytes"], "candidate archive bytes", 1)
        identities.append((package, arch))
    if identities != sorted(set(identities)):
        fail("candidate package archive ledger must be unique and sorted")
    return value


def validate_dependencies(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) > MAX_DEPENDENCIES:
        fail("candidate dependencies are not a bounded array")
    prior = ""
    for position, dependency in enumerate(value):
        dependency = exact_keys(
            dependency,
            {"formula", "manifest_sha256", "tag"},
            f"candidate dependency #{position}",
        )
        name = require_string(
            dependency["formula"], f"candidate dependency #{position} Formula", FORMULA
        )
        digest = require_string(
            dependency["manifest_sha256"], "candidate dependency SHA-256", SHA256
        )
        match = HANDOFF_TAG.fullmatch(
            require_string(dependency["tag"], "candidate dependency tag")
        )
        if match is None or match.group(1) != digest:
            fail("candidate dependency tag differs from its manifest")
        if name <= prior:
            fail("candidate dependencies must be unique and sorted")
        prior = name
    return value


def validate_run_evidence(value: Any, formula: str, arch: str) -> dict[str, Any]:
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
        "candidate run evidence",
    )
    if value["schema"] != 1:
        fail("candidate run evidence has an unsupported schema")
    normalized_repository(value["repository"])
    require_string(value["caller_commit"], "candidate caller commit", COMMIT)
    if value["event"] != "repository_dispatch":
        fail("candidate run did not use repository_dispatch")
    if value["workflow_path"] != ".github/workflows/candidate-bottles.yml":
        fail("candidate run did not use its reviewed caller")
    run_id = require_int(value["run_id"], "candidate run ID", 1)
    attempt = require_int(value["run_attempt"], "candidate run attempt", 1)
    if value["status"] not in ("in_progress", "completed"):
        fail("candidate run status is invalid")
    if value["conclusion"] not in (None, "success"):
        fail("candidate run conclusion is not successful")
    if value["status"] == "completed" and value["conclusion"] != "success":
        fail("completed candidate run is not successful")
    expected_names = {
        f"homebrew-build-handoff-{formula}-{arch}-attempt-{attempt}",
        f"homebrew-oci-child-{formula}-{arch}-attempt-{attempt}",
        f"homebrew-candidate-package-input-{formula}-{arch}-attempt-{attempt}",
    }
    artifacts = value["artifacts"]
    if not isinstance(artifacts, list) or len(artifacts) != 3:
        fail("candidate run must bind exactly three candidate artifacts")
    names: set[str] = set()
    ids: set[int] = set()
    for position, artifact in enumerate(artifacts):
        artifact = exact_keys(
            artifact,
            {"bytes", "digest", "id", "name", "run_attempt", "run_id"},
            f"candidate artifact #{position}",
        )
        artifact_id = require_int(artifact["id"], "candidate artifact ID", 1)
        name = require_string(artifact["name"], "candidate artifact name", maximum=255)
        require_int(artifact["bytes"], "candidate artifact bytes", 1)
        require_string(artifact["digest"], "candidate artifact digest", ARTIFACT_DIGEST)
        if artifact["run_id"] != run_id or artifact["run_attempt"] != attempt:
            fail("candidate artifact belongs to a different run")
        if artifact_id in ids or name in names:
            fail("candidate artifact identity is duplicated")
        ids.add(artifact_id)
        names.add(name)
    if names != expected_names:
        fail("candidate artifacts differ from the exact Formula run")
    return value


def validate_source_evidence(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "abi",
            "abi_snapshot_sha256",
            "base_commit",
            "guest_layout",
            "kandelo_repository",
            "merge_method",
            "pr_number",
            "producer_commit",
            "producer_tree",
            "prefix_campaign_layout_sha256",
            "prefix_campaign_tag",
            "release_tag",
            "tap_commit",
            "tap_checkout_commit",
            "tap_checkout_tree",
            "tap_name",
            "tap_repository",
            "workflow_authority_commit",
        },
        "candidate source evidence",
    )
    if normalized_repository(value["kandelo_repository"]) != "automattic/kandelo":
        fail("candidate source has the wrong Kandelo repository")
    normalized_repository(value["tap_repository"])
    require_string(value["tap_name"], "candidate tap name", REPOSITORY)
    pr_number = require_int(value["pr_number"], "candidate PR number", 1)
    del pr_number
    require_string(value["base_commit"], "candidate base commit", COMMIT)
    require_string(value["producer_commit"], "candidate producer commit", COMMIT)
    require_string(value["producer_tree"], "candidate producer tree", COMMIT)
    require_string(
        value["workflow_authority_commit"], "candidate workflow authority", COMMIT
    )
    if value["workflow_authority_commit"] != value["base_commit"]:
        fail("candidate validator authority must equal its protected base")
    require_string(value["tap_commit"], "candidate tap commit", COMMIT)
    require_string(
        value["tap_checkout_commit"], "candidate prepared tap commit", COMMIT
    )
    require_string(
        value["tap_checkout_tree"], "candidate prepared tap tree", COMMIT
    )
    campaign = require_string(
        value["prefix_campaign_tag"], "candidate prefix campaign tag"
    )
    if re.fullmatch(
        r"homebrew-prefix-campaign-candidate-pr-[1-9][0-9]*-run-"
        r"[1-9][0-9]*-attempt-[1-9][0-9]*-sha256-[0-9a-f]{64}",
        campaign,
    ) is None:
        fail("candidate prefix campaign tag is invalid")
    require_string(
        value["prefix_campaign_layout_sha256"],
        "candidate prefix campaign layout SHA-256",
        SHA256,
    )
    abi = require_int(value["abi"], "candidate ABI", 1)
    if value["merge_method"] != "merge":
        fail("candidate promotion requires an exact-head merge commit")
    if value["release_tag"] != f"bottles-abi-v{abi}":
        fail("candidate bottle release tag differs from its ABI")
    require_string(value["abi_snapshot_sha256"], "ABI snapshot SHA-256", SHA256)
    layout = exact_keys(
        value["guest_layout"], {"path", "sha256"}, "candidate guest layout"
    )
    if layout["path"] != "homebrew/kandelo-guest-layout.json":
        fail("candidate guest layout path is not canonical")
    require_string(layout["sha256"], "candidate guest layout SHA-256", SHA256)
    return value


def validate_destination(value: Any, receipt: dict[str, Any]) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "child_digest",
            "child_ref",
            "child_status",
            "formula",
            "homebrew_ref",
            "homebrew_ref_status",
            "observed_at",
            "remote",
            "top_ref",
            "top_digest",
            "top_status",
        },
        "candidate destination evidence",
    )
    if value["formula"] != receipt["formula"]:
        fail("candidate destination names a different Formula")
    require_string(value["observed_at"], "destination observation time", maximum=128)
    expected_remote = (
        f"ghcr.io/{receipt['tap_repository'].lower()}/{receipt['formula']}"
    )
    if value["remote"].lower() != expected_remote:
        fail("candidate destination remote is not canonical")
    if value["child_ref"] != receipt["oci"]["transport_tag"]:
        fail("candidate destination child ref differs from the OCI child")
    if value["homebrew_ref"] != receipt["oci"]["homebrew_ref"]:
        fail("candidate destination Homebrew ref differs from the OCI child")
    if value["top_ref"] != receipt["top_ref"]:
        fail("candidate destination top ref differs from the OCI child")
    if value["child_status"] == "missing":
        if value["child_digest"] is not None:
            fail("missing candidate child unexpectedly has a digest")
    elif value["child_status"] == "present":
        digest = require_string(
            value["child_digest"], "candidate child digest", OCI_DIGEST
        )
        if digest != receipt["oci"]["manifest"]["digest"]:
            fail("candidate transport ref contains different OCI bytes")
    else:
        fail("candidate child ref has an ambiguous registry status")
    # WHY: the content-addressed transport tag is not Homebrew's selection
    # key. The sealer separately proves the live top index can accept this
    # version/rebuild ref without replacing another ABI's bytes.
    if value["homebrew_ref_status"] != "available":
        fail("candidate Formula version/rebuild destination is not collision-free")
    if value["top_status"] == "missing":
        if value["top_digest"] is not None:
            fail("missing candidate top ref unexpectedly has a digest")
    elif value["top_status"] == "present":
        require_string(value["top_digest"], "candidate top digest", OCI_DIGEST)
    else:
        fail("candidate top ref has an ambiguous registry status")
    return value


def validate_build_and_oci(
    build_root: pathlib.Path,
    oci_root: pathlib.Path,
    source: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], pathlib.Path]:
    build_root = real_directory(build_root, "candidate build handoff")
    oci_root = real_directory(oci_root, "candidate OCI child")
    actual_build = sorted(path.name for path in build_root.iterdir())
    if actual_build != sorted(item[0] for item in BUILD_FILES):
        fail("candidate build handoff has an unexpected file inventory")
    for path in build_root.iterdir():
        regular_file(path, f"candidate build file {path.name}")
    manifest, _ = load_json(build_root / "manifest.json", "build manifest")
    manifest = exact_keys(
        manifest,
        {
            "arch",
            "bottle",
            "bottle_root_url",
            "dependency_provenance",
            "formula",
            "kandelo_commit",
            "release_tag",
            "schema",
            "tap_checkout_commit",
            "tap_commit",
            "tap_name",
            "tap_repository",
        },
        "build manifest",
    )
    if manifest["schema"] != 4:
        fail("build manifest has an unsupported schema")
    formula = require_string(manifest["formula"], "candidate Formula", FORMULA)
    arch = require_string(manifest["arch"], "candidate architecture")
    if arch not in ("wasm32", "wasm64"):
        fail("candidate architecture is invalid")
    if (
        manifest["release_tag"] != source["release_tag"]
        or manifest["kandelo_commit"] != source["producer_commit"]
        or manifest["tap_commit"] != source["tap_commit"]
        or manifest["tap_checkout_commit"] != source["tap_checkout_commit"]
        or manifest["tap_repository"].lower() != source["tap_repository"].lower()
        or manifest["tap_name"].lower() != source["tap_name"].lower()
    ):
        fail("build manifest differs from candidate source evidence")
    bottle = exact_keys(
        manifest["bottle"],
        {"archive", "bytes", "cellar", "json", "sha256", "tag"},
        "build bottle",
    )
    if bottle["archive"] != "bottle.tar.gz" or bottle["json"] != "bottle.json":
        fail("candidate build bottle paths are not canonical")
    bottle_path = regular_file(build_root / "bottle.tar.gz", "candidate bottle")
    if (
        require_int(bottle["bytes"], "candidate bottle bytes", 1)
        != bottle_path.stat().st_size
        or require_string(bottle["sha256"], "candidate bottle SHA-256", SHA256)
        != sha256_file(bottle_path)
    ):
        fail("candidate bottle differs from its build manifest")
    dependency = exact_keys(
        manifest["dependency_provenance"],
        {"bytes", "json", "sha256"},
        "build dependency provenance",
    )
    if dependency["json"] != "dependency-provenance.json":
        fail("candidate dependency provenance path is not canonical")
    dependency_path = regular_file(
        build_root / "dependency-provenance.json", "candidate dependency provenance"
    )
    if (
        dependency["bytes"] != dependency_path.stat().st_size
        or dependency["sha256"] != sha256_file(dependency_path)
    ):
        fail("candidate dependency provenance differs from its manifest")

    receipt, _ = load_json(oci_root / "receipt.json", "OCI child receipt")
    receipt = exact_keys(
        receipt,
        {
            "abi",
            "arch",
            "bottle",
            "bottle_rebuild",
            "formula",
            "formula_revision",
            "formula_source_identity_sha256",
            "formula_source_sha256",
            "kandelo_commit",
            "kind",
            "oci",
            "pkg_version",
            "schema",
            "source_closure_sha256",
            "tap_commit",
            "tap_name",
            "tap_repository",
            "top_ref",
        },
        "OCI child receipt",
    )
    if receipt["schema"] != 2 or receipt["kind"] != "child":
        fail("OCI child receipt has an unsupported contract")
    if (
        receipt["formula"] != formula
        or receipt["arch"] != arch
        or receipt["abi"] != source["abi"]
        or receipt["kandelo_commit"] != source["producer_commit"]
        or receipt["tap_commit"] != source["tap_commit"]
        or receipt["tap_repository"].lower() != source["tap_repository"].lower()
        or receipt["tap_name"].lower() != source["tap_name"].lower()
    ):
        fail("OCI child receipt differs from the candidate source")
    receipt_bottle = exact_keys(
        receipt["bottle"], {"bytes", "sha256", "url"}, "OCI receipt bottle"
    )
    if (
        receipt_bottle["bytes"] != bottle["bytes"]
        or receipt_bottle["sha256"] != bottle["sha256"]
    ):
        fail("OCI child receipt names different bottle bytes")
    require_string(receipt["pkg_version"], "candidate package version", PKG_VERSION)
    require_int(receipt["formula_revision"], "candidate Formula revision")
    require_int(receipt["bottle_rebuild"], "candidate bottle rebuild")
    require_string(
        receipt["formula_source_identity_sha256"],
        "candidate Formula identity SHA-256",
        SHA256,
    )
    require_string(
        receipt["formula_source_sha256"], "candidate Formula SHA-256", SHA256
    )
    require_string(
        receipt["source_closure_sha256"], "candidate source closure SHA-256", SHA256
    )
    oci = exact_keys(
        receipt["oci"],
        {"config", "diff_id", "homebrew_ref", "manifest", "platform", "transport_tag"},
        "OCI child identity",
    )
    require_string(oci["homebrew_ref"], "OCI child ref", OCI_TAG)
    require_string(oci["transport_tag"], "OCI transport tag", OCI_TAG)
    manifest_descriptor = exact_keys(
        oci["manifest"], {"digest", "size"}, "OCI manifest descriptor"
    )
    manifest_match = OCI_DIGEST.fullmatch(
        require_string(manifest_descriptor["digest"], "OCI manifest digest")
    )
    assert manifest_match is not None
    require_int(manifest_descriptor["size"], "OCI manifest bytes", 1)
    if oci["transport_tag"] != f"sha256-{manifest_match.group(1)}":
        fail("OCI transport tag is not content-derived")
    require_string(receipt["top_ref"], "OCI top ref", OCI_TAG)

    layout = real_directory(oci_root / "layout", "candidate OCI layout")
    expected_static = {"index.json", "oci-layout", "blobs"}
    if {path.name for path in layout.iterdir()} != expected_static:
        fail("candidate OCI layout has an unexpected top-level inventory")
    regular_file(layout / "index.json", "candidate OCI index", MAX_JSON_BYTES)
    regular_file(layout / "oci-layout", "candidate OCI marker", MAX_JSON_BYTES)
    blob_root = real_directory(layout / "blobs", "candidate OCI blob root")
    if {path.name for path in blob_root.iterdir()} != {"sha256"}:
        fail("candidate OCI blob root is not canonical")
    sha_root = real_directory(blob_root / "sha256", "candidate OCI SHA-256 root")
    blobs = sorted(sha_root.iterdir(), key=lambda path: path.name)
    if not blobs or len(blobs) > MAX_OCI_BLOBS:
        fail("candidate OCI blob inventory is empty or too large")
    for blob in blobs:
        require_string(blob.name, "candidate OCI blob name", SHA256)
        regular_file(blob, f"candidate OCI blob {blob.name}")
        if sha256_file(blob) != blob.name:
            fail("candidate OCI blob name differs from its bytes")
    required_blobs = {
        bottle["sha256"],
        manifest_match.group(1),
    }
    config = exact_keys(
        oci["config"],
        {"digest", "mediaType", "size"},
        "OCI config descriptor",
    )
    if config["mediaType"] != "application/vnd.oci.image.config.v1+json":
        fail("OCI config descriptor has the wrong media type")
    config_match = OCI_DIGEST.fullmatch(
        require_string(config["digest"], "OCI config digest")
    )
    assert config_match is not None
    require_int(config["size"], "OCI config bytes", 1)
    required_blobs.add(config_match.group(1))
    if not required_blobs.issubset({blob.name for blob in blobs}):
        fail("candidate OCI layout lacks a receipt-bound blob")
    return manifest, receipt, layout


def copy_assets(
    build_root: pathlib.Path,
    oci_root: pathlib.Path,
    package_input_path: pathlib.Path,
    assets: pathlib.Path,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for source_name, asset_name in BUILD_FILES:
        source = build_root / source_name
        destination = assets / asset_name
        shutil.copyfile(source, destination)
        records.append(file_record(destination, f"build/{source_name}", asset_name))
    for source, logical, asset_name in (
        (oci_root / "receipt.json", "oci/receipt.json", "oci-receipt.json"),
        (oci_root / "layout/oci-layout", "oci/layout/oci-layout", "oci-layout.json"),
        (oci_root / "layout/index.json", "oci/layout/index.json", "oci-index.json"),
        (package_input_path, "package-input.json", "package-input.json"),
    ):
        destination = assets / asset_name
        shutil.copyfile(source, destination)
        records.append(file_record(destination, logical, asset_name))
    sha_root = oci_root / "layout/blobs/sha256"
    for source in sorted(sha_root.iterdir(), key=lambda path: path.name):
        asset_name = f"oci-blob-{source.name}"
        destination = assets / asset_name
        shutil.copyfile(source, destination)
        records.append(
            file_record(
                destination,
                f"oci/layout/blobs/sha256/{source.name}",
                asset_name,
            )
        )
    return sorted(records, key=lambda record: record["path"])


def candidate_tag(manifest_payload: bytes, manifest: dict[str, Any]) -> str:
    return (
        "homebrew-bottle-candidate-pr-"
        f"{manifest['source']['pr_number']}-run-"
        f"{manifest['run']['run_id']}-attempt-"
        f"{manifest['run']['run_attempt']}-sha256-"
        f"{sha256_bytes(manifest_payload)}"
    )


def validate_candidate_manifest(
    value: Any, payload: bytes, expected_tag: str | None = None
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "dependencies",
            "destination",
            "files",
            "formula",
            "kind",
            "package_input",
            "run",
            "schema",
            "source",
        },
        "Homebrew bottle candidate",
    )
    if value["schema"] != 1 or value["kind"] != "kandelo-homebrew-bottle-candidate":
        fail("Homebrew bottle candidate has an unsupported contract")
    source = validate_source_evidence(value["source"])
    formula = exact_keys(
        value["formula"],
        {
            "arch",
            "bottle_rebuild",
            "formula_revision",
            "formula_source_identity_sha256",
            "formula_source_sha256",
            "name",
            "pkg_version",
            "source_closure_sha256",
        },
        "candidate Formula",
    )
    name = require_string(formula["name"], "candidate Formula name", FORMULA)
    if formula["arch"] not in ("wasm32", "wasm64"):
        fail("candidate Formula architecture is invalid")
    require_string(formula["pkg_version"], "candidate Formula version", PKG_VERSION)
    require_int(formula["formula_revision"], "candidate Formula revision")
    require_int(formula["bottle_rebuild"], "candidate bottle rebuild")
    for key in (
        "formula_source_identity_sha256",
        "formula_source_sha256",
        "source_closure_sha256",
    ):
        require_string(formula[key], f"candidate {key}", SHA256)
    dependencies = validate_dependencies(value["dependencies"])
    if dependencies:
        fail("candidate schema 1 is restricted to leaf Formulae")
    run = validate_run_evidence(value["run"], name, formula["arch"])
    if normalized_repository(run["repository"]) != normalized_repository(
        source["tap_repository"]
    ):
        fail("candidate run repository differs from the tap source")
    package_record = exact_keys(
        value["package_input"], {"bytes", "sha256"}, "candidate package input record"
    )
    require_int(package_record["bytes"], "candidate package input bytes", 1)
    require_string(package_record["sha256"], "candidate package input SHA-256", SHA256)
    files = value["files"]
    if not isinstance(files, list) or not files:
        fail("candidate file inventory is empty")
    paths: list[str] = []
    assets: set[str] = set()
    total = len(payload)
    for position, record in enumerate(files):
        record = exact_keys(
            record,
            {"asset_name", "bytes", "path", "sha256"},
            f"candidate file #{position}",
        )
        path = require_string(record["path"], "candidate logical path", maximum=512)
        if (
            path.startswith("/")
            or "\\" in path
            or any(part in ("", ".", "..") for part in path.split("/"))
        ):
            fail("candidate logical path is unsafe")
        asset = require_string(record["asset_name"], "candidate asset name", maximum=255)
        if "/" in asset or "\\" in asset or asset in assets:
            fail("candidate release asset is unsafe or duplicated")
        assets.add(asset)
        byte_count = require_int(record["bytes"], "candidate asset bytes", 1)
        require_string(record["sha256"], "candidate asset SHA-256", SHA256)
        total += byte_count
        if total > MAX_TOTAL_BYTES:
            fail("candidate release exceeds its aggregate byte bound")
        paths.append(path)
    if paths != sorted(set(paths)):
        fail("candidate file inventory must be unique and sorted")
    fixed_paths = {
        *(f"build/{name}" for name, _asset in BUILD_FILES),
        "oci/receipt.json",
        "oci/layout/oci-layout",
        "oci/layout/index.json",
        "package-input.json",
    }
    path_set = set(paths)
    if not fixed_paths.issubset(path_set):
        fail("candidate file inventory omits a required handoff file")
    blob_paths = path_set - fixed_paths
    if not blob_paths or len(blob_paths) > MAX_OCI_BLOBS or any(
        re.fullmatch(r"oci/layout/blobs/sha256/[0-9a-f]{64}", path) is None
        for path in blob_paths
    ):
        fail("candidate file inventory has an invalid OCI blob set")
    if expected_tag is not None:
        match = CANDIDATE_TAG.fullmatch(expected_tag)
        if match is None:
            fail("candidate release tag is invalid")
        if (
            int(match.group(1)) != source["pr_number"]
            or int(match.group(2)) != run["run_id"]
            or int(match.group(3)) != run["run_attempt"]
            or match.group(4) != sha256_bytes(payload)
        ):
            fail("candidate release tag differs from candidate.json")
    return value


def describe_release(arguments: argparse.Namespace) -> None:
    candidate_path = pathlib.Path(arguments.candidate)
    value, payload = load_json(candidate_path, "candidate.json")
    manifest = validate_candidate_manifest(value, payload, arguments.candidate_tag)
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate release description output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    description = {
        "schema": 1,
        "kind": "kandelo-homebrew-bottle-candidate-release-description",
        "candidate_tag": arguments.candidate_tag,
        "candidate_sha256": sha256_bytes(payload),
        "assets": [
            {
                "asset_name": record["asset_name"],
                "bytes": record["bytes"],
                "sha256": record["sha256"],
            }
            for record in manifest["files"]
        ],
        "manifest": manifest,
    }
    output.write_bytes(pretty_json(description))


def prepare(arguments: argparse.Namespace) -> None:
    source, _ = load_json(pathlib.Path(arguments.source), "candidate source evidence")
    source = validate_source_evidence(source)
    package_input_path = regular_file(
        pathlib.Path(arguments.package_input), "candidate package input", MAX_JSON_BYTES
    )
    package_input, package_payload = load_json(
        package_input_path, "candidate package input"
    )
    package_input = validate_package_input(package_input)
    # WHY: admission later compares the exact released package ledger bytes.
    # One canonical encoding prevents semantically equal JSON from acquiring
    # several different identities across pre-merge and post-merge jobs.
    if package_payload != pretty_json(package_input):
        fail("candidate package input must use canonical pretty JSON")
    if (
        package_input["producer_commit"] != source["producer_commit"]
        or package_input["abi"] != source["abi"]
        or package_input["staging_release"]["pr_number"] != source["pr_number"]
    ):
        fail("candidate package input differs from candidate source")
    dependencies, _ = load_json(
        pathlib.Path(arguments.dependencies), "candidate dependencies"
    )
    dependencies = validate_dependencies(dependencies)
    if dependencies:
        fail("candidate schema 1 is restricted to leaf Formulae")
    build_root = real_directory(
        pathlib.Path(arguments.build_handoff), "candidate build handoff"
    )
    oci_root = real_directory(pathlib.Path(arguments.oci_child), "candidate OCI child")
    build, receipt, _layout = validate_build_and_oci(build_root, oci_root, source)
    run, _ = load_json(pathlib.Path(arguments.run_evidence), "candidate run evidence")
    run = validate_run_evidence(run, receipt["formula"], receipt["arch"])
    destination, _ = load_json(
        pathlib.Path(arguments.destination), "candidate destination evidence"
    )
    destination = validate_destination(destination, receipt)

    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        assets = temporary / "assets"
        assets.mkdir()
        file_records = copy_assets(build_root, oci_root, package_input_path, assets)
        package_record = next(
            record for record in file_records if record["path"] == "package-input.json"
        )
        if (
            package_record["bytes"] != len(package_payload)
            or package_record["sha256"] != sha256_bytes(package_payload)
        ):
            fail("copied candidate package input changed")
        manifest = {
            "schema": 1,
            "kind": "kandelo-homebrew-bottle-candidate",
            "source": source,
            "run": run,
            "formula": {
                "name": receipt["formula"],
                "arch": receipt["arch"],
                "pkg_version": receipt["pkg_version"],
                "formula_revision": receipt["formula_revision"],
                "bottle_rebuild": receipt["bottle_rebuild"],
                "formula_source_identity_sha256": receipt[
                    "formula_source_identity_sha256"
                ],
                "formula_source_sha256": receipt["formula_source_sha256"],
                "source_closure_sha256": receipt["source_closure_sha256"],
            },
            "destination": destination,
            "dependencies": dependencies,
            "package_input": {
                "bytes": package_record["bytes"],
                "sha256": package_record["sha256"],
            },
            "files": file_records,
        }
        payload = pretty_json(manifest)
        validate_candidate_manifest(manifest, payload)
        (assets / "candidate.json").write_bytes(payload)
        tag = candidate_tag(payload, manifest)
        release_assets = [
            {
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in sorted(assets.iterdir(), key=lambda path: path.name)
        ]
        release_names = [asset["name"] for asset in release_assets]
        release = {
            "schema": 1,
            "repository": source["tap_repository"],
            "tag": tag,
            "target_commitish": run["caller_commit"],
            "title": (
                f"Kandelo Homebrew candidate: {receipt['formula']}/"
                f"{receipt['arch']}"
            ),
            "body": (
                f"Run-bound, noncanonical bottle candidate for Kandelo PR "
                f"#{source['pr_number']}."
            ),
            "assets": release_assets,
            "preferred_asset_names": release_names,
            "accepted_existing_asset_sets": [],
        }
        (temporary / "release-manifest.json").write_bytes(pretty_json(release))
        (temporary / "tag.txt").write_text(f"{tag}\n")
        os.replace(temporary, output)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def verify_release_assets(root: pathlib.Path, manifest: dict[str, Any]) -> None:
    expected = {"candidate.json"}
    total = 0
    for record in manifest["files"]:
        expected.add(record["asset_name"])
        path = regular_file(root / record["asset_name"], record["path"])
        if path.stat().st_size != record["bytes"] or sha256_file(path) != record["sha256"]:
            fail(f"candidate asset {record['asset_name']} differs from candidate.json")
        total += path.stat().st_size
        if total > MAX_TOTAL_BYTES:
            fail("candidate assets exceed their aggregate byte bound")
    actual = {path.name for path in root.iterdir()}
    if actual != expected:
        fail("candidate release contains a missing or unexpected asset")


def validate_completed_run(
    value: Any, candidate_run: dict[str, Any], formula: str, arch: str
) -> None:
    current = validate_run_evidence(value, formula, arch)
    if current["status"] != "completed" or current["conclusion"] != "success":
        fail("candidate workflow run has not completed successfully")
    # Artifact IDs and digests are immutable identities.  Require the whole
    # record so a same-named artifact from a rerun cannot replace the input.
    if current != {**candidate_run, "status": "completed", "conclusion": "success"}:
        fail("candidate workflow evidence changed after release preparation")


def validate_merge(
    root: pathlib.Path,
    source: dict[str, Any],
    merge_commit: str,
    current_main: str,
) -> None:
    require_string(merge_commit, "candidate merge commit", COMMIT)
    require_string(current_main, "current Kandelo main", COMMIT)
    root = exact_git_checkout(root, merge_commit, "Kandelo activation checkout")
    # WHY: after merge, a branch ref and GitHub's PR head are mutable metadata.
    # The merge object is immutable and already names both exact commits, so it
    # is the stronger authority for deciding whether these bytes may survive.
    parents = run_git(root, "show", "-s", "--format=%P", merge_commit)
    expected_parents = f"{source['base_commit']} {source['producer_commit']}"
    if parents != expected_parents:
        fail("candidate merge does not preserve the prepared base and exact head")
    producer_tree = run_git(root, "rev-parse", f"{source['producer_commit']}^{{tree}}")
    merge_tree = run_git(root, "rev-parse", f"{merge_commit}^{{tree}}")
    if producer_tree != source["producer_tree"] or merge_tree != producer_tree:
        fail("candidate producer and merged trees are not identical")
    require_ancestor(root, merge_commit, current_main, "candidate merge")
    require_ancestor(root, source["producer_commit"], current_main, "candidate producer")
    require_ancestor(
        root,
        source["workflow_authority_commit"],
        current_main,
        "candidate validator authority",
    )


def validate_tap_history(
    root: pathlib.Path,
    source: dict[str, Any],
    run: dict[str, Any],
    current_main: str,
) -> None:
    root = exact_git_checkout(
        root,
        source["tap_checkout_commit"],
        "prepared tap activation checkout",
    )
    require_string(current_main, "current tap main", COMMIT)
    if (
        run_git(root, "rev-parse", "HEAD^{tree}")
        != source["tap_checkout_tree"]
    ):
        fail("prepared tap activation tree differs from the candidate")
    require_ancestor(
        root,
        source["tap_commit"],
        source["tap_checkout_commit"],
        "prepared candidate tap source",
    )
    require_ancestor(root, source["tap_commit"], current_main, "candidate tap source")
    require_ancestor(
        root,
        run["caller_commit"],
        current_main,
        "candidate tap workflow authority",
    )


def copy_materialized_assets(
    root: pathlib.Path,
    manifest: dict[str, Any],
    build_output: pathlib.Path,
    oci_output: pathlib.Path,
    package_output: pathlib.Path,
) -> None:
    if any(
        path.exists() or path.is_symlink()
        for path in (build_output, oci_output, package_output)
    ):
        fail("materialized candidate outputs must not already exist")
    build_output.parent.mkdir(parents=True, exist_ok=True)
    oci_output.parent.mkdir(parents=True, exist_ok=True)
    build_tmp = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{build_output.name}.", dir=build_output.parent)
    )
    oci_tmp = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{oci_output.name}.", dir=oci_output.parent)
    )
    try:
        (oci_tmp / "layout/blobs/sha256").mkdir(parents=True)
        by_path = {record["path"]: record for record in manifest["files"]}
        for source_name, _asset_name in BUILD_FILES:
            record = by_path[f"build/{source_name}"]
            shutil.copyfile(root / record["asset_name"], build_tmp / source_name)
        for logical, destination in (
            ("oci/receipt.json", oci_tmp / "receipt.json"),
            ("oci/layout/oci-layout", oci_tmp / "layout/oci-layout"),
            ("oci/layout/index.json", oci_tmp / "layout/index.json"),
        ):
            record = by_path[logical]
            shutil.copyfile(root / record["asset_name"], destination)
        blob_prefix = "oci/layout/blobs/sha256/"
        for logical, record in by_path.items():
            if logical.startswith(blob_prefix):
                digest = logical.removeprefix(blob_prefix)
                shutil.copyfile(
                    root / record["asset_name"],
                    oci_tmp / "layout/blobs/sha256" / digest,
                )
        package_record = by_path["package-input.json"]
        package_output.parent.mkdir(parents=True, exist_ok=True)
        package_tmp = package_output.with_name(f".{package_output.name}.tmp")
        if package_tmp.exists() or package_tmp.is_symlink():
            fail("candidate package temporary output is occupied")
        shutil.copyfile(root / package_record["asset_name"], package_tmp)
        os.replace(build_tmp, build_output)
        os.replace(oci_tmp, oci_output)
        os.replace(package_tmp, package_output)
    except Exception:
        shutil.rmtree(build_tmp, ignore_errors=True)
        shutil.rmtree(oci_tmp, ignore_errors=True)
        package_tmp = package_output.with_name(f".{package_output.name}.tmp")
        package_tmp.unlink(missing_ok=True)
        raise


def materialize(arguments: argparse.Namespace) -> None:
    root = real_directory(pathlib.Path(arguments.candidate_root), "candidate release")
    candidate_path = regular_file(root / "candidate.json", "candidate.json", MAX_JSON_BYTES)
    manifest, payload = load_json(candidate_path, "candidate.json")
    manifest = validate_candidate_manifest(manifest, payload, arguments.candidate_tag)
    verify_release_assets(root, manifest)
    package_record = manifest["package_input"]
    package_asset = next(
        record for record in manifest["files"] if record["path"] == "package-input.json"
    )
    if (
        package_record["bytes"] != package_asset["bytes"]
        or package_record["sha256"] != package_asset["sha256"]
    ):
        fail("candidate package input record differs from its release asset")
    package_input, _ = load_json(
        root / package_asset["asset_name"], "released candidate package input"
    )
    package_input = validate_package_input(package_input)
    admitted, admitted_payload = load_json(
        pathlib.Path(arguments.admitted_package_input), "admitted package input"
    )
    admitted = exact_keys(
        admitted,
        {
            "candidate_package_input_sha256",
            "kind",
            "package_input",
            "schema",
            "validated_against_main",
        },
        "admitted package input",
    )
    if (
        admitted["schema"] != 1
        or admitted["kind"] != "kandelo-homebrew-admitted-candidate-package-input"
    ):
        fail("admitted package input has an unsupported contract")
    require_string(
        admitted["validated_against_main"], "package validation main commit", COMMIT
    )
    require_string(
        admitted["candidate_package_input_sha256"],
        "admitted candidate package input SHA-256",
        SHA256,
    )
    if (
        admitted["candidate_package_input_sha256"] != sha256_bytes(pretty_json(package_input))
        or admitted["package_input"] != package_input
    ):
        fail("admitted package generation does not contain the candidate archives")
    completed_run, _ = load_json(
        pathlib.Path(arguments.completed_run_evidence), "completed candidate run"
    )
    validate_completed_run(
        completed_run,
        manifest["run"],
        manifest["formula"]["name"],
        manifest["formula"]["arch"],
    )
    validate_merge(
        pathlib.Path(arguments.kandelo_root),
        manifest["source"],
        arguments.merge_commit,
        arguments.current_kandelo_main,
    )
    if admitted["validated_against_main"] != arguments.merge_commit:
        fail("package input was not admitted by the exact candidate merge")
    validate_tap_history(
        pathlib.Path(arguments.tap_root),
        manifest["source"],
        manifest["run"],
        arguments.current_tap_main,
    )
    if arguments.dependencies:
        dependencies, _ = load_json(
            pathlib.Path(arguments.dependencies), "activation dependencies"
        )
        if validate_dependencies(dependencies) != manifest["dependencies"]:
            fail("activation dependencies differ from the bottle candidate")
    elif manifest["dependencies"]:
        fail("activation omitted candidate dependencies")
    copy_materialized_assets(
        root,
        manifest,
        pathlib.Path(arguments.out_build_handoff),
        pathlib.Path(arguments.out_oci_child),
        pathlib.Path(arguments.out_package_input),
    )
    # Re-run the same structural cross-check after reconstruction.  The
    # protected workflow separately runs the complete handoff and Wasm
    # validators before exposing GHCR credentials.
    _build, reconstructed_receipt, _layout = validate_build_and_oci(
        pathlib.Path(arguments.out_build_handoff),
        pathlib.Path(arguments.out_oci_child),
        manifest["source"],
    )
    expected_formula = {
        "name": reconstructed_receipt["formula"],
        "arch": reconstructed_receipt["arch"],
        "pkg_version": reconstructed_receipt["pkg_version"],
        "formula_revision": reconstructed_receipt["formula_revision"],
        "bottle_rebuild": reconstructed_receipt["bottle_rebuild"],
        "formula_source_identity_sha256": reconstructed_receipt[
            "formula_source_identity_sha256"
        ],
        "formula_source_sha256": reconstructed_receipt["formula_source_sha256"],
        "source_closure_sha256": reconstructed_receipt["source_closure_sha256"],
    }
    if manifest["formula"] != expected_formula:
        fail("candidate Formula identity differs from its OCI receipt")
    validate_destination(manifest["destination"], reconstructed_receipt)
    receipt = {
        "schema": 1,
        "kind": "kandelo-homebrew-bottle-candidate-promotion",
        "candidate_tag": arguments.candidate_tag,
        "candidate_sha256": sha256_bytes(payload),
        "source": manifest["source"],
        "merge_commit": arguments.merge_commit,
        "validated_against_main": admitted["validated_against_main"],
        "run": manifest["run"],
        "formula": manifest["formula"],
        "package_input_sha256": package_record["sha256"],
        "admission_sha256": sha256_bytes(admitted_payload),
        "dependencies": manifest["dependencies"],
        "files": manifest["files"],
    }
    output = pathlib.Path(arguments.out_receipt)
    if output.exists() or output.is_symlink():
        fail("promotion receipt output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pretty_json(receipt))


def validate_promotion(arguments: argparse.Namespace) -> None:
    value, _ = load_json(
        pathlib.Path(arguments.receipt), "candidate promotion receipt"
    )
    value = exact_keys(
        value,
        {
            "admission_sha256",
            "candidate_sha256",
            "candidate_tag",
            "dependencies",
            "files",
            "formula",
            "kind",
            "merge_commit",
            "package_input_sha256",
            "run",
            "schema",
            "source",
            "validated_against_main",
        },
        "candidate promotion receipt",
    )
    if (
        value["schema"] != 1
        or value["kind"] != "kandelo-homebrew-bottle-candidate-promotion"
    ):
        fail("candidate promotion receipt has an unsupported contract")
    candidate_tag_value = require_string(
        value["candidate_tag"], "promoted candidate tag"
    )
    candidate_digest = require_string(
        value["candidate_sha256"], "promoted candidate SHA-256", SHA256
    )
    match = CANDIDATE_TAG.fullmatch(candidate_tag_value)
    if (
        match is None
        or candidate_tag_value != arguments.candidate_tag
        or match.group(4) != candidate_digest
    ):
        fail("candidate promotion receipt names another candidate")
    source = validate_source_evidence(value["source"])
    if (
        source["producer_commit"] != arguments.producer_commit
        or source["tap_commit"] != arguments.tap_commit
        or source["tap_checkout_commit"] != arguments.tap_checkout_commit
        or source["prefix_campaign_tag"] != arguments.campaign_tag
        or source["prefix_campaign_layout_sha256"]
        != arguments.campaign_layout_sha256
    ):
        fail("candidate promotion source differs from the publication plan")
    merge_commit = require_string(
        value["merge_commit"], "candidate promotion merge", COMMIT
    )
    if (
        merge_commit != arguments.merge_commit
        or value["validated_against_main"] != merge_commit
    ):
        fail("candidate promotion was not admitted by this exact merge")
    if validate_dependencies(value["dependencies"]):
        fail("candidate promotion v1 is restricted to leaf Formulae")
    formula = value["formula"]
    if (
        not isinstance(formula, dict)
        or formula.get("name") != arguments.formula
        or formula.get("arch") != arguments.arch
    ):
        fail("candidate promotion Formula differs from the publication plan")
    run = validate_run_evidence(
        value["run"], arguments.formula, arguments.arch
    )
    if (
        int(match.group(2)) != run["run_id"]
        or int(match.group(3)) != run["run_attempt"]
    ):
        fail("candidate promotion receipt names another workflow run")
    require_string(
        value["package_input_sha256"],
        "promoted package input SHA-256",
        SHA256,
    )
    package_path = regular_file(
        pathlib.Path(arguments.package_input),
        "promoted candidate package input",
        MAX_JSON_BYTES,
    )
    package_input, package_payload = load_json(
        package_path, "promoted candidate package input"
    )
    package_input = validate_package_input(package_input)
    if package_payload != pretty_json(package_input):
        fail("promoted candidate package input is not canonical JSON")
    if value["package_input_sha256"] != sha256_bytes(package_payload):
        fail("promoted candidate package input differs from its receipt")
    require_string(
        value["admission_sha256"],
        "promoted package admission SHA-256",
        SHA256,
    )
    _build, child, _layout = validate_build_and_oci(
        pathlib.Path(arguments.build_handoff),
        pathlib.Path(arguments.oci_child),
        source,
    )
    expected_formula = {
        "name": child["formula"],
        "arch": child["arch"],
        "pkg_version": child["pkg_version"],
        "formula_revision": child["formula_revision"],
        "bottle_rebuild": child["bottle_rebuild"],
        "formula_source_identity_sha256": child[
            "formula_source_identity_sha256"
        ],
        "formula_source_sha256": child["formula_source_sha256"],
        "source_closure_sha256": child["source_closure_sha256"],
    }
    if formula != expected_formula:
        fail("candidate promotion Formula differs from its exact OCI child")
    records = value["files"]
    if not isinstance(records, list):
        fail("candidate promotion file inventory is invalid")
    by_path: dict[str, dict[str, Any]] = {}
    for position, record in enumerate(records):
        record = exact_keys(
            record,
            {"asset_name", "bytes", "path", "sha256"},
            f"candidate promotion file #{position}",
        )
        logical = require_string(
            record["path"], "candidate promotion logical path", maximum=512
        )
        if logical in by_path:
            fail("candidate promotion file inventory repeats a path")
        require_int(record["bytes"], "candidate promotion file bytes", 1)
        require_string(
            record["sha256"], "candidate promotion file SHA-256", SHA256
        )
        by_path[logical] = record
    build_root = pathlib.Path(arguments.build_handoff)
    oci_root = pathlib.Path(arguments.oci_child)
    current_files = {
        **{
            f"build/{name}": build_root / name
            for name, _asset in BUILD_FILES
        },
        "oci/receipt.json": oci_root / "receipt.json",
        "oci/layout/oci-layout": oci_root / "layout/oci-layout",
        "oci/layout/index.json": oci_root / "layout/index.json",
        "package-input.json": package_path,
        **{
            f"oci/layout/blobs/sha256/{path.name}": path
            for path in (oci_root / "layout/blobs/sha256").iterdir()
        },
    }
    if set(current_files) != set(by_path):
        fail("candidate promotion receipt differs from the exact artifact files")
    for logical, current in current_files.items():
        record = by_path[logical]
        if (
            record["bytes"] != current.stat().st_size
            or record["sha256"] != sha256_file(current)
        ):
            fail(f"candidate promotion artifact {logical} changed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    describe_parser = commands.add_parser("describe-release")
    describe_parser.add_argument("--candidate", required=True)
    describe_parser.add_argument("--candidate-tag", required=True)
    describe_parser.add_argument("--out", required=True)

    source_parser = commands.add_parser("describe-source")
    source_parser.add_argument("--root", required=True)
    source_parser.add_argument("--producer-commit", required=True)
    source_parser.add_argument("--out", required=True)

    package_parser = commands.add_parser("package-input")
    package_parser.add_argument("--expected-ledger", required=True)
    package_parser.add_argument("--snapshot", required=True)
    package_parser.add_argument("--release-evidence", required=True)
    package_parser.add_argument("--index", required=True)
    package_parser.add_argument("--producer-commit", required=True)
    package_parser.add_argument("--abi", required=True, type=int)
    package_parser.add_argument("--out", required=True)

    admission_parser = commands.add_parser("admit-package-input")
    admission_parser.add_argument("--candidate-package-input", required=True)
    admission_parser.add_argument("--regenerated-package-input", required=True)
    admission_parser.add_argument("--validated-main-root", required=True)
    admission_parser.add_argument("--validated-main", required=True)
    admission_parser.add_argument("--producer-commit", required=True)
    admission_parser.add_argument("--out", required=True)

    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--source", required=True)
    prepare_parser.add_argument("--run-evidence", required=True)
    prepare_parser.add_argument("--destination", required=True)
    prepare_parser.add_argument("--dependencies", required=True)
    prepare_parser.add_argument("--package-input", required=True)
    prepare_parser.add_argument("--build-handoff", required=True)
    prepare_parser.add_argument("--oci-child", required=True)
    prepare_parser.add_argument("--out", required=True)

    materialize_parser = commands.add_parser("materialize")
    materialize_parser.add_argument("--candidate-root", required=True)
    materialize_parser.add_argument("--candidate-tag", required=True)
    materialize_parser.add_argument("--completed-run-evidence", required=True)
    materialize_parser.add_argument("--kandelo-root", required=True)
    materialize_parser.add_argument("--tap-root", required=True)
    materialize_parser.add_argument("--merge-commit", required=True)
    materialize_parser.add_argument("--current-kandelo-main", required=True)
    materialize_parser.add_argument("--current-tap-main", required=True)
    materialize_parser.add_argument("--admitted-package-input", required=True)
    materialize_parser.add_argument("--dependencies")
    materialize_parser.add_argument("--out-build-handoff", required=True)
    materialize_parser.add_argument("--out-oci-child", required=True)
    materialize_parser.add_argument("--out-package-input", required=True)
    materialize_parser.add_argument("--out-receipt", required=True)

    promotion_parser = commands.add_parser("validate-promotion")
    promotion_parser.add_argument("--receipt", required=True)
    promotion_parser.add_argument("--candidate-tag", required=True)
    promotion_parser.add_argument("--producer-commit", required=True)
    promotion_parser.add_argument("--merge-commit", required=True)
    promotion_parser.add_argument("--tap-commit", required=True)
    promotion_parser.add_argument("--tap-checkout-commit", required=True)
    promotion_parser.add_argument("--campaign-tag", required=True)
    promotion_parser.add_argument("--campaign-layout-sha256", required=True)
    promotion_parser.add_argument("--formula", required=True)
    promotion_parser.add_argument(
        "--arch", choices=("wasm32", "wasm64"), required=True
    )
    promotion_parser.add_argument("--build-handoff", required=True)
    promotion_parser.add_argument("--oci-child", required=True)
    promotion_parser.add_argument("--package-input", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "describe-release":
            describe_release(arguments)
        elif arguments.command == "describe-source":
            describe_source(arguments)
        elif arguments.command == "package-input":
            create_package_input(arguments)
        elif arguments.command == "admit-package-input":
            admit_package_input(arguments)
        elif arguments.command == "prepare":
            prepare(arguments)
        elif arguments.command == "materialize":
            materialize(arguments)
        else:
            validate_promotion(arguments)
    except (CandidateError, OSError, subprocess.SubprocessError) as error:
        print(f"homebrew-bottle-candidate: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
