#!/usr/bin/env python3
"""Seal, read, select, and compose prefix-campaign Formula handoffs."""

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
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
REPOSITORY = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$"
)
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
CAMPAIGN_TAG = re.compile(
    r"^homebrew-prefix-campaign-sha256-([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
SAFE_PATH = re.compile(
    r"^[A-Za-z0-9_.+-]+(?:/[A-Za-z0-9_.+-]+)*$"
)
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_FORMULAE = 256
MAX_VARIANTS = MAX_FORMULAE * 2
MAX_DEPENDENCIES = 256
MAX_RELEASE_ASSETS = 32
HTTP_TIMEOUT = 300
CAMPAIGN_COMMIT_TIMESTAMP = 946684800
CAMPAIGN_COMMIT_TIMEZONE = "+0000"
CAMPAIGN_COMMIT_NAME = "Kandelo Homebrew Campaign"
CAMPAIGN_COMMIT_EMAIL = "campaign@kandelo.invalid"
BUILD_PUBLICATION_FILES = (
    "build/bottle.json",
    "build/bottle.tar.gz",
    "build/dependency-provenance.json",
    "build/manifest.json",
    "composition/sidecars-input.json",
    "receipt.json",
)
REUSE_PUBLICATION_FILES = (
    "composition/sidecars-input.json",
    "reuse/bottle.json",
    "reuse/bottle.tar.gz",
    "reuse/evidence.json",
)
# Existing build fixtures import this name. Keep it as the build publication
# inventory while the handoff manifest discriminates build from reuse.
PUBLICATION_FILES = BUILD_PUBLICATION_FILES
HANDOFF_SCHEMA = 2
CAMPAIGN_COMPLETION_PATH = (
    "Kandelo/campaigns/prefix-v1/completion.json"
)
CAMPAIGN_RETIREMENT_PATHS = (
    ".github/workflows/prefix-campaign-bottles.yml",
    "Kandelo/prefix-campaign-authority.json",
    "Kandelo/campaigns/prefix-v1/manifest.json",
    "Kandelo/campaigns/prefix-v1/source",
)
# Only these reviewed campaign-control files may advance between the sealed
# source commit and final activation. Any other path could change a Formula,
# recipe, helper, dependency decision, or future package input that today's
# catalog validator does not yet know to inspect.
FINAL_TAP_ALLOWED_CONTROL_DRIFT_PATHS = frozenset(
    {
        ".github/workflows/prefix-campaign-bottles.yml",
        "Kandelo/README.md",
        "Kandelo/campaigns/prefix-v1/README.md",
        "Kandelo/prefix-campaign-authority.json",
        "Kandelo/test-workflow-trust.rb",
        "scripts/prefix-campaign-controller.py",
        "scripts/test_prefix_campaign_controller.py",
    }
)
SOURCE_AUTHORITY_PATH = "Kandelo/prefix-campaign-authority.json"
SOURCE_MANIFEST_PATH = "Kandelo/campaigns/prefix-v1/manifest.json"
SOURCE_MATERIALIZER_PATH = "scripts/prefix-campaign-source.py"
FINAL_TAP_COMMIT_MESSAGE = (
    "[Homebrew/Paths] Finalize the Kandelo guest prefix campaign\n\n"
    "Activate the complete /opt/kandelo/homebrew catalog atomically.\n"
    "Retire the one-shot campaign authority after validation.\n"
)


class ExecutorError(RuntimeError):
    """A fail-closed campaign handoff error."""


def fail(message: str) -> NoReturn:
    raise ExecutorError(message)


def duplicate_rejecting_object(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def pretty_json(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_keys(
    value: Any,
    expected: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(
    value: Any,
    label: str,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\0" in value
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        fail(f"{label} is invalid")
    return value


def require_int(
    value: Any,
    label: str,
    minimum: int = 0,
    maximum: int | None = None,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        fail(f"{label} is invalid")
    return value


def regular_file(
    path: pathlib.Path,
    label: str,
    maximum: int = MAX_JSON_BYTES,
) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size < 1
        or metadata.st_size > maximum
    ):
        fail(f"{label} must be one bounded regular non-symlink file")
    return path


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a real non-symlink directory")
    return path.resolve()


def run_git(
    root: pathlib.Path,
    arguments: list[str],
    label: str,
    *,
    maximum: int = MAX_JSON_BYTES,
    environment: dict[str, str] | None = None,
) -> bytes:
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=root,
            check=False,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot read {label}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(f"cannot read {label}: {detail}")
    if len(result.stdout) > maximum:
        fail(f"{label} exceeds its size bound")
    return result.stdout


def exact_git_checkout(
    root: pathlib.Path,
    commit: str,
    label: str,
) -> pathlib.Path:
    root = real_directory(root, label)
    commit = require_string(commit, f"{label} commit", COMMIT)
    top = run_git(root, ["rev-parse", "--show-toplevel"], label)
    try:
        top_path = pathlib.Path(top.decode("utf-8").strip()).resolve()
    except UnicodeDecodeError as error:
        fail(f"{label} Git root is not UTF-8: {error}")
    if top_path != root:
        fail(f"{label} is not the exact Git worktree root")
    head = run_git(root, ["rev-parse", "HEAD"], f"{label} HEAD")
    if head.decode("ascii", errors="strict").strip() != commit:
        fail(f"{label} does not name the campaign's exact commit")
    dirty = run_git(
        root,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        f"{label} cleanliness",
    )
    if dirty:
        fail(f"{label} worktree is dirty")
    return root


def anonymous_environment() -> dict[str, str]:
    environment = dict(os.environ)
    # WHY: a successful maintainer-authenticated read says nothing about
    # whether a Kandelo guest can consume the historical bottle. Keep every
    # supported GitHub/Homebrew credential out of the independent readback.
    for name in (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HOMEBREW_GITHUB_API_TOKEN",
        "HOMEBREW_GITHUB_PACKAGES_TOKEN",
        "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    ):
        environment.pop(name, None)
    return environment


def anonymous_bottle_readback(
    url: str,
    output: pathlib.Path,
    expected_bytes: int,
    expected_sha256: str,
) -> None:
    command = [
        # WHY: the publisher consumes an exact source snapshot without
        # node_modules. Node 24 can run this erasable-TypeScript verifier
        # directly, avoiding an ambient or downloaded execution dependency.
        "node",
        "--experimental-strip-types",
        str(ROOT / "scripts/homebrew-verify-public-bottle.ts"),
        "--url",
        url,
        "--sha256",
        expected_sha256,
        "--bytes",
        str(expected_bytes),
        "--out",
        str(output),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            env=anonymous_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot read historical bottle anonymously: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(f"cannot read historical bottle anonymously: {detail}")


def load_json_bytes(
    path: pathlib.Path,
    label: str,
    *,
    canonical: bool = True,
) -> tuple[Any, bytes]:
    payload = regular_file(path, label).read_bytes()
    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if canonical and payload != pretty_json(value):
        fail(f"{label} is not canonical pretty JSON")
    return value, payload


def safe_relative(value: Any, label: str) -> str:
    path = require_string(value, label, SAFE_PATH)
    if (
        pathlib.PurePosixPath(path).is_absolute()
        or any(part in (".", "..") for part in path.split("/"))
    ):
        fail(f"{label} is not a safe repository-relative path")
    return path


def regular_file_within(
    root: pathlib.Path,
    relative: Any,
    label: str,
    maximum: int = MAX_JSON_BYTES,
) -> pathlib.Path:
    root = real_directory(root, f"{label} root")
    relative = safe_relative(relative, f"{label} path")
    current = root
    for part in relative.split("/")[:-1]:
        current = current / part
        try:
            metadata = current.lstat()
        except OSError as error:
            fail(f"{label} parent is unavailable: {error}")
        if not stat.S_ISDIR(metadata.st_mode) or current.is_symlink():
            fail(f"{label} crosses an indirect parent")
    path = regular_file(root / relative, label, maximum)
    try:
        path.resolve().relative_to(root)
    except ValueError:
        fail(f"{label} escapes its authority root")
    return path


def resolved_candidate(path: pathlib.Path, label: str) -> pathlib.Path:
    candidate = path.resolve(strict=False)
    if path.exists() or path.is_symlink():
        fail(f"{label} already exists")
    parent = real_directory(path.parent, f"{label} parent")
    if candidate != parent / path.name:
        fail(f"{label} crosses an indirect parent")
    return candidate


def paths_overlap(left: pathlib.Path, right: pathlib.Path) -> bool:
    return (
        left == right
        or left in right.parents
        or right in left.parents
    )


def validate_new_output(
    output: pathlib.Path,
    label: str,
    inputs: Iterable[pathlib.Path],
) -> pathlib.Path:
    candidate = resolved_candidate(output, label)
    for input_path in inputs:
        resolved_input = input_path.resolve(strict=True)
        if paths_overlap(candidate, resolved_input):
            fail(f"{label} overlaps an input path")
    return candidate


def validate_output_pair(
    output: pathlib.Path,
    output_label: str,
    receipt: pathlib.Path,
    receipt_label: str,
    inputs: Iterable[pathlib.Path],
) -> tuple[pathlib.Path, pathlib.Path]:
    input_paths = tuple(inputs)
    if paths_overlap(
        output.resolve(strict=False),
        receipt.resolve(strict=False),
    ):
        fail(f"{output_label} and {receipt_label} overlap")
    output = validate_new_output(output, output_label, input_paths)
    receipt = validate_new_output(receipt, receipt_label, input_paths)
    if output.parent.stat().st_dev != receipt.parent.stat().st_dev:
        fail(f"{output_label} and {receipt_label} use different filesystems")
    return output, receipt


def private_destination(
    root: pathlib.Path,
    relative: str,
    label: str,
) -> pathlib.Path:
    root = real_directory(root, f"{label} root")
    relative = safe_relative(relative, label)
    destination = (root / relative).resolve(strict=False)
    try:
        destination.relative_to(root)
    except ValueError:
        fail(f"{label} escapes its private staging root")
    if destination.exists() or destination.is_symlink():
        fail(f"{label} repeats a staged path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.parent.resolve() != (root / relative).parent.resolve():
        fail(f"{label} crosses an indirect staging parent")
    return destination


def git_object_id(kind: str, payload: bytes) -> str:
    header = f"{kind} {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()


def deterministic_campaign_commit_oid(
    *,
    parent: str,
    tree: str,
    label: str,
) -> str:
    parent = require_string(parent, "campaign commit parent", COMMIT)
    tree = require_string(tree, "campaign commit tree", COMMIT)
    label = require_string(label, "campaign commit label")
    if "\n" in label or "\r" in label:
        fail("campaign commit label must fit on one line")
    identity = (
        f"{CAMPAIGN_COMMIT_NAME} <{CAMPAIGN_COMMIT_EMAIL}> "
        f"{CAMPAIGN_COMMIT_TIMESTAMP} {CAMPAIGN_COMMIT_TIMEZONE}"
    )
    message = (
        "Kandelo Homebrew campaign publisher snapshot\n\n"
        f"Purpose: {label}\n"
        f"Protected source: {parent}\n"
    )
    payload = (
        f"tree {tree}\n"
        f"parent {parent}\n"
        f"author {identity}\n"
        f"committer {identity}\n"
        "\n"
        f"{message}"
    ).encode("utf-8")
    return git_object_id("commit", payload)


def filesystem_git_tree_oid(root: pathlib.Path, label: str) -> str:
    root = real_directory(root, label)

    def visit(directory: pathlib.Path) -> bytes:
        entries: list[tuple[bytes, bytes]] = []
        for child in directory.iterdir():
            name = child.name.encode("utf-8")
            if b"\0" in name or b"/" in name:
                fail(f"{label} contains an unsafe name")
            metadata = child.lstat()
            if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
                payload = visit(child)
                # Git has no object for an empty directory. Omitting it here
                # keeps the filesystem-derived identity equal to write-tree.
                if not payload:
                    continue
                mode = b"40000"
                object_id = git_object_id("tree", payload)
                sort_key = name + b"/"
            elif stat.S_ISREG(metadata.st_mode) and not child.is_symlink():
                payload = child.read_bytes()
                mode = (
                    b"100755"
                    if metadata.st_mode
                    & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    else b"100644"
                )
                object_id = git_object_id("blob", payload)
                sort_key = name
            elif stat.S_ISLNK(metadata.st_mode):
                payload = os.readlink(child).encode("utf-8")
                mode = b"120000"
                object_id = git_object_id("blob", payload)
                sort_key = name
            else:
                fail(f"{label} contains a special file")
            entries.append(
                (
                    sort_key,
                    mode + b" " + name + b"\0" + bytes.fromhex(object_id),
                )
            )
        entries.sort(key=lambda item: item[0])
        return b"".join(entry for _key, entry in entries)

    return git_object_id("tree", visit(root))


def filesystem_git_leaf_inventory(
    root: pathlib.Path,
    label: str,
) -> dict[str, tuple[str, str]]:
    root = real_directory(root, label)
    result: dict[str, tuple[str, str]] = {}
    for child in root.rglob("*"):
        relative = child.relative_to(root).as_posix()
        metadata = child.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
            continue
        if stat.S_ISREG(metadata.st_mode) and not child.is_symlink():
            payload = child.read_bytes()
            mode = (
                "100755"
                if metadata.st_mode
                & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                else "100644"
            )
        elif stat.S_ISLNK(metadata.st_mode):
            payload = os.readlink(child).encode("utf-8")
            mode = "120000"
        else:
            fail(f"{label} contains a special file")
        result[relative] = (mode, git_object_id("blob", payload))
    return result


def source_tree_identity(authority: dict[str, Any]) -> str:
    source = authority.get("source_materialization")
    if not isinstance(source, dict):
        fail("campaign authority lacks source materialization")
    kind = source.get("kind")
    if kind == "sealed-target-overlay-v1":
        return require_string(
            source.get("target_tree_git_oid"),
            "campaign target source tree",
            COMMIT,
        )
    if kind == "exact-git-tree-v1":
        return require_string(
            source.get("tree_git_oid"),
            "campaign exact source tree",
            COMMIT,
        )
    fail("campaign source materialization kind is unsupported")


def git_snapshot(
    root: pathlib.Path,
    commit: str,
    destination: pathlib.Path,
    label: str,
) -> pathlib.Path:
    commit = require_string(commit, f"{label} commit", COMMIT)
    if destination.exists() or destination.is_symlink():
        fail(f"{label} snapshot output already exists")
    destination.mkdir(mode=0o700)
    archive_path = destination.with_suffix(".tar")
    try:
        result = subprocess.run(
            [
                "git",
                "archive",
                "--format=tar",
                f"--output={archive_path}",
                commit,
            ],
            cwd=root,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot snapshot {label}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[-16_384:]
        fail(f"cannot snapshot {label}: {detail}")
    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            archive.extractall(destination, filter="data")
    except (OSError, tarfile.TarError) as error:
        fail(f"cannot extract exact {label} snapshot: {error}")
    finally:
        archive_path.unlink(missing_ok=True)
    destination = real_directory(destination, f"{label} snapshot")
    expected_tree = run_git(
        root,
        ["rev-parse", f"{commit}^{{tree}}"],
        f"{label} Git tree",
    ).decode("ascii", errors="strict").strip()
    if filesystem_git_tree_oid(destination, label) != expected_tree:
        fail(f"{label} snapshot differs from its Git tree")
    return destination


def git_is_ancestor(
    root: pathlib.Path,
    ancestor: str,
    descendant: str,
    label: str,
) -> bool:
    try:
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=root,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot inspect {label}: {error}")
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    detail = result.stderr.decode("utf-8", errors="replace")[-16_384:]
    fail(f"cannot inspect {label}: {detail}")


def git_changed_paths(
    root: pathlib.Path,
    older: str,
    newer: str,
    label: str,
) -> tuple[str, ...]:
    payload = run_git(
        root,
        ["diff", "--name-only", "--no-renames", "-z", older, newer, "--"],
        label,
    )
    try:
        values = payload.decode("utf-8", errors="strict").split("\0")
    except UnicodeDecodeError as error:
        fail(f"{label} contains a non-UTF-8 path: {error}")
    if values[-1:] != [""]:
        fail(f"{label} is not NUL terminated")
    return tuple(
        safe_relative(value, f"{label} path") for value in values[:-1]
    )


def validate_overlay_file_record(value: Any, label: str) -> dict[str, Any]:
    record = exact_keys(
        value,
        {"blob_git_oid", "bytes", "mode", "sha256"},
        label,
    )
    require_string(record["blob_git_oid"], f"{label} Git blob", COMMIT)
    require_int(record["bytes"], f"{label} bytes")
    require_string(record["sha256"], f"{label} SHA-256", SHA256)
    if record["mode"] not in ("100644", "100755"):
        fail(f"{label} has an unsupported file mode")
    return record


def validate_overlay_file(
    root: pathlib.Path,
    relative: str,
    record: dict[str, Any],
    label: str,
) -> pathlib.Path:
    path = regular_file_within(root, relative, label)
    payload = path.read_bytes()
    mode = (
        "100755"
        if path.stat().st_mode
        & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        else "100644"
    )
    if (
        len(payload) != record["bytes"]
        or sha256_bytes(payload) != record["sha256"]
        or git_object_id("blob", payload) != record["blob_git_oid"]
        or mode != record["mode"]
    ):
        fail(f"{label} differs from its sealed identity")
    return path


def overlay_file_matches(
    root: pathlib.Path,
    relative: str,
    record: dict[str, Any],
    label: str,
) -> bool:
    path = regular_file_within(root, relative, label)
    payload = path.read_bytes()
    mode = (
        "100755"
        if path.stat().st_mode
        & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        else "100644"
    )
    return (
        len(payload) == record["bytes"]
        and sha256_bytes(payload) == record["sha256"]
        and git_object_id("blob", payload) == record["blob_git_oid"]
        and mode == record["mode"]
    )


def replay_overlay_files(
    *,
    tap_root: pathlib.Path,
    source_root: pathlib.Path,
    records: list[tuple[str, dict[str, Any] | None, dict[str, Any]]],
    label: str,
) -> None:
    tap_root = real_directory(tap_root, label)
    source_root = real_directory(source_root, f"{label} source")
    for relative, base_record, target_record in records:
        destination = tap_root / relative
        present = destination.exists() or destination.is_symlink()
        if not present:
            if base_record is not None:
                fail(f"{label} lacks a sealed preimage at {relative}")
        elif base_record is None:
            if not overlay_file_matches(
                tap_root,
                relative,
                target_record,
                f"{label} preimage {relative}",
            ):
                fail(
                    f"{label} expected an absent or target preimage "
                    f"at {relative}"
                )
        elif not overlay_file_matches(
            tap_root,
            relative,
            base_record,
            f"{label} preimage {relative}",
        ) and not overlay_file_matches(
            tap_root,
            relative,
            target_record,
            f"{label} preimage {relative}",
        ):
            fail(
                f"{label} expected a sealed base or target preimage "
                f"at {relative}"
            )
        source = validate_overlay_file(
            source_root,
            relative,
            target_record,
            f"{label} target {relative}",
        )
        parent = tap_root
        for part in relative.split("/")[:-1]:
            parent = parent / part
            if parent.exists() or parent.is_symlink():
                real_directory(parent, f"{label} parent {relative}")
            else:
                parent.mkdir()
        if destination.parent.resolve() != parent.resolve():
            fail(f"{label} destination crosses an indirect parent")
        shutil.copyfile(source, destination, follow_symlinks=False)
        destination.chmod(
            0o755 if target_record["mode"] == "100755" else 0o644
        )
        validate_overlay_file(
            tap_root,
            relative,
            target_record,
            f"{label} replayed target {relative}",
        )


def dependency_names(
    formula: dict[str, Any],
    tap_name: str,
) -> tuple[str, ...]:
    values = formula.get("dependencies")
    if not isinstance(values, list) or len(values) > MAX_DEPENDENCIES:
        fail(f"{formula.get('name')} dependencies are invalid")
    prefix = f"{tap_name}/"
    result: list[str] = []
    prior = ""
    for index, value in enumerate(values):
        value = exact_keys(
            value,
            {"full_name", "version"},
            f"{formula.get('name')} dependency #{index}",
        )
        full_name = require_string(
            value["full_name"],
            f"{formula.get('name')} dependency #{index} full_name",
        )
        if not full_name.startswith(prefix):
            fail("campaign dependency is not a same-tap Formula")
        name = full_name.removeprefix(prefix)
        require_string(name, "campaign dependency name", FORMULA)
        require_string(
            value["version"], "campaign dependency version", VERSION
        )
        if name <= prior:
            fail("campaign dependencies must be unique and sorted")
        prior = name
        result.append(name)
    return tuple(result)


def validate_destination_admission(formula: dict[str, Any]) -> None:
    name = formula.get("name")
    destination = exact_keys(
        formula.get("destination"),
        {"admission", "bottle_rebuild", "reference", "remote"},
        f"campaign Formula {name} destination",
    )
    require_int(
        destination["bottle_rebuild"],
        f"campaign Formula {name} destination rebuild",
    )
    require_string(
        destination["reference"],
        f"campaign Formula {name} destination reference",
    )
    require_string(
        destination["remote"],
        f"campaign Formula {name} destination remote",
    )
    admission = exact_keys(
        destination["admission"],
        {"kind", "method", "probe", "schema"},
        f"campaign Formula {name} destination admission",
    )
    if (
        admission["schema"] != 1
        or admission["method"] != "anonymous-oras-manifest-probe"
    ):
        fail(f"campaign Formula {name} destination admission is invalid")
    probe = exact_keys(
        admission["probe"],
        {"digest", "kind", "schema", "status"},
        f"campaign Formula {name} destination probe",
    )
    if probe["schema"] != 1 or probe["kind"] != "manifest":
        fail(f"campaign Formula {name} destination probe is invalid")
    kind = admission["kind"]
    if kind == "anonymous-absence":
        if probe["status"] != "missing" or probe["digest"] is not None:
            fail(
                f"campaign Formula {name} anonymous absence is invalid"
            )
        return
    if kind != "first-package-namespace-bootstrap-required":
        fail(f"campaign Formula {name} destination admission is invalid")
    if probe["status"] != "auth-required" or probe["digest"] is not None:
        fail(f"campaign Formula {name} namespace bootstrap probe is invalid")

    variants = formula.get("variants")
    # WHY: an anonymous authentication challenge is ambiguous between a new
    # namespace and a private existing package. Only source reviewed as a new
    # required-build entrant may reach the later authenticated bootstrap gate.
    eligible = (
        formula.get("source_kind") == "reviewed-new-entrant"
        and isinstance(variants, list)
        and bool(variants)
        and all(
            isinstance(variant, dict)
            and variant.get("selected_by") == "reviewed-campaign-input"
            and isinstance(variant.get("build_input"), dict)
            and isinstance(variant.get("disposition"), dict)
            and variant["disposition"].get("kind") == "required-build"
            and variant["disposition"].get("reasons")
            == ["new-campaign-entrant"]
            and "old_record" not in variant
            for variant in variants
        )
    )
    if not eligible:
        fail(
            f"campaign Formula {name} is not eligible for first-package "
            "namespace bootstrap"
        )


def load_campaign(
    path: pathlib.Path,
) -> tuple[dict[str, Any], bytes, dict[str, dict[str, Any]]]:
    value, payload = load_json_bytes(path, "campaign manifest")
    if (
        not isinstance(value, dict)
        or value.get("schema") != 2
        or value.get("kind")
        != "kandelo-homebrew-guest-prefix-campaign"
    ):
        fail("campaign manifest has an unsupported contract")
    authority = value.get("authority")
    if not isinstance(authority, dict):
        fail("campaign manifest lacks authority")
    require_string(
        authority.get("kandelo_commit"),
        "campaign Kandelo commit",
        COMMIT,
    )
    require_string(
        authority.get("source_tap_commit"),
        "campaign source tap commit",
        COMMIT,
    )
    require_string(
        authority.get("tap_repository"),
        "campaign tap repository",
        REPOSITORY,
    )
    tap_name = require_string(
        authority.get("tap_name"),
        "campaign tap name",
        REPOSITORY,
    )
    source_tree_identity(authority)
    formulae = value.get("formulae")
    if (
        not isinstance(formulae, list)
        or not formulae
        or len(formulae) > MAX_FORMULAE
    ):
        fail("campaign Formula inventory is invalid")
    index: dict[str, dict[str, Any]] = {}
    prior = ""
    for position, formula in enumerate(formulae):
        if not isinstance(formula, dict):
            fail(f"campaign Formula #{position} must be an object")
        name = require_string(
            formula.get("name"),
            f"campaign Formula #{position} name",
            FORMULA,
        )
        require_string(
            formula.get("version"),
            f"campaign Formula {name} version",
            VERSION,
        )
        if name <= prior:
            fail("campaign Formulae must be unique and sorted")
        prior = name
        dependency_names(formula, tap_name)
        variants = formula.get("variants")
        variant_arches = (
            [
                variant.get("arch")
                for variant in variants
                if isinstance(variant, dict)
            ]
            if isinstance(variants, list)
            else []
        )
        if (
            not variants
            or len(variant_arches) != len(variants)
            or any(not isinstance(arch, str) for arch in variant_arches)
            or variant_arches != sorted(set(variant_arches))
            or any(
                arch not in ("wasm32", "wasm64")
                for arch in variant_arches
            )
        ):
            fail(f"campaign Formula {name} variants are invalid")
        validate_destination_admission(formula)
        index[name] = formula
    for name, formula in index.items():
        dependencies = dependency_names(formula, tap_name)
        missing = sorted(set(dependencies) - set(index))
        if missing:
            fail(f"campaign Formula {name} has missing dependencies {missing}")
        for dependency, edge in zip(
            dependencies, formula["dependencies"], strict=True
        ):
            if edge["version"] != index[dependency]["version"]:
                fail(
                    f"campaign Formula {name} dependency {dependency} "
                    "version differs from its Formula"
                )
    return value, payload, index


def dependency_closure(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
) -> tuple[str, ...]:
    tap_name = campaign["authority"]["tap_name"]
    reached: set[str] = set()
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"campaign dependency graph cycles at {name}")
        if name in reached:
            return
        if name not in index:
            fail(f"campaign dependency {name} is missing")
        visiting.add(name)
        for dependency in dependency_names(index[name], tap_name):
            visit(dependency)
        visiting.remove(name)
        reached.add(name)

    for name in dependency_names(index[formula_name], tap_name):
        visit(name)
    return tuple(sorted(reached))


def validate_source_root(
    root: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> pathlib.Path:
    root = real_directory(root, "campaign target source")
    expected_tree = source_tree_identity(campaign["authority"])
    if (
        filesystem_git_tree_oid(root, "campaign target source")
        != expected_tree
    ):
        fail("campaign target source differs from its sealed Git tree")
    validate_source_formula(root, formula)
    return root


def validate_source_formula(
    root: pathlib.Path,
    formula: dict[str, Any],
) -> None:
    name = formula["name"]
    source = exact_keys(
        formula.get("formula_source"),
        {"identity_excluding_bottle_sha256", "path", "sha256"},
        f"{name} Formula source",
    )
    if source["path"] != f"Formula/{name}.rb":
        fail(f"{name} Formula source path is not canonical")
    formula_path = regular_file(
        root / source["path"],
        f"{name} target Formula",
        1024 * 1024,
    )
    if sha256_file(formula_path) != require_string(
        source["sha256"], f"{name} Formula SHA-256", SHA256
    ):
        fail(f"{name} target Formula differs from the campaign")


def walk_regular_files(root: pathlib.Path, label: str) -> list[str]:
    root = real_directory(root, label)
    result: list[str] = []
    for path in root.rglob("*"):
        metadata = path.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not path.is_symlink():
            continue
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            fail(f"{label} contains a symlink or special file")
        result.append(path.relative_to(root).as_posix())
    return sorted(result)


def copy_verified(
    source: pathlib.Path,
    destination: pathlib.Path,
    *,
    expected_bytes: int | None = None,
    expected_sha256: str | None = None,
) -> tuple[int, str]:
    metadata = regular_file(
        source,
        f"input file {source}",
        MAX_ASSET_BYTES,
    ).stat()
    if expected_bytes is not None and metadata.st_size != expected_bytes:
        fail(f"{source} byte count differs from its manifest")
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    copied = 0
    with source.open("rb") as input_file, destination.open("xb") as output:
        while chunk := input_file.read(1024 * 1024):
            copied += len(chunk)
            digest.update(chunk)
            output.write(chunk)
    actual = digest.hexdigest()
    if expected_sha256 is not None and actual != expected_sha256:
        fail(f"{source} SHA-256 differs from its manifest")
    return copied, actual


def handoff_publication(
    handoff: dict[str, Any],
    arch: str,
    label: str,
) -> dict[str, Any]:
    publication = next(
        (
            value
            for value in handoff["publications"]
            if value["arch"] == arch
        ),
        None,
    )
    if publication is None:
        fail(f"{label} has no {arch} campaign publication")
    return publication


def publication_kind(publication: dict[str, Any], label: str) -> str:
    kind = require_string(publication.get("kind"), f"{label} kind")
    if kind not in ("build", "reuse"):
        fail(f"{label} kind is unsupported")
    return kind


def publication_files(kind: str) -> tuple[str, ...]:
    if kind == "build":
        return BUILD_PUBLICATION_FILES
    if kind == "reuse":
        return REUSE_PUBLICATION_FILES
    fail("publication kind is unsupported")


def publication_semantic_path(
    publication: dict[str, Any],
    semantic: str,
    label: str,
) -> str:
    paths = {
        "build": {
            "bottle_json": "build/bottle.json",
            "bottle_archive": "build/bottle.tar.gz",
            "sidecars_input": "composition/sidecars-input.json",
        },
        "reuse": {
            "bottle_json": "reuse/bottle.json",
            "bottle_archive": "reuse/bottle.tar.gz",
            "sidecars_input": "composition/sidecars-input.json",
        },
    }
    kind = publication_kind(publication, label)
    if semantic not in paths[kind]:
        fail(f"{label} lacks semantic file {semantic}")
    return paths[kind][semantic]


def handoff_publication_file(
    publication: dict[str, Any],
    path: str,
    label: str,
) -> dict[str, Any]:
    record = next(
        (
            value
            for value in publication["files"]
            if value["path"] == path
        ),
        None,
    )
    if record is None:
        fail(f"{label} lacks {path}")
    return record


def validate_dependency_bottle_input(
    *,
    bottle_json: pathlib.Path,
    handoff: dict[str, Any],
    arch: str,
    archive_record: dict[str, Any],
    campaign: dict[str, Any],
) -> tuple[dict[str, Any], str, str, str]:
    name = handoff["formula"]["name"]
    value, _payload = load_json_bytes(
        bottle_json,
        f"{name}/{arch} dependency bottle JSON",
        canonical=False,
    )
    authority = campaign["authority"]
    tap_name = authority["tap_name"]
    formula_key = f"{tap_name}/{name}"
    if (
        not isinstance(value, dict)
        or set(value) != {formula_key}
        or not isinstance(value[formula_key], dict)
    ):
        fail(f"{name}/{arch} bottle JSON has the wrong Formula identity")
    formula_record = value[formula_key].get("formula")
    bottle = value[formula_key].get("bottle")
    if not isinstance(formula_record, dict) or not isinstance(bottle, dict):
        fail(f"{name}/{arch} bottle JSON lacks bottle metadata")
    expected_path = (
        f"Library/Taps/{tap_name.split('/', 1)[0]}/"
        f"homebrew-{tap_name.split('/', 1)[1]}/Formula/{name}.rb"
    )
    rebuild = bottle.get("rebuild")
    if (
        formula_record.get("name") != name
        or formula_record.get("path") != expected_path
        or formula_record.get("pkg_version")
        != handoff["formula"]["version"]
        or not isinstance(rebuild, int)
        or isinstance(rebuild, bool)
        or rebuild != handoff["formula"]["bottle_rebuild"]
    ):
        fail(f"{name}/{arch} bottle identity differs from its handoff")
    tag = f"{arch}_kandelo"
    tags = bottle.get("tags")
    if (
        not isinstance(tags, dict)
        or set(tags) != {tag}
        or not isinstance(tags[tag], dict)
        or "sha256" not in tags[tag]
    ):
        fail(f"{name}/{arch} bottle JSON has the wrong architecture")
    digest = require_string(
        tags[tag]["sha256"],
        f"{name}/{arch} bottle digest",
        SHA256,
    )
    if digest != archive_record["sha256"]:
        fail(f"{name}/{arch} bottle JSON digest differs from its archive")
    root_url = require_string(
        bottle.get("root_url"),
        f"{name}/{arch} bottle root URL",
    )
    expected_root = (
        "https://ghcr.io/v2/"
        f"{authority['tap_repository'].lower()}"
    )
    if root_url != expected_root:
        fail(f"{name}/{arch} bottle root URL is not the campaign registry")
    cellar = require_string(
        bottle.get("cellar"),
        f"{name}/{arch} bottle cellar",
    )
    if cellar != "/opt/kandelo/homebrew/Cellar":
        fail(f"{name}/{arch} bottle cellar is not the Kandelo prefix")
    canonical = {
        name: {
            "bottle": {
                "cellar": cellar,
                "rebuild": rebuild,
                "root_url": root_url,
                "tags": {tag: {"sha256": digest}},
            },
            "formula": {
                "name": name,
                "path": expected_path,
                "pkg_version": formula_record["pkg_version"],
            },
        }
    }
    return canonical, digest, root_url, cellar


def default_dependency_bottle_merger(
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
    authority = campaign["authority"]
    command = [
        "bash",
        str(ROOT / "scripts/homebrew-merge-bottle-json.sh"),
        "--tap-root",
        str(tap_root),
        "--tap-repository",
        authority["tap_repository"],
        "--tap-name",
        authority["tap_name"],
        "--formula",
        formula,
        "--arch",
        arch,
        "--release-tag",
        f"bottles-abi-v{authority['current_kandelo_abi']}",
        "--bottle-json",
        str(bottle_json),
        "--expected-sha256",
        sha256,
        "--expected-root-url",
        root_url,
        "--expected-cellar",
        cellar,
    ]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot compose dependency bottle for {formula}/{arch}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(
            f"cannot compose dependency bottle for "
            f"{formula}/{arch}: {detail}"
        )


def campaign_formula_evidence(
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> dict[str, Any]:
    destination = formula.get("destination")
    if not isinstance(destination, dict):
        fail(f"{formula.get('name')} lacks campaign destination")
    return {
        "bottle_rebuild": require_int(
            destination.get("bottle_rebuild"),
            f"{formula.get('name')} bottle rebuild",
        ),
        "dependencies": formula["dependencies"],
        "formula_sha256": require_string(
            formula["formula_source"].get("sha256"),
            f"{formula.get('name')} Formula SHA-256",
            SHA256,
        ),
        "name": formula["name"],
        "version": formula["version"],
    }


def campaign_variant(
    formula: dict[str, Any],
    arch: str,
) -> dict[str, Any]:
    matches = [
        value
        for value in formula.get("variants", [])
        if isinstance(value, dict) and value.get("arch") == arch
    ]
    if len(matches) != 1:
        fail(f"{formula.get('name')}/{arch} is not one campaign variant")
    return matches[0]


def campaign_guest_layout(campaign: dict[str, Any]) -> dict[str, Any]:
    authority = campaign["authority"]
    record = exact_keys(
        authority.get("guest_layout"),
        {"path", "sha256"},
        "campaign guest layout",
    )
    relative = safe_relative(record["path"], "campaign guest layout path")
    if relative != "homebrew/kandelo-guest-layout.json":
        fail("campaign guest layout path is not canonical")
    path = regular_file_within(
        ROOT,
        relative,
        "campaign guest layout",
    )
    digest = require_string(
        record["sha256"], "campaign guest layout SHA-256", SHA256
    )
    if sha256_file(path) != digest:
        fail("campaign guest layout differs from the executor checkout")
    layout, _payload = load_json_bytes(
        path, "campaign guest layout", canonical=False
    )
    layout = exact_keys(
        layout,
        {
            "cellar",
            "kind",
            "prefix",
            "repository",
            "retired_prefixes",
            "schema",
            "stable_entrypoint",
        },
        "campaign guest layout",
    )
    if (
        layout["schema"] != 1
        or layout["kind"] != "kandelo-homebrew-guest-layout"
    ):
        fail("campaign guest layout has an unsupported contract")
    for key in ("cellar", "prefix", "repository", "stable_entrypoint"):
        value = require_string(layout[key], f"guest layout {key}")
        if not value.startswith("/") or "\0" in value:
            fail(f"guest layout {key} is not an absolute guest path")
    if layout["cellar"] != f"{layout['prefix']}/Cellar":
        fail("campaign guest layout cellar is not under its prefix")
    retired = layout["retired_prefixes"]
    if (
        not isinstance(retired, list)
        or not retired
        or retired != sorted(set(retired))
        or any(
            not isinstance(value, str)
            or not value.startswith("/")
            or value == layout["prefix"]
            for value in retired
        )
    ):
        fail("campaign guest layout retired prefixes are invalid")
    return layout


def validate_built_from_record(
    value: Any,
    label: str,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "formula_sha256",
            "kandelo_commit",
            "kandelo_repository",
            "tap_commit",
            "tap_repository",
        },
        label,
    )
    require_string(value["formula_sha256"], f"{label} Formula SHA-256", SHA256)
    for key in ("kandelo_commit", "tap_commit"):
        require_string(value[key], f"{label} {key}", COMMIT)
    for key in ("kandelo_repository", "tap_repository"):
        require_string(value[key], f"{label} {key}", REPOSITORY)
    return value


def validate_reuse_variant(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
) -> dict[str, Any]:
    name = formula["name"]
    variant = exact_keys(
        campaign_variant(formula, arch),
        {
            "anonymous_readback",
            "arch",
            "disposition",
            "inspection",
            "old_formula_source",
            "old_record",
            "old_record_sha256",
            "provenance",
            "selected_by",
            "sidecars",
        },
        f"{name}/{arch} reuse variant",
    )
    disposition = exact_keys(
        variant["disposition"],
        {"kind", "reasons"},
        f"{name}/{arch} disposition",
    )
    if (
        disposition["kind"] != "byte-clean-reuse-candidate"
        or disposition["reasons"] != []
    ):
        fail(f"{name}/{arch} is not admitted for byte-clean reuse")
    if variant["arch"] != arch:
        fail(f"{name}/{arch} reuse variant has another architecture")

    old_record = variant["old_record"]
    required = {
        "arch",
        "bottle_tag",
        "browser_compatible",
        "built_at",
        "built_by",
        "built_from",
        "bytes",
        "cache_key_sha",
        "cellar",
        "fork_instrumentation",
        "kandelo_abi",
        "link_manifest",
        "prefix",
        "runtime_support",
        "sha256",
        "status",
        "url",
    }
    if (
        not isinstance(old_record, dict)
        or not required <= set(old_record)
        or not set(old_record) <= required | {"queued_at"}
    ):
        fail(f"{name}/{arch} old bottle record is ambiguous")
    digest = require_string(
        old_record["sha256"], f"{name}/{arch} bottle SHA-256", SHA256
    )
    byte_count = require_int(
        old_record["bytes"],
        f"{name}/{arch} bottle bytes",
        1,
        MAX_ASSET_BYTES,
    )
    authority = campaign["authority"]
    expected_url = (
        "https://ghcr.io/v2/"
        f"{authority['tap_repository'].lower()}/{name}/"
        f"blobs/sha256:{digest}"
    )
    if (
        old_record["status"] != "success"
        or old_record["arch"] != arch
        or old_record["bottle_tag"] != f"{arch}_kandelo"
        or old_record["kandelo_abi"]
        != authority["current_kandelo_abi"]
        or old_record["cache_key_sha"] != digest
        or old_record["url"] != expected_url
        or not isinstance(old_record["browser_compatible"], bool)
        or not isinstance(old_record["runtime_support"], list)
    ):
        fail(f"{name}/{arch} old bottle identity is invalid")
    if old_record["fork_instrumentation"] not in (
        "disabled",
        "not-required",
        "required",
        "unknown",
    ):
        fail(f"{name}/{arch} fork instrumentation is invalid")
    require_string(old_record["built_at"], f"{name}/{arch} built_at")
    built_by = require_string(
        old_record["built_by"], f"{name}/{arch} built_by"
    )
    if not built_by.startswith("https://"):
        fail(f"{name}/{arch} built_by is not an HTTPS identity")
    built_from = validate_built_from_record(
        old_record["built_from"], f"{name}/{arch} built_from"
    )
    if built_from["tap_repository"].lower() != authority[
        "tap_repository"
    ].lower():
        fail(f"{name}/{arch} historical tap repository is substituted")
    layout = campaign_guest_layout(campaign)
    if (
        old_record["prefix"] == layout["prefix"]
        or old_record["prefix"] not in layout["retired_prefixes"]
        or old_record["cellar"] != f"{old_record['prefix']}/Cellar"
    ):
        fail(f"{name}/{arch} old bottle has no retired layout identity")
    if sha256_bytes(canonical_json(old_record)) != require_string(
        variant["old_record_sha256"],
        f"{name}/{arch} old record SHA-256",
        SHA256,
    ):
        fail(f"{name}/{arch} old record differs from its campaign digest")

    anonymous = exact_keys(
        variant["anonymous_readback"],
        {"bytes", "sha256", "url"},
        f"{name}/{arch} anonymous readback",
    )
    if anonymous != {
        "bytes": byte_count,
        "sha256": digest,
        "url": expected_url,
    }:
        fail(f"{name}/{arch} anonymous readback differs from the bottle")
    inspection = exact_keys(
        variant["inspection"],
        {
            "file_count",
            "fork_instrumentation",
            "formula_sha256",
            "result_sha256",
            "retired_prefixes",
            "scan",
        },
        f"{name}/{arch} inspection",
    )
    require_string(
        inspection["result_sha256"],
        f"{name}/{arch} inspection SHA-256",
        SHA256,
    )
    if (
        require_int(
            inspection["file_count"],
            f"{name}/{arch} inspected file count",
            1,
        )
        < 1
        or inspection["fork_instrumentation"]
        != old_record["fork_instrumentation"]
        or inspection["formula_sha256"]
        != built_from["formula_sha256"]
        or inspection["retired_prefixes"] != []
        or inspection["scan"] != "all-regular-members"
    ):
        fail(f"{name}/{arch} inspection does not admit byte-clean reuse")
    old_source = exact_keys(
        variant["old_formula_source"],
        {"commit", "identity_excluding_bottle_sha256", "path", "sha256"},
        f"{name}/{arch} old Formula source",
    )
    if (
        old_source["path"] != f"Formula/{name}.rb"
        or old_source["commit"] != built_from["tap_commit"]
        or old_source["identity_excluding_bottle_sha256"]
        != formula["formula_source"]["identity_excluding_bottle_sha256"]
    ):
        fail(f"{name}/{arch} old Formula source is substituted")
    require_string(
        old_source["sha256"],
        f"{name}/{arch} old Formula SHA-256",
        SHA256,
    )
    sidecars = exact_keys(
        variant["sidecars"],
        {"formula", "link"},
        f"{name}/{arch} sidecars",
    )
    for label, value in (
        ("provenance", variant["provenance"]),
        ("Formula sidecar", sidecars["formula"]),
        ("link sidecar", sidecars["link"]),
    ):
        record = exact_keys(
            value,
            {"path", "sha256"},
            f"{name}/{arch} {label}",
        )
        safe_relative(record["path"], f"{name}/{arch} {label} path")
        require_string(
            record["sha256"],
            f"{name}/{arch} {label} SHA-256",
            SHA256,
        )
    return variant


def load_digest_bound_json(
    root: pathlib.Path,
    record: dict[str, Any],
    label: str,
) -> tuple[dict[str, Any], bytes]:
    path = regular_file_within(root, record["path"], label)
    payload = path.read_bytes()
    if sha256_bytes(payload) != record["sha256"]:
        fail(f"{label} differs from its campaign digest")
    value, loaded_payload = load_json_bytes(path, label, canonical=False)
    if not isinstance(value, dict) or loaded_payload != payload:
        fail(f"{label} is not a JSON object")
    return value, payload


def normalized_provenance_sha256(value: dict[str, Any]) -> str:
    normalized = json.loads(canonical_json(value))
    metadata = normalized.get("metadata")
    if not isinstance(metadata, dict):
        fail("historical provenance lacks metadata")
    record = metadata.get("provenance_json")
    if not isinstance(record, dict) or "sha256" not in record:
        fail("historical provenance lacks its self-hash")
    record["sha256"] = "0" * 64
    return sha256_bytes(pretty_json(normalized))


def historical_reuse_inputs(
    *,
    campaign: dict[str, Any],
    formula: dict[str, Any],
    variant: dict[str, Any],
    arch: str,
    old_tap_root: pathlib.Path,
) -> dict[str, Any]:
    name = formula["name"]
    old_record = variant["old_record"]
    sidecars = variant["sidecars"]
    formula_sidecar, _formula_payload = load_digest_bound_json(
        old_tap_root,
        sidecars["formula"],
        f"{name}/{arch} historical Formula sidecar",
    )
    formula_sidecar = exact_keys(
        formula_sidecar,
        {
            "bottle_rebuild",
            "bottles",
            "dependencies",
            "formula_path",
            "formula_revision",
            "full_name",
            "kandelo_abi",
            "name",
            "schema",
            "source_metadata",
            "tap_commit",
            "tap_name",
            "tap_repository",
            "version",
        },
        f"{name}/{arch} historical Formula sidecar",
    )
    expected_dependencies = formula["dependencies"]
    sidecar_dependencies: list[dict[str, str]] = []
    raw_dependencies = formula_sidecar["dependencies"]
    if not isinstance(raw_dependencies, list):
        fail(f"{name}/{arch} historical dependencies are invalid")
    for index, value in enumerate(raw_dependencies):
        value = exact_keys(
            value,
            {"full_name", "name", "version"},
            f"{name}/{arch} historical dependency #{index}",
        )
        if value["full_name"] != (
            f"{campaign['authority']['tap_name']}/{value['name']}"
        ):
            fail(f"{name}/{arch} historical dependency is ambiguous")
        sidecar_dependencies.append(
            {"full_name": value["full_name"], "version": value["version"]}
        )
    bottles = formula_sidecar["bottles"]
    if not isinstance(bottles, list):
        fail(f"{name}/{arch} historical bottle inventory is invalid")
    matching = [
        value
        for value in bottles
        if isinstance(value, dict) and value.get("arch") == arch
    ]
    if (
        formula_sidecar["schema"] != 1
        or formula_sidecar["name"] != name
        or formula_sidecar["full_name"]
        != f"{campaign['authority']['tap_name']}/{name}"
        or formula_sidecar["version"] != formula["version"]
        or formula_sidecar["formula_path"] != f"Formula/{name}.rb"
        or formula_sidecar["kandelo_abi"]
        != campaign["authority"]["current_kandelo_abi"]
        or formula_sidecar["tap_name"]
        != campaign["authority"]["tap_name"]
        or formula_sidecar["tap_repository"].lower()
        != campaign["authority"]["tap_repository"].lower()
        or formula_sidecar["source_metadata"] != "Kandelo/metadata.json"
        or sidecar_dependencies != expected_dependencies
        or len(matching) != 1
        or matching[0] != old_record
    ):
        fail(f"{name}/{arch} historical Formula sidecar is substituted")
    historical_rebuild = require_int(
        formula_sidecar["bottle_rebuild"],
        f"{name}/{arch} historical bottle rebuild",
    )
    if (
        require_int(
            formula["destination"]["bottle_rebuild"],
            f"{name}/{arch} destination bottle rebuild",
        )
        <= historical_rebuild
    ):
        fail(f"{name}/{arch} reuse destination does not advance rebuild")
    formula_revision = require_int(
        formula_sidecar["formula_revision"],
        f"{name}/{arch} Formula revision",
    )
    require_string(
        formula_sidecar["tap_commit"],
        f"{name}/{arch} Formula sidecar tap commit",
        COMMIT,
    )

    link, _link_payload = load_digest_bound_json(
        old_tap_root,
        sidecars["link"],
        f"{name}/{arch} historical link sidecar",
    )
    link = exact_keys(
        link,
        {
            "arch",
            "bottle",
            "cellar",
            "env",
            "kandelo_abi",
            "keg",
            "links",
            "package",
            "prefix",
            "receipts",
            "schema",
            "version",
        },
        f"{name}/{arch} historical link sidecar",
    )
    link_bottle = exact_keys(
        link["bottle"],
        {"bytes", "cache_key_sha", "payload_root", "sha256", "url"},
        f"{name}/{arch} historical link bottle",
    )
    if (
        link["schema"] != 1
        or link["package"] != name
        or link["version"] != formula["version"]
        or link["arch"] != arch
        or link["kandelo_abi"] != old_record["kandelo_abi"]
        or link["prefix"] != old_record["prefix"]
        or link["cellar"] != old_record["cellar"]
        or link_bottle
        != {
            "bytes": old_record["bytes"],
            "cache_key_sha": old_record["cache_key_sha"],
            "payload_root": f"{name}/{formula['version']}",
            "sha256": old_record["sha256"],
            "url": old_record["url"],
        }
        or old_record["link_manifest"]
        != (
            f"Kandelo/link/{name}-{formula['version']}-"
            f"rebuild{historical_rebuild}-{arch}.json"
        )
        or old_record["link_manifest"] != sidecars["link"]["path"]
    ):
        fail(f"{name}/{arch} historical link sidecar is substituted")
    if not isinstance(link["links"], list) or not isinstance(
        link["receipts"], list
    ):
        fail(f"{name}/{arch} historical link inventory is invalid")

    provenance, _provenance_payload = load_digest_bound_json(
        old_tap_root,
        variant["provenance"],
        f"{name}/{arch} historical provenance",
    )
    provenance = exact_keys(
        provenance,
        {
            "bottle",
            "build",
            "formula",
            "metadata",
            "repositories",
            "schema",
            "subject",
            "validation",
        },
        f"{name}/{arch} historical provenance",
    )
    subject = exact_keys(
        provenance["subject"],
        {"arch", "bottle_rebuild", "kandelo_abi", "package", "version"},
        f"{name}/{arch} historical provenance subject",
    )
    provenance_formula = exact_keys(
        provenance["formula"],
        {"path", "sha256"},
        f"{name}/{arch} historical provenance Formula",
    )
    provenance_bottle = exact_keys(
        provenance["bottle"],
        {
            "bottle_tag",
            "bytes",
            "cache_key_sha",
            "cellar",
            "prefix",
            "sha256",
            "url",
        },
        f"{name}/{arch} historical provenance bottle",
    )
    expected_provenance_bottle = {
        key: old_record[key]
        for key in (
            "bottle_tag",
            "bytes",
            "cache_key_sha",
            "cellar",
            "prefix",
            "sha256",
            "url",
        )
    }
    expected_repositories = {
        key: old_record["built_from"][key]
        for key in (
            "kandelo_repository",
            "kandelo_commit",
            "tap_repository",
            "tap_commit",
        )
    }
    if (
        provenance["schema"] != 1
        or subject
        != {
            "arch": arch,
            "bottle_rebuild": historical_rebuild,
            "kandelo_abi": old_record["kandelo_abi"],
            "package": name,
            "version": formula["version"],
        }
        or provenance["repositories"] != expected_repositories
        or provenance_formula
        != {
            "path": f"Formula/{name}.rb",
            "sha256": old_record["built_from"]["formula_sha256"],
        }
        or provenance_bottle != expected_provenance_bottle
        or variant["provenance"]["path"]
        != (
            f"Kandelo/reports/{name}-{formula['version']}-"
            f"rebuild{historical_rebuild}-{arch}.provenance.json"
        )
    ):
        fail(f"{name}/{arch} historical provenance is substituted")
    build = exact_keys(
        provenance["build"],
        {
            "brew_version",
            "dev_shell",
            "github_run",
            "job",
            "runner_os",
            "sdk_fingerprint",
            "sysroot_fingerprint",
        },
        f"{name}/{arch} historical build evidence",
    )
    for key in ("brew_version", "dev_shell", "github_run", "job", "runner_os"):
        require_string(build[key], f"{name}/{arch} build {key}")
    for key in ("sdk_fingerprint", "sysroot_fingerprint"):
        require_string(build[key], f"{name}/{arch} build {key}", SHA256)
    metadata = exact_keys(
        provenance["metadata"],
        {
            "formula_json",
            "link_manifest_json",
            "metadata_json",
            "provenance_json",
        },
        f"{name}/{arch} historical provenance metadata",
    )
    historical_metadata = exact_keys(
        metadata["metadata_json"],
        {"path", "sha256"},
        f"{name}/{arch} historical metadata receipt",
    )
    if historical_metadata["path"] != campaign["authority"][
        "old_metadata"
    ]["path"]:
        fail(f"{name}/{arch} historical metadata path is substituted")
    require_string(
        historical_metadata["sha256"],
        f"{name}/{arch} historical metadata SHA-256",
        SHA256,
    )
    expected_metadata = {
        "formula_json": sidecars["formula"],
        "link_manifest_json": sidecars["link"],
        # A provenance report can legitimately name an older metadata
        # generation that the campaign already proved reachable from the
        # exact old-tap history. Requiring the latest selected file here would
        # rewrite history by rejecting otherwise valid older bottles.
        "metadata_json": historical_metadata,
        "provenance_json": {
            "path": variant["provenance"]["path"],
            "sha256": normalized_provenance_sha256(provenance),
        },
    }
    if metadata != expected_metadata:
        fail(f"{name}/{arch} historical provenance metadata is substituted")

    old_source = variant["old_formula_source"]
    historical_formula = run_git(
        old_tap_root,
        ["show", f"{old_source['commit']}:{old_source['path']}"],
        f"{name}/{arch} historical Formula source",
        maximum=1024 * 1024,
    )
    if sha256_bytes(historical_formula) != old_source["sha256"]:
        fail(f"{name}/{arch} historical Formula source is substituted")
    return {
        "build": build,
        "env": link["env"],
        "formula_revision": formula_revision,
        "keg": link["keg"],
        "links": link["links"],
        "payload_root": link_bottle["payload_root"],
        "receipts": link["receipts"],
        "validation": provenance["validation"],
    }


def validate_handoff_arches(
    handoff: dict[str, Any],
    formula: dict[str, Any],
) -> None:
    variants = formula.get("variants")
    if not isinstance(variants, list) or not variants:
        fail(f"{formula.get('name')} campaign variants are invalid")
    declared = [
        require_string(
            variant.get("arch") if isinstance(variant, dict) else None,
            f"{formula.get('name')} campaign variant architecture",
        )
        for variant in variants
    ]
    if (
        declared != sorted(set(declared))
        or any(arch not in ("wasm32", "wasm64") for arch in declared)
    ):
        fail(f"{formula.get('name')} campaign variants are invalid")
    actual = [
        publication["arch"] for publication in handoff["publications"]
    ]
    # WHY: a handoff is the independently usable result of one successful
    # Formula/architecture build. Requiring every declared sibling here would
    # strand a valid wasm32 bottle merely because the wasm64 build failed.
    # Consumers still validate their own complete dependency closure below.
    if (
        actual != sorted(set(actual))
        or not actual
        or any(arch not in declared for arch in actual)
    ):
        fail("Formula handoff architectures are outside the campaign")


def publication_asset_name(arch: str, relative: str) -> str:
    return f"{arch}.{relative.replace('/', '.')}"


def default_publication_validator(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    publication: pathlib.Path,
    prepared_root: pathlib.Path,
    checkout_commit: str,
) -> None:
    authority = campaign["authority"]
    checkout_commit = require_string(
        checkout_commit,
        "prepared tap checkout commit",
        COMMIT,
    )
    build_manifest, _payload = load_json_bytes(
        publication / "build/manifest.json",
        f"{formula['name']}/{arch} build manifest",
        canonical=False,
    )
    if (
        not isinstance(build_manifest, dict)
        or build_manifest.get("schema") != 4
        or build_manifest.get("tap_checkout_commit") != checkout_commit
    ):
        fail(
            f"{formula['name']}/{arch} build manifest names a different "
            "prepared checkout"
        )
    command = [
        "bash",
        str(ROOT / "scripts/homebrew-validate-publish-handoff.sh"),
        "--handoff",
        str(publication),
        "--formula",
        formula["name"],
        "--arch",
        arch,
        "--release-tag",
        f"bottles-abi-v{authority['current_kandelo_abi']}",
        "--tap-repository",
        authority["tap_repository"],
        "--tap-name",
        authority["tap_name"],
        "--tap-commit",
        authority["source_tap_commit"],
        "--tap-checkout-commit",
        checkout_commit,
        "--kandelo-commit",
        authority["kandelo_commit"],
        "--bottle-root-url",
        f"https://ghcr.io/v2/{authority['tap_repository'].lower()}",
        "--tap-root",
        str(prepared_root),
        "--forbidden-root",
        str(publication.parent),
        "--forbidden-root",
        str(prepared_root.parent),
        "--defer-whole-tap-validation",
        "--prefix-campaign-layout-sha256",
        authority["guest_layout"]["sha256"],
    ]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1800,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot validate publication {formula['name']}/{arch}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(
            f"publication validation failed for "
            f"{formula['name']}/{arch}: {detail}"
        )


def reuse_bottle_json(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    digest: str,
    layout: dict[str, Any],
) -> dict[str, Any]:
    authority = campaign["authority"]
    name = formula["name"]
    tap_name = authority["tap_name"]
    owner, tap = tap_name.split("/", 1)
    return {
        f"{tap_name}/{name}": {
            "bottle": {
                "cellar": layout["cellar"],
                "rebuild": formula["destination"]["bottle_rebuild"],
                "root_url": (
                    "https://ghcr.io/v2/"
                    f"{authority['tap_repository'].lower()}"
                ),
                "tags": {f"{arch}_kandelo": {"sha256": digest}},
            },
            "formula": {
                "name": name,
                "path": (
                    f"Library/Taps/{owner}/homebrew-{tap}/"
                    f"Formula/{name}.rb"
                ),
                "pkg_version": formula["version"],
            },
        }
    }


def reuse_sidecars_input(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    variant: dict[str, Any],
    arch: str,
    extracted: dict[str, Any],
    layout: dict[str, Any],
) -> dict[str, Any]:
    authority = campaign["authority"]
    old_record = variant["old_record"]
    name = formula["name"]
    dependencies = [
        {
            "full_name": value["full_name"],
            "name": value["full_name"].rsplit("/", 1)[1],
            "version": value["version"],
        }
        for value in formula["dependencies"]
    ]
    return {
        "generated_at": old_record["built_at"],
        "generator": "Kandelo Homebrew prefix campaign reuse",
        "kandelo_abi": authority["current_kandelo_abi"],
        "kandelo_commit": authority["kandelo_commit"],
        "kandelo_repository": "Automattic/kandelo",
        "packages": [
            {
                "bottle_rebuild": formula["destination"][
                    "bottle_rebuild"
                ],
                "bottles": [
                    {
                        "arch": arch,
                        "archived_formula_sha256": old_record[
                            "built_from"
                        ]["formula_sha256"],
                        "bottle_file": "../reuse/bottle.tar.gz",
                        "bottle_tag": f"{arch}_kandelo",
                        "browser_compatible": old_record[
                            "browser_compatible"
                        ],
                        "build": extracted["build"],
                        "built_at": old_record["built_at"],
                        "built_by": old_record["built_by"],
                        "built_from": old_record["built_from"],
                        "cache_key_sha": old_record["cache_key_sha"],
                        "cellar": layout["cellar"],
                        "env": extracted["env"],
                        "fork_instrumentation": old_record[
                            "fork_instrumentation"
                        ],
                        "keg": (
                            f"{layout['cellar']}/{name}/"
                            f"{formula['version']}"
                        ),
                        "links": extracted["links"],
                        "payload_root": extracted["payload_root"],
                        "prefix": layout["prefix"],
                        "receipts": extracted["receipts"],
                        "runtime_support": old_record["runtime_support"],
                        "status": "success",
                        "url": old_record["url"],
                        "validation": extracted["validation"],
                    }
                ],
                "dependencies": dependencies,
                "formula_path": f"Formula/{name}.rb",
                "formula_revision": extracted["formula_revision"],
                "formula_source_sha256": formula["formula_source"][
                    "sha256"
                ],
                "full_name": f"{authority['tap_name']}/{name}",
                "name": name,
                "version": formula["version"],
            }
        ],
        "release_tag": (
            f"bottles-abi-v{authority['current_kandelo_abi']}"
        ),
        "schema": 1,
        "tap_commit": authority["source_tap_commit"],
        "tap_name": authority["tap_name"],
        "tap_repository": authority["tap_repository"],
    }


def reuse_evidence_document(
    campaign_payload: bytes,
    formula: dict[str, Any],
    variant: dict[str, Any],
    arch: str,
    extracted: dict[str, Any],
) -> dict[str, Any]:
    return {
        "anonymous_readback": variant["anonymous_readback"],
        "arch": arch,
        "built_from": variant["old_record"]["built_from"],
        "campaign_sha256": sha256_bytes(campaign_payload),
        "extracted": extracted,
        "formula": formula["name"],
        "inspection": variant["inspection"],
        "kind": "kandelo-homebrew-prefix-reuse-publication",
        "old_formula_source": variant["old_formula_source"],
        "old_record_sha256": variant["old_record_sha256"],
        "provenance": variant["provenance"],
        "schema": 1,
        "sidecars": variant["sidecars"],
        "variant_sha256": sha256_bytes(canonical_json(variant)),
    }


def validate_reuse_publication_shape(
    publication: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
) -> None:
    name = formula["name"]
    actual = walk_regular_files(
        publication, f"{name}/{arch} reuse publication"
    )
    if actual != list(REUSE_PUBLICATION_FILES):
        fail(
            f"{name}/{arch} reuse publication file set differs "
            "from the reuse contract"
        )
    variant = validate_reuse_variant(campaign, formula, arch)
    evidence, _payload = load_json_bytes(
        publication / "reuse/evidence.json",
        f"{name}/{arch} reuse evidence",
    )
    evidence = exact_keys(
        evidence,
        {
            "anonymous_readback",
            "arch",
            "built_from",
            "campaign_sha256",
            "extracted",
            "formula",
            "inspection",
            "kind",
            "old_formula_source",
            "old_record_sha256",
            "provenance",
            "schema",
            "sidecars",
            "variant_sha256",
        },
        f"{name}/{arch} reuse evidence",
    )
    campaign_payload = pretty_json(campaign)
    if evidence != reuse_evidence_document(
        campaign_payload,
        formula,
        variant,
        arch,
        evidence["extracted"],
    ):
        fail(f"{name}/{arch} reuse evidence differs from the campaign")
    extracted = exact_keys(
        evidence["extracted"],
        {
            "build",
            "env",
            "formula_revision",
            "keg",
            "links",
            "payload_root",
            "receipts",
            "validation",
        },
        f"{name}/{arch} extracted historical evidence",
    )
    archive = regular_file(
        publication / "reuse/bottle.tar.gz",
        f"{name}/{arch} reused bottle",
        MAX_ASSET_BYTES,
    )
    if (
        archive.stat().st_size != variant["old_record"]["bytes"]
        or sha256_file(archive) != variant["old_record"]["sha256"]
    ):
        fail(f"{name}/{arch} reused bottle differs from historical bytes")
    layout = campaign_guest_layout(campaign)
    sidecars, _sidecars_payload = load_json_bytes(
        publication / "composition/sidecars-input.json",
        f"{name}/{arch} reuse sidecars input",
    )
    if sidecars != reuse_sidecars_input(
        campaign, formula, variant, arch, extracted, layout
    ):
        fail(f"{name}/{arch} reuse sidecars input is substituted")
    expected_bottle = reuse_bottle_json(
        campaign,
        formula,
        arch,
        variant["old_record"]["sha256"],
        layout,
    )
    bottle_json, _bottle_payload = load_json_bytes(
        publication / "reuse/bottle.json",
        f"{name}/{arch} reuse bottle JSON",
    )
    if bottle_json != expected_bottle:
        fail(f"{name}/{arch} reuse bottle JSON is substituted")


def validate_handoff_publication_shape(
    publication_root: pathlib.Path,
    publication: dict[str, Any],
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
) -> None:
    kind = publication_kind(
        publication, f"{formula['name']}/{arch} publication"
    )
    if kind == "build":
        validate_publication_shape(publication_root, formula, arch)
    else:
        validate_reuse_publication_shape(
            publication_root, campaign, formula, arch
        )


def validate_publication_shape(
    publication: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
) -> None:
    actual = walk_regular_files(
        publication, f"{formula['name']}/{arch} publication"
    )
    if actual != list(PUBLICATION_FILES):
        fail(
            f"{formula['name']}/{arch} publication file set differs "
            "from the publisher handoff contract"
        )
    sidecars, _payload = load_json_bytes(
        publication / "composition/sidecars-input.json",
        f"{formula['name']}/{arch} composition input",
    )
    packages = sidecars.get("packages") if isinstance(sidecars, dict) else None
    if (
        not isinstance(packages, list)
        or len(packages) != 1
        or not isinstance(packages[0], dict)
    ):
        fail(f"{formula['name']}/{arch} composition has no exact package")
    package = packages[0]
    evidence = campaign_formula_evidence({}, formula)
    package_dependencies = package.get("dependencies")
    if not isinstance(package_dependencies, list):
        fail(f"{formula['name']}/{arch} dependencies are invalid")
    normalized_dependencies: list[dict[str, str]] = []
    for dependency in package_dependencies:
        dependency = exact_keys(
            dependency,
            {"full_name", "name", "version"},
            f"{formula['name']}/{arch} dependency",
        )
        if not dependency["full_name"].endswith(
            f"/{dependency['name']}"
        ):
            fail(f"{formula['name']}/{arch} dependency name is inconsistent")
        normalized_dependencies.append(
            {
                "full_name": dependency["full_name"],
                "version": dependency["version"],
            }
        )
    if (
        package.get("name") != evidence["name"]
        or package.get("version") != evidence["version"]
        or package.get("bottle_rebuild") != evidence["bottle_rebuild"]
        or package.get("formula_source_sha256")
        != evidence["formula_sha256"]
        or normalized_dependencies != evidence["dependencies"]
    ):
        fail(
            f"{formula['name']}/{arch} composition differs from the campaign"
        )
    bottles = package.get("bottles")
    if (
        not isinstance(bottles, list)
        or len(bottles) != 1
        or not isinstance(bottles[0], dict)
        or bottles[0].get("arch") != arch
    ):
        fail(f"{formula['name']}/{arch} composition bottle is invalid")


def file_record(
    path: pathlib.Path,
    relative: str,
    asset_name: str,
) -> dict[str, Any]:
    require_string(asset_name, "handoff asset name", ASSET_NAME)
    metadata = regular_file(
        path, f"handoff payload {relative}", MAX_ASSET_BYTES
    ).stat()
    return {
        "asset_name": asset_name,
        "bytes": metadata.st_size,
        "path": relative,
        "sha256": sha256_file(path),
    }


def handoff_tag(payload: bytes) -> str:
    return f"homebrew-prefix-handoff-sha256-{sha256_bytes(payload)}"


def validate_handoff_manifest(
    value: Any,
    campaign: dict[str, Any],
    campaign_payload: bytes,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "campaign",
            "dependency_handoffs",
            "formula",
            "kind",
            "publications",
            "schema",
            "source",
        },
        "Formula handoff",
    )
    if (
        value["schema"] != HANDOFF_SCHEMA
        or value["kind"]
        != "kandelo-homebrew-prefix-formula-handoff"
    ):
        fail("Formula handoff has an unsupported contract")
    campaign_record = exact_keys(
        value["campaign"], {"sha256"}, "handoff campaign"
    )
    if campaign_record["sha256"] != sha256_bytes(campaign_payload):
        fail("Formula handoff belongs to a different campaign")
    source = exact_keys(
        value["source"],
        {
            "kandelo_commit",
            "source_tap_commit",
            "target_tree_git_oid",
            "tap_name",
            "tap_repository",
        },
        "handoff source",
    )
    authority = campaign["authority"]
    expected_source = {
        "kandelo_commit": authority["kandelo_commit"],
        "source_tap_commit": authority["source_tap_commit"],
        "target_tree_git_oid": source_tree_identity(authority),
        "tap_name": authority["tap_name"],
        "tap_repository": authority["tap_repository"],
    }
    if source != expected_source:
        fail("Formula handoff source differs from the campaign")
    return value


def validate_handoff_inventory(
    value: Any,
    campaign: dict[str, Any],
    campaign_payload: bytes,
    manifest_bytes: bytes,
) -> tuple[dict[str, Any], list[dict[str, Any]], set[str]]:
    value = validate_handoff_manifest(value, campaign, campaign_payload)
    total = len(manifest_bytes)
    asset_names = {"handoff.json"}
    paths: set[str] = set()
    records: list[dict[str, Any]] = []
    publications = value["publications"]
    if not isinstance(publications, list) or not publications:
        fail("Formula handoff has no publications")
    prior_arch = ""
    for publication in publications:
        publication = exact_keys(
            publication,
            {"arch", "files", "kind"},
            "handoff publication",
        )
        arch = publication["arch"]
        if arch not in ("wasm32", "wasm64") or arch <= prior_arch:
            fail("handoff publication architectures are invalid")
        prior_arch = arch
        kind = publication_kind(publication, f"handoff {arch} publication")
        expected_files = publication_files(kind)
        files = publication["files"]
        if not isinstance(files, list) or len(files) != len(expected_files):
            fail(f"handoff {arch} file inventory is invalid")
        expected_paths = [
            f"payload/{arch}/{relative}"
            for relative in expected_files
        ]
        actual_paths: list[str] = []
        for index, record in enumerate(files):
            record = exact_keys(
                record,
                {"asset_name", "bytes", "path", "sha256"},
                f"handoff {arch} file #{index}",
            )
            relative = safe_relative(
                record["path"], f"handoff {arch} file #{index} path"
            )
            actual_paths.append(relative)
            if relative in paths:
                fail("Formula handoff repeats a payload path")
            paths.add(relative)
            expected_asset = publication_asset_name(
                arch, expected_files[index]
            )
            asset_name = require_string(
                record["asset_name"],
                f"handoff {arch} file #{index} asset name",
                ASSET_NAME,
            )
            if asset_name in asset_names:
                fail("handoff repeats a release asset name")
            if asset_name != expected_asset:
                fail(f"handoff {arch} asset name is not canonical")
            asset_names.add(asset_name)
            byte_count = require_int(
                record["bytes"],
                f"handoff {arch} file #{index} bytes",
                1,
                MAX_ASSET_BYTES,
            )
            require_string(
                record["sha256"],
                f"handoff {arch} file #{index} SHA-256",
                SHA256,
            )
            total += byte_count
            if total > MAX_TOTAL_BYTES:
                fail("Formula handoff exceeds its aggregate size bound")
            records.append(record)
        if actual_paths != expected_paths:
            fail(f"handoff {arch} payload paths are not canonical")
    return value, records, asset_names


def validate_dependency_records(
    records: Any,
    expected: dict[str, tuple[str, str]],
) -> None:
    if (
        not isinstance(records, list)
        or len(records) > MAX_DEPENDENCIES
    ):
        fail("handoff dependency evidence is invalid")
    actual: dict[str, tuple[str, str]] = {}
    prior = ""
    for index, value in enumerate(records):
        value = exact_keys(
            value,
            {"formula", "manifest_sha256", "tag"},
            f"handoff dependency #{index}",
        )
        name = require_string(
            value["formula"], f"handoff dependency #{index} formula", FORMULA
        )
        tag = require_string(
            value["tag"], f"handoff dependency #{index} tag", HANDOFF_TAG
        )
        digest = require_string(
            value["manifest_sha256"],
            f"handoff dependency #{index} manifest SHA-256",
            SHA256,
        )
        if tag != f"homebrew-prefix-handoff-sha256-{digest}":
            fail("handoff dependency tag differs from its manifest")
        if name <= prior:
            fail("handoff dependencies must be unique and sorted")
        prior = name
        actual[name] = (tag, digest)
    if actual != expected:
        fail("handoff dependencies differ from the exact campaign closure")


def load_handoff(
    root: pathlib.Path,
    campaign: dict[str, Any],
    campaign_payload: bytes,
) -> tuple[dict[str, Any], bytes]:
    root = real_directory(root, "Formula handoff root")
    value, payload = load_json_bytes(
        root / "handoff.json", "Formula handoff manifest"
    )
    value, records, _asset_names = validate_handoff_inventory(
        value,
        campaign,
        campaign_payload,
        payload,
    )
    actual_files = walk_regular_files(root, "Formula handoff root")
    expected_files = {"handoff.json"}
    for record in records:
        relative = record["path"]
        path = regular_file(
            root / relative,
            f"handoff payload {relative}",
            MAX_ASSET_BYTES,
        )
        if (
            path.stat().st_size != record["bytes"]
            or sha256_file(path) != record["sha256"]
        ):
            fail(f"handoff payload {relative} differs from its manifest")
        expected_files.add(relative)
    if actual_files != sorted(expected_files):
        fail("Formula handoff contains unmanifested files")
    formula_name = require_string(
        value["formula"].get("name")
        if isinstance(value["formula"], dict)
        else None,
        "Formula handoff name",
        FORMULA,
    )
    formula_matches = [
        formula
        for formula in campaign["formulae"]
        if formula.get("name") == formula_name
    ]
    if len(formula_matches) != 1 or value["formula"] != (
        campaign_formula_evidence(campaign, formula_matches[0])
    ):
        fail("Formula handoff differs from the campaign Formula")
    for publication in value["publications"]:
        arch = publication["arch"]
        # Build publications already pass the full publisher validator before
        # derive-build seals them. Reuse has no build job, so its compact
        # evidence contract must be revalidated on every immutable readback.
        if publication_kind(
            publication, f"{formula_name}/{arch} publication"
        ) == "reuse":
            validate_reuse_publication_shape(
                root / f"payload/{arch}",
                campaign,
                formula_matches[0],
                arch,
            )
    return value, payload


LoadedDependencyHandoffs = dict[
    str,
    tuple[pathlib.Path, dict[str, Any], bytes],
]


def load_dependency_handoff_set(
    roots: Iterable[pathlib.Path],
    campaign: dict[str, Any],
    campaign_payload: bytes,
    index: dict[str, dict[str, Any]],
    formula_name: str,
    required_arches: Iterable[str],
) -> tuple[
    list[dict[str, Any]],
    dict[str, tuple[str, str]],
    LoadedDependencyHandoffs,
]:
    expected_names = dependency_closure(
        campaign, index, formula_name
    )
    required_arches = tuple(
        sorted(
            {
                require_string(
                    arch, "required dependency architecture"
                )
                for arch in required_arches
            }
        )
    )
    if (
        not required_arches
        or any(arch not in ("wasm32", "wasm64") for arch in required_arches)
    ):
        fail("required dependency architectures are invalid")
    loaded: dict[str, tuple[str, str]] = {}
    loaded_values: dict[str, dict[str, Any]] = {}
    loaded_handoffs: LoadedDependencyHandoffs = {}
    records: list[dict[str, Any]] = []
    for root in roots:
        root = real_directory(root, "dependency handoff root")
        value, payload = load_handoff(
            root, campaign, campaign_payload
        )
        formula = value["formula"]
        name = require_string(
            formula.get("name"), "dependency handoff Formula", FORMULA
        )
        if name in loaded:
            fail(f"dependency handoff {name} is duplicated")
        if name not in index:
            fail(f"dependency handoff {name} is outside the campaign")
        expected_formula = campaign_formula_evidence(
            campaign, index[name]
        )
        if formula != expected_formula:
            fail(f"dependency handoff {name} differs from the campaign")
        validate_handoff_arches(value, index[name])
        for arch in required_arches:
            # WHY: dependency records bind a content-addressed handoff, but
            # one handoff may intentionally carry only one architecture.
            # A wasm64 consumer must never mistake a wasm32-only dependency
            # handoff for a complete same-architecture closure.
            handoff_publication(value, arch, f"dependency {name}")
        digest = sha256_bytes(payload)
        tag = handoff_tag(payload)
        loaded[name] = (tag, digest)
        loaded_values[name] = value
        loaded_handoffs[name] = (root, value, payload)
        records.append(
            {
                "formula": name,
                "manifest_sha256": digest,
                "tag": tag,
            }
        )
    if tuple(sorted(loaded)) != expected_names:
        fail("dependency handoffs differ from the exact campaign closure")
    for dependency_name, value in loaded_values.items():
        nested_expected = {
            name: loaded[name]
            for name in dependency_closure(
                campaign, index, dependency_name
            )
        }
        validate_dependency_records(
            value["dependency_handoffs"], nested_expected
        )
    records.sort(key=lambda item: item["formula"])
    return records, loaded, loaded_handoffs


def validate_dependency_handoffs(
    roots: Iterable[pathlib.Path],
    campaign: dict[str, Any],
    campaign_payload: bytes,
    index: dict[str, dict[str, Any]],
    formula_name: str,
    required_arches: Iterable[str],
) -> tuple[list[dict[str, Any]], dict[str, tuple[str, str]]]:
    records, loaded, _loaded_handoffs = load_dependency_handoff_set(
        roots,
        campaign,
        campaign_payload,
        index,
        formula_name,
        required_arches,
    )
    return records, loaded


DependencyBottleMerger = Callable[..., None]
SidecarGenerator = Callable[..., None]
TapValidator = Callable[..., None]


def selected_formula_order(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    roots: Iterable[str],
) -> tuple[str, ...]:
    roots = tuple(
        sorted(
            {
                require_string(root, "selection root Formula", FORMULA)
                for root in roots
            }
        )
    )
    if not roots:
        fail("selection needs at least one root Formula")
    tap_name = campaign["authority"]["tap_name"]
    visiting: set[str] = set()
    visited: set[str] = set()
    ordered: list[str] = []

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"campaign dependency graph cycles at {name}")
        if name in visited:
            return
        if name not in index:
            fail(f"selection Formula {name} is outside the campaign")
        visiting.add(name)
        for dependency in dependency_names(index[name], tap_name):
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        ordered.append(name)

    for root in roots:
        visit(root)
    return tuple(ordered)


def clear_generated_sidecars(tap_root: pathlib.Path) -> None:
    generated = (
        "Kandelo/metadata.json",
        "Kandelo/formula",
        "Kandelo/link",
        "Kandelo/reports",
    )
    for relative in generated:
        path = tap_root / relative
        if path.is_symlink():
            fail(f"candidate tap generated path {relative} is a symlink")
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            if not path.is_file():
                fail(
                    f"candidate tap generated path {relative} "
                    "is a special file"
                )
            path.unlink()


def restrict_formulae(
    tap_root: pathlib.Path,
    selected_names: set[str],
) -> None:
    formula_root = real_directory(
        tap_root / "Formula", "candidate tap Formula directory"
    )
    selected_paths = {
        f"{name}.rb"
        for name in selected_names
    }
    for path in formula_root.glob("*.rb"):
        if path.name in selected_paths:
            continue
        if path.is_symlink() or not path.is_file():
            fail("candidate tap contains an unsafe Formula entry")
        path.unlink()


def default_sidecar_generator(
    *,
    tap_root: pathlib.Path,
    input_path: pathlib.Path,
    prefix_campaign_layout_sha256: str,
) -> None:
    command = [
        "bash",
        str(ROOT / "scripts/dev-shell.sh"),
        "cargo",
        "run",
        "--release",
        "-p",
        "xtask",
        "--quiet",
        "--",
        "homebrew-sidecars",
        "--tap-root",
        str(tap_root),
        "--input",
        str(input_path),
        "--prefix-campaign-layout-sha256",
        require_string(
            prefix_campaign_layout_sha256,
            "prefix campaign layout SHA-256",
            SHA256,
        ),
    ]
    previous = tap_root / "Kandelo/metadata.json"
    if previous.is_symlink() or (
        previous.exists() and not previous.is_file()
    ):
        fail("selected tap metadata is not a regular file")
    if previous.is_file():
        command.extend(("--previous-metadata", str(previous)))
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1800,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot generate selected Homebrew sidecars: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(f"cannot generate selected Homebrew sidecars: {detail}")


def default_tap_validator(
    *,
    tap_root: pathlib.Path,
    prefix_campaign_layout_sha256: str,
) -> None:
    command = [
        "bash",
        str(ROOT / "scripts/dev-shell.sh"),
        "cargo",
        "run",
        "--release",
        "-p",
        "xtask",
        "--quiet",
        "--",
        "homebrew-validate",
        "--tap-root",
        str(tap_root),
        "--prefix-campaign-layout-sha256",
        require_string(
            prefix_campaign_layout_sha256,
            "prefix campaign layout SHA-256",
            SHA256,
        ),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1800,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot validate selected Homebrew tap: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(f"cannot validate selected Homebrew tap: {detail}")


FinalPrefixValidator = Callable[..., None]


def campaign_source_provenance(
    campaign: dict[str, Any],
) -> dict[str, Any]:
    source = exact_keys(
        campaign["authority"].get("source_materialization"),
        {
            "authority",
            "kind",
            "manifest",
            "materializer",
            "source_root",
            "source_tree_git_oid",
            "target_tree_git_oid",
        },
        "campaign sealed target source",
    )
    if source["kind"] != "sealed-target-overlay-v1":
        fail("final tap requires one sealed target-source overlay")
    authority = exact_keys(
        source["authority"],
        {"path", "sha256"},
        "campaign target-source authority",
    )
    manifest = exact_keys(
        source["manifest"],
        {"path", "sha256"},
        "campaign target-source manifest",
    )
    materializer = exact_keys(
        source["materializer"],
        {"path", "sha256"},
        "campaign target-source materializer",
    )
    if (
        authority["path"] != SOURCE_AUTHORITY_PATH
        or manifest["path"] != SOURCE_MANIFEST_PATH
        or materializer["path"] != SOURCE_MATERIALIZER_PATH
        or source["source_root"]
        != "Kandelo/campaigns/prefix-v1/source"
    ):
        fail("campaign target source uses unexpected protected paths")
    require_string(
        authority["sha256"],
        "campaign target-source authority SHA-256",
        SHA256,
    )
    require_string(
        materializer["sha256"],
        "campaign target-source materializer SHA-256",
        SHA256,
    )
    result = {
        "manifest_sha256": require_string(
            manifest["sha256"],
            "campaign target-source manifest SHA-256",
            SHA256,
        ),
        "overlay_source_tree_git_oid": require_string(
            source["source_tree_git_oid"],
            "campaign target-source payload tree",
            COMMIT,
        ),
        "sealed_target_tree_git_oid": require_string(
            source["target_tree_git_oid"],
            "campaign sealed historical target tree",
            COMMIT,
        ),
        "source_tap_commit": require_string(
            campaign["authority"]["source_tap_commit"],
            "campaign source tap commit",
            COMMIT,
        ),
    }
    if result["sealed_target_tree_git_oid"] != source_tree_identity(
        campaign["authority"]
    ):
        fail("campaign target-source identities disagree")
    return result


def load_source_overlay_contract(
    source_commit_root: pathlib.Path,
    campaign: dict[str, Any],
) -> tuple[
    dict[str, Any],
    list[tuple[str, dict[str, Any] | None, dict[str, Any]]],
]:
    provenance = campaign_source_provenance(campaign)
    materialization = campaign["authority"]["source_materialization"]
    authority, authority_payload = load_json_bytes(
        source_commit_root / SOURCE_AUTHORITY_PATH,
        "campaign source replay authority",
    )
    if authority_payload != pretty_json(authority):
        fail("campaign source replay authority is not canonical JSON")
    if sha256_bytes(authority_payload) != materialization["authority"][
        "sha256"
    ]:
        fail("campaign source replay authority differs from the campaign")
    if not isinstance(authority, dict):
        fail("campaign source replay authority must be an object")
    target = exact_keys(
        authority.get("target_source"),
        {
            "manifest_path",
            "manifest_sha256",
            "source_root",
            "source_tree_git_oid",
            "target_tree_git_oid",
        },
        "campaign source replay target",
    )
    if (
        target["manifest_path"] != SOURCE_MANIFEST_PATH
        or target["manifest_sha256"] != provenance["manifest_sha256"]
        or target["source_root"] != materialization["source_root"]
        or target["source_tree_git_oid"]
        != provenance["overlay_source_tree_git_oid"]
        or target["target_tree_git_oid"]
        != provenance["sealed_target_tree_git_oid"]
    ):
        fail("campaign source replay target differs from the campaign")

    manifest, manifest_payload = load_json_bytes(
        source_commit_root / SOURCE_MANIFEST_PATH,
        "campaign source replay manifest",
    )
    if manifest_payload != pretty_json(manifest):
        fail("campaign source replay manifest is not canonical JSON")
    if sha256_bytes(manifest_payload) != provenance["manifest_sha256"]:
        fail("campaign source replay manifest differs from the campaign")
    manifest = exact_keys(
        manifest,
        {
            "base",
            "campaign",
            "files",
            "kind",
            "schema",
            "source_root",
            "target_tree_git_oid",
        },
        "campaign source replay manifest",
    )
    manifest_base = exact_keys(
        manifest["base"],
        {"commit", "tree_git_oid"},
        "campaign source replay base",
    )
    if (
        manifest["schema"] != 1
        or manifest["kind"]
        != "kandelo-homebrew-prefix-campaign-source-overlay"
        or manifest["campaign"] != "prefix-v1"
        or manifest["source_root"] != materialization["source_root"]
        or manifest["target_tree_git_oid"]
        != provenance["sealed_target_tree_git_oid"]
    ):
        fail("campaign source replay manifest is inconsistent")
    provenance = {
        **provenance,
        "base": {
            "commit": require_string(
                manifest_base["commit"],
                "campaign source replay base commit",
                COMMIT,
            ),
            "tree_git_oid": require_string(
                manifest_base["tree_git_oid"],
                "campaign source replay base tree",
                COMMIT,
            ),
        },
    }

    overlay_root = real_directory(
        source_commit_root / materialization["source_root"],
        "campaign source replay payload",
    )
    if (
        filesystem_git_tree_oid(
            overlay_root,
            "campaign source replay payload",
        )
        != provenance["overlay_source_tree_git_oid"]
    ):
        fail("campaign source replay payload differs from the campaign")
    materializer = regular_file_within(
        source_commit_root,
        SOURCE_MATERIALIZER_PATH,
        "campaign source replay materializer",
        1024 * 1024,
    )
    if sha256_file(materializer) != materialization["materializer"][
        "sha256"
    ]:
        fail("campaign source replay materializer differs from the campaign")

    values = manifest["files"]
    if not isinstance(values, list) or not values:
        fail("campaign source replay has no sealed files")
    records: list[
        tuple[str, dict[str, Any] | None, dict[str, Any]]
    ] = []
    expected_payload_paths: set[str] = set()
    prior = ""
    for position, value in enumerate(values):
        value = exact_keys(
            value,
            {"base", "path", "target"},
            f"campaign source replay file #{position}",
        )
        relative = safe_relative(
            value["path"],
            f"campaign source replay file #{position} path",
        )
        if relative <= prior:
            fail("campaign source replay files must be unique and sorted")
        prior = relative
        base_record = (
            None
            if value["base"] is None
            else validate_overlay_file_record(
                value["base"],
                f"campaign source replay file #{position} base",
            )
        )
        target_record = validate_overlay_file_record(
            value["target"],
            f"campaign source replay file #{position} target",
        )
        validate_overlay_file(
            overlay_root,
            relative,
            target_record,
            f"campaign source replay payload {relative}",
        )
        expected_payload_paths.add(relative)
        records.append((relative, base_record, target_record))
    if set(
        filesystem_git_leaf_inventory(
            overlay_root,
            "campaign source replay payload",
        )
    ) != expected_payload_paths:
        fail("campaign source replay payload contains unsealed files")
    return provenance, records


def exact_live_tap_checkout(
    root: pathlib.Path,
    expected_commit: str,
    expected_tree_git_oid: str,
) -> pathlib.Path:
    root = exact_git_checkout(root, expected_commit, "live tap authority")
    expected_tree_git_oid = require_string(
        expected_tree_git_oid,
        "expected live tap tree",
        COMMIT,
    )
    actual_tree = run_git(
        root,
        ["rev-parse", "HEAD^{tree}"],
        "live tap authority tree",
    ).decode("ascii", errors="strict").strip()
    if actual_tree != expected_tree_git_oid:
        fail("live tap authority has the wrong Git tree")
    return root


def prepare_live_source_replay(
    *,
    campaign: dict[str, Any],
    source_root: pathlib.Path,
    live_tap_root: pathlib.Path,
    expected_live_commit: str,
    expected_live_tree_git_oid: str,
    snapshot_root: pathlib.Path,
) -> tuple[pathlib.Path, dict[str, Any]]:
    provenance = campaign_source_provenance(campaign)
    source_commit = provenance["source_tap_commit"]
    actual_source_tree = run_git(
        live_tap_root,
        ["rev-parse", f"{source_commit}^{{tree}}"],
        "campaign source tap tree in live history",
    ).decode("ascii", errors="strict").strip()
    if not git_is_ancestor(
        live_tap_root,
        source_commit,
        expected_live_commit,
        "campaign source ancestry in live tap",
    ):
        fail("live tap parent does not contain the campaign source commit")

    changed_paths = git_changed_paths(
        live_tap_root,
        source_commit,
        expected_live_commit,
        "live tap changes after campaign source",
    )
    rejected = sorted(
        set(changed_paths) - FINAL_TAP_ALLOWED_CONTROL_DRIFT_PATHS
    )
    if rejected:
        fail(
            "live tap changed outside the reviewed campaign-control paths: "
            + ", ".join(rejected)
        )

    # WHY: the v1 materialized source intentionally contains the historical
    # base plus the sealed Formula overlay, not every file from the commit that
    # sealed it. Read the manifest and payload from that exact source commit so
    # final composition can preserve its complete reviewed tree and then layer
    # the same sealed Formula bytes onto the exact live CAS parent.
    source_commit_root = git_snapshot(
        live_tap_root,
        source_commit,
        snapshot_root / "source-commit",
        "campaign complete source commit",
    )
    provenance, records = load_source_overlay_contract(
        source_commit_root,
        campaign,
    )
    provenance = {
        **provenance,
        "source_tap_tree_git_oid": actual_source_tree,
    }
    base = provenance["base"]
    actual_base_tree = run_git(
        live_tap_root,
        ["rev-parse", f"{base['commit']}^{{tree}}"],
        "campaign sealed base tree in live history",
    ).decode("ascii", errors="strict").strip()
    if actual_base_tree != base["tree_git_oid"]:
        fail("campaign sealed base commit has the wrong tree")
    if not git_is_ancestor(
        live_tap_root,
        base["commit"],
        source_commit,
        "campaign sealed base ancestry",
    ):
        fail("campaign sealed base is not an ancestor of the source commit")

    overlay_root = source_commit_root / campaign["authority"][
        "source_materialization"
    ]["source_root"]
    sealed_target = git_snapshot(
        live_tap_root,
        base["commit"],
        snapshot_root / "sealed-target",
        "campaign sealed historical target",
    )
    replay_overlay_files(
        tap_root=sealed_target,
        source_root=overlay_root,
        records=records,
        label="campaign sealed historical target replay",
    )
    if (
        filesystem_git_tree_oid(
            sealed_target,
            "campaign sealed historical target",
        )
        != provenance["sealed_target_tree_git_oid"]
    ):
        fail("campaign sealed historical target has the wrong tree")
    if filesystem_git_leaf_inventory(
        sealed_target,
        "campaign sealed historical target",
    ) != filesystem_git_leaf_inventory(
        source_root,
        "campaign supplied sealed historical target",
    ):
        fail("campaign supplied source is not the sealed historical target")

    replayed_source = source_commit_root
    replay_overlay_files(
        tap_root=replayed_source,
        source_root=overlay_root,
        records=records,
        label="campaign complete source replay",
    )
    provenance = {
        **provenance,
        "replayed_source_tree_git_oid": filesystem_git_tree_oid(
            replayed_source,
            "campaign complete replayed source",
        ),
    }

    replayed_live = git_snapshot(
        live_tap_root,
        expected_live_commit,
        snapshot_root / "replayed-live",
        "exact live tap parent",
    )
    if (
        filesystem_git_tree_oid(replayed_live, "exact live tap parent")
        != expected_live_tree_git_oid
    ):
        fail("exact live tap snapshot has the wrong tree")
    replay_overlay_files(
        tap_root=replayed_live,
        source_root=overlay_root,
        records=records,
        label="exact live tap overlay replay",
    )
    provenance = {
        **provenance,
        "replayed_live_tree_git_oid": filesystem_git_tree_oid(
            replayed_live,
            "replayed live tap parent",
        ),
    }
    return replayed_live, provenance


def default_final_prefix_validator(
    *,
    tap_root: pathlib.Path,
    retired_prefixes: list[str],
) -> None:
    # WHY: the authoritative checker deliberately permits retired strings in
    # its own negative tests and historical failure evidence. Load that exact
    # implementation instead of copying a policy that could drift looser.
    contract = runpy.run_path(
        str(ROOT / "scripts/homebrew-prefix-campaign.py")
    )
    try:
        contract["validate_final_candidate_prefixes"](
            tap_root,
            retired_prefixes,
        )
    except contract["CampaignError"] as error:
        fail(str(error))


def retire_campaign_authority(tap_root: pathlib.Path) -> None:
    paths: list[pathlib.Path] = []
    for relative in CAMPAIGN_RETIREMENT_PATHS:
        path = tap_root / relative
        if path.is_symlink():
            fail(f"campaign retirement path {relative} is a symlink")
        if relative.endswith("/source"):
            real_directory(path, f"campaign retirement path {relative}")
        else:
            regular_file(
                path,
                f"campaign retirement path {relative}",
            )
        paths.append(path)
    # WHY: preflight every required path before deleting the first one. A
    # partial or already-retired source is not valid completion authority.
    for path in paths:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def historical_report_inventory(
    tap_root: pathlib.Path,
) -> dict[str, tuple[str, str]]:
    inventory: dict[str, tuple[str, str]] = {}
    for name in ("failures", "rollbacks"):
        root = tap_root / f"Kandelo/reports/{name}"
        if not root.exists() and not root.is_symlink():
            continue
        root = real_directory(root, f"historical {name} reports")
        for relative, identity in filesystem_git_leaf_inventory(
            root,
            f"historical {name} reports",
        ).items():
            inventory[f"Kandelo/reports/{name}/{relative}"] = identity
    return inventory


def clear_final_generated_sidecars(tap_root: pathlib.Path) -> None:
    for relative in (
        "Kandelo/metadata.json",
        "Kandelo/formula",
        "Kandelo/link",
    ):
        path = tap_root / relative
        if path.is_symlink():
            fail(f"candidate tap generated path {relative} is a symlink")
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            if not path.is_file():
                fail(
                    f"candidate tap generated path {relative} "
                    "is a special file"
                )
            path.unlink()

    reports = tap_root / "Kandelo/reports"
    if not reports.exists() and not reports.is_symlink():
        return
    reports = real_directory(reports, "candidate tap reports")
    for path in reports.iterdir():
        if path.name in ("failures", "rollbacks"):
            real_directory(path, f"historical {path.name} reports")
            continue
        if path.is_symlink():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        elif path.is_file():
            path.unlink()
        else:
            fail("candidate tap reports contain a special file")


def prepare_final_tap(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    live_tap_root: pathlib.Path,
    handoff_roots: list[pathlib.Path],
    expected_live_commit: str,
    expected_live_tree_git_oid: str,
    output: pathlib.Path,
    finalization_output: pathlib.Path,
    bottle_merger: DependencyBottleMerger = (
        default_dependency_bottle_merger
    ),
    sidecar_generator: SidecarGenerator = default_sidecar_generator,
    tap_validator: TapValidator = default_tap_validator,
    final_prefix_validator: FinalPrefixValidator = (
        default_final_prefix_validator
    ),
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    campaign_sha256 = sha256_bytes(campaign_payload)
    authority = campaign["authority"]
    if authority["tap_repository"] != "kandelo-dev/homebrew-tap-core":
        fail("final prefix campaign belongs to the wrong tap repository")
    layout = campaign_guest_layout(campaign)
    layout_sha256 = authority["guest_layout"]["sha256"]
    expected_live_commit = require_string(
        expected_live_commit,
        "expected live tap commit",
        COMMIT,
    )
    expected_live_tree_git_oid = require_string(
        expected_live_tree_git_oid,
        "expected live tap tree",
        COMMIT,
    )
    source_tap_root = real_directory(
        source_tap_root,
        "campaign target source",
    )
    live_tap_root = exact_live_tap_checkout(
        live_tap_root,
        expected_live_commit,
        expected_live_tree_git_oid,
    )
    handoff_roots = [
        real_directory(root, "final tap handoff root")
        for root in handoff_roots
    ]
    output, finalization_output = validate_output_pair(
        output,
        "final tap candidate",
        finalization_output,
        "finalization receipt",
        (
            campaign_path,
            source_tap_root,
            live_tap_root,
            *handoff_roots,
        ),
    )
    ordered = selected_formula_order(campaign, index, list(index))
    campaign_release = {
        "manifest_sha256": campaign_sha256,
        "repository": authority["tap_repository"],
        "tag": f"homebrew-prefix-campaign-sha256-{campaign_sha256}",
    }

    input_snapshot = pathlib.Path(
        tempfile.mkdtemp(
            prefix=f".{output.name}.inputs.",
            dir=output.parent,
        )
    )
    temporary: pathlib.Path | None = None
    try:
        stable_source = input_snapshot / "target-source"
        shutil.copytree(source_tap_root, stable_source, symlinks=True)
        # Hash the complete tree once, then validate each Formula against the
        # same private snapshot. Rehashing a 64-Formula tap 64 times adds no
        # evidence and materially slows finalization.
        validate_source_root(stable_source, campaign, index[ordered[0]])
        for name in ordered[1:]:
            validate_source_formula(stable_source, index[name])
        # WHY: a final campaign can run after its activation controller lands.
        # Start from that exact live parent and replay only the sealed Formula
        # overlay. Copying the older materialized source wholesale would erase
        # reviewed control-plane commits while still passing Formula checks.
        stable_live, source_provenance = prepare_live_source_replay(
            campaign=campaign,
            source_root=stable_source,
            live_tap_root=live_tap_root,
            expected_live_commit=expected_live_commit,
            expected_live_tree_git_oid=expected_live_tree_git_oid,
            snapshot_root=input_snapshot,
        )

        loaded: dict[
            tuple[str, str],
            tuple[pathlib.Path, dict[str, Any], bytes],
        ] = {}
        identities: dict[tuple[str, str], tuple[str, str]] = {}
        handoffs: list[dict[str, Any]] = []
        for position, handoff_root in enumerate(handoff_roots):
            stable = input_snapshot / f"handoff-{position}"
            shutil.copytree(handoff_root, stable, symlinks=True)
            handoff, payload = load_handoff(
                stable,
                campaign,
                campaign_payload,
            )
            name = require_string(
                handoff["formula"].get("name"),
                "final tap handoff Formula",
                FORMULA,
            )
            if name not in index:
                fail(f"final tap handoff {name} is outside the campaign")
            if handoff["formula"] != campaign_formula_evidence(
                campaign,
                index[name],
            ):
                fail(f"final tap handoff {name} differs from the campaign")
            validate_handoff_arches(handoff, index[name])
            actual_arches = [
                publication["arch"]
                for publication in handoff["publications"]
            ]
            digest = sha256_bytes(payload)
            tag = handoff_tag(payload)
            for arch in actual_arches:
                key = (name, arch)
                if key in loaded:
                    fail(f"final tap handoff {name}/{arch} is duplicated")
                # WHY: the publisher emits one durable result per variant.
                # Formula-only ownership would make a failed sibling strand a
                # successful bottle or let the wrong architecture satisfy it.
                loaded[key] = (stable, handoff, payload)
                identities[key] = (tag, digest)
                handoffs.append(
                    {
                        "arch": arch,
                        "formula": name,
                        "manifest_sha256": digest,
                        "tag": tag,
                    }
                )
        expected_variants = {
            (name, variant["arch"])
            for name, formula in index.items()
            for variant in formula["variants"]
        }
        if set(loaded) != expected_variants:
            missing = sorted(expected_variants - set(loaded))
            extra = sorted(set(loaded) - expected_variants)
            fail(
                "final tap handoff variants differ from the campaign "
                f"(missing={missing}, extra={extra})"
            )
        for name in ordered:
            for variant in index[name]["variants"]:
                arch = variant["arch"]
                expected_dependencies = {
                    dependency: identities[(dependency, arch)]
                    for dependency in dependency_closure(
                        campaign,
                        index,
                        name,
                    )
                }
                validate_dependency_records(
                    loaded[(name, arch)][1]["dependency_handoffs"],
                    expected_dependencies,
                )
        handoffs.sort(
            key=lambda value: (value["formula"], value["arch"])
        )
        handoffs_sha256 = sha256_bytes(canonical_json(handoffs))
        catalog_cohort_sha256 = sha256_bytes(
            canonical_json(
                {
                    "campaign_sha256": campaign_sha256,
                    "guest_layout_sha256": layout_sha256,
                    "handoffs": handoffs,
                }
            )
        )

        temporary = pathlib.Path(
            tempfile.mkdtemp(
                prefix=f".{output.name}.",
                dir=output.parent,
            )
        )
        tap_root = temporary / "tap"
        shutil.copytree(stable_live, tap_root, symlinks=True)
        historical_reports = historical_report_inventory(tap_root)
        # WHY: current catalog sidecars are regenerated from the sealed
        # handoffs, but failure and rollback evidence explains earlier public
        # outcomes and must survive finalization byte-for-byte.
        clear_final_generated_sidecars(tap_root)
        canonical_root = temporary / "bottle-inputs"
        canonical_root.mkdir()
        for name in ordered:
            for variant in index[name]["variants"]:
                arch = variant["arch"]
                handoff_root, handoff, _payload = loaded[(name, arch)]
                label = f"final tap handoff {name}/{arch}"
                publication = handoff_publication(
                    handoff,
                    arch,
                    f"final tap handoff {name}",
                )
                publication_root = handoff_root / f"payload/{arch}"
                validate_handoff_publication_shape(
                    publication_root,
                    publication,
                    campaign,
                    index[name],
                    arch,
                )
                archive_relative = publication_semantic_path(
                    publication,
                    "bottle_archive",
                    label,
                )
                bottle_json_relative = publication_semantic_path(
                    publication,
                    "bottle_json",
                    label,
                )
                sidecars_relative = publication_semantic_path(
                    publication,
                    "sidecars_input",
                    label,
                )
                archive_record = handoff_publication_file(
                    publication,
                    f"payload/{arch}/{archive_relative}",
                    label,
                )
                canonical, bottle_digest, root_url, cellar = (
                    validate_dependency_bottle_input(
                        bottle_json=(
                            publication_root / bottle_json_relative
                        ),
                        handoff=handoff,
                        arch=arch,
                        archive_record=archive_record,
                        campaign=campaign,
                    )
                )
                canonical_path = private_destination(
                    canonical_root,
                    f"{name}-{arch}.json",
                    f"{name}/{arch} final bottle JSON",
                )
                canonical_path.write_bytes(pretty_json(canonical))
                bottle_merger(
                    tap_root=tap_root,
                    campaign=campaign,
                    formula=name,
                    arch=arch,
                    bottle_json=canonical_path,
                    sha256=bottle_digest,
                    root_url=root_url,
                    cellar=cellar,
                )
                sidecar_generator(
                    tap_root=tap_root,
                    input_path=(publication_root / sidecars_relative),
                    prefix_campaign_layout_sha256=layout_sha256,
                )

        if historical_report_inventory(tap_root) != historical_reports:
            fail("final tap composition changed historical report evidence")

        # WHY: bottle blocks and generated catalog sidecars must agree while
        # the sealed campaign authority is still present for diagnostics. Only
        # a valid complete catalog may retire that one-shot authority.
        tap_validator(
            tap_root=tap_root,
            prefix_campaign_layout_sha256=layout_sha256,
        )
        retire_campaign_authority(tap_root)
        completion = {
            "campaign": "prefix-v1",
            "campaign_release": campaign_release,
            "catalog_cohort_sha256": catalog_cohort_sha256,
            "expected_parent_commit": expected_live_commit,
            "guest_layout_sha256": layout_sha256,
            "handoffs_sha256": handoffs_sha256,
            "kind": "kandelo-homebrew-prefix-campaign-completion",
            "schema": 2,
            "source": source_provenance,
        }
        completion_path = private_destination(
            tap_root,
            CAMPAIGN_COMPLETION_PATH,
            "campaign completion",
        )
        completion_payload = pretty_json(completion)
        completion_path.write_bytes(completion_payload)
        observed_completion, observed_payload = load_json_bytes(
            completion_path,
            "campaign completion",
        )
        if (
            observed_completion != completion
            or observed_payload != completion_payload
        ):
            fail("campaign completion changed after creation")
        final_prefix_validator(
            tap_root=tap_root,
            retired_prefixes=layout["retired_prefixes"],
        )
        for relative in CAMPAIGN_RETIREMENT_PATHS:
            retired = tap_root / relative
            if retired.exists() or retired.is_symlink():
                fail(f"campaign retirement path {relative} remains live")

        candidate_tree = filesystem_git_tree_oid(
            tap_root,
            "final tap candidate",
        )
        finalization = {
            "campaign_release": campaign_release,
            "candidate": {"tree_git_oid": candidate_tree},
            "catalog_cohort_sha256": catalog_cohort_sha256,
            "completion": {
                "path": CAMPAIGN_COMPLETION_PATH,
                "sha256": sha256_bytes(completion_payload),
            },
            "expected_live": {
                "commit": expected_live_commit,
                "tree_git_oid": expected_live_tree_git_oid,
            },
            "guest_layout_sha256": layout_sha256,
            "handoffs": handoffs,
            "handoffs_sha256": handoffs_sha256,
            "kind": "kandelo-homebrew-prefix-campaign-finalization",
            "schema": 2,
            "source": source_provenance,
        }
        staged_finalization = temporary / "finalization.json"
        finalization_payload = pretty_json(finalization)
        staged_finalization.write_bytes(finalization_payload)
        observed_finalization, observed_finalization_payload = (
            load_json_bytes(
                staged_finalization,
                "finalization receipt",
            )
        )
        if (
            observed_finalization != finalization
            or observed_finalization_payload != finalization_payload
        ):
            fail("finalization receipt changed after creation")

        # WHY: the receipt is a later compare-and-swap instruction. Rebind its
        # local parent immediately before exposure so a concurrent checkout
        # change cannot silently make a stale finalization look current.
        exact_live_tap_checkout(
            live_tap_root,
            expected_live_commit,
            expected_live_tree_git_oid,
        )
        commit_output_pair(
            tap_root,
            output,
            staged_finalization,
            finalization_output,
        )
    finally:
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)
        shutil.rmtree(input_snapshot, ignore_errors=True)


def validate_finalization_candidate(
    *,
    candidate_tap_root: pathlib.Path,
    finalization_path: pathlib.Path,
) -> tuple[dict[str, Any], bytes]:
    candidate_tap_root = real_directory(
        candidate_tap_root,
        "final tap candidate",
    )
    finalization, finalization_payload = load_json_bytes(
        finalization_path,
        "finalization receipt",
    )
    finalization = exact_keys(
        finalization,
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
        "finalization receipt",
    )
    if (
        finalization["schema"] != 2
        or finalization["kind"]
        != "kandelo-homebrew-prefix-campaign-finalization"
    ):
        fail("finalization receipt has an unsupported contract")
    campaign_release = exact_keys(
        finalization["campaign_release"],
        {"manifest_sha256", "repository", "tag"},
        "finalization campaign release",
    )
    campaign_sha256 = require_string(
        campaign_release["manifest_sha256"],
        "finalization campaign manifest SHA-256",
        SHA256,
    )
    if (
        campaign_release["repository"]
        != "kandelo-dev/homebrew-tap-core"
        or campaign_release["tag"]
        != f"homebrew-prefix-campaign-sha256-{campaign_sha256}"
    ):
        fail("finalization campaign release identity is invalid")
    candidate = exact_keys(
        finalization["candidate"],
        {"tree_git_oid"},
        "finalization candidate",
    )
    candidate_tree = require_string(
        candidate["tree_git_oid"],
        "finalization candidate tree",
        COMMIT,
    )
    expected_live = exact_keys(
        finalization["expected_live"],
        {"commit", "tree_git_oid"},
        "finalization expected live tap",
    )
    require_string(
        expected_live["commit"],
        "finalization expected live commit",
        COMMIT,
    )
    require_string(
        expected_live["tree_git_oid"],
        "finalization expected live tree",
        COMMIT,
    )
    layout_sha256 = require_string(
        finalization["guest_layout_sha256"],
        "finalization guest layout SHA-256",
        SHA256,
    )
    handoffs = finalization["handoffs"]
    if (
        not isinstance(handoffs, list)
        or not handoffs
        or len(handoffs) > MAX_VARIANTS
    ):
        fail("finalization handoffs are invalid")
    prior: tuple[str, str] | None = None
    for position, record in enumerate(handoffs):
        record = exact_keys(
            record,
            {"arch", "formula", "manifest_sha256", "tag"},
            f"finalization handoff #{position}",
        )
        name = require_string(
            record["formula"],
            f"finalization handoff #{position} Formula",
            FORMULA,
        )
        arch = require_string(
            record["arch"],
            f"finalization handoff {name} architecture",
        )
        if arch not in ("wasm32", "wasm64"):
            fail(f"finalization handoff {name} architecture is invalid")
        key = (name, arch)
        if prior is not None and key <= prior:
            fail(
                "finalization handoff variants must be unique and sorted"
            )
        prior = key
        digest = require_string(
            record["manifest_sha256"],
            f"finalization handoff {name}/{arch} SHA-256",
            SHA256,
        )
        if record["tag"] != f"homebrew-prefix-handoff-sha256-{digest}":
            fail(f"finalization handoff {name}/{arch} tag is invalid")
    handoffs_sha256 = require_string(
        finalization["handoffs_sha256"],
        "finalization handoffs SHA-256",
        SHA256,
    )
    if handoffs_sha256 != sha256_bytes(canonical_json(handoffs)):
        fail("finalization handoffs SHA-256 is invalid")
    cohort_sha256 = require_string(
        finalization["catalog_cohort_sha256"],
        "finalization catalog cohort SHA-256",
        SHA256,
    )
    if cohort_sha256 != sha256_bytes(
        canonical_json(
            {
                "campaign_sha256": campaign_sha256,
                "guest_layout_sha256": layout_sha256,
                "handoffs": handoffs,
            }
        )
    ):
        fail("finalization catalog cohort SHA-256 is invalid")
    completion_record = exact_keys(
        finalization["completion"],
        {"path", "sha256"},
        "finalization completion",
    )
    if completion_record["path"] != CAMPAIGN_COMPLETION_PATH:
        fail("finalization completion path is invalid")
    completion_sha256 = require_string(
        completion_record["sha256"],
        "finalization completion SHA-256",
        SHA256,
    )
    completion, completion_payload = load_json_bytes(
        candidate_tap_root / CAMPAIGN_COMPLETION_PATH,
        "candidate campaign completion",
    )
    if sha256_bytes(completion_payload) != completion_sha256:
        fail("candidate campaign completion differs from finalization")
    completion = exact_keys(
        completion,
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
        "candidate campaign completion",
    )
    source = exact_keys(
        completion["source"],
        {
            "base",
            "manifest_sha256",
            "overlay_source_tree_git_oid",
            "replayed_live_tree_git_oid",
            "replayed_source_tree_git_oid",
            "sealed_target_tree_git_oid",
            "source_tap_commit",
            "source_tap_tree_git_oid",
        },
        "candidate campaign completion source",
    )
    if finalization["source"] != source:
        fail("finalization source replay differs from campaign completion")
    source_base = exact_keys(
        source["base"],
        {"commit", "tree_git_oid"},
        "candidate completion source base",
    )
    require_string(
        source_base["commit"],
        "candidate completion source base commit",
        COMMIT,
    )
    require_string(
        source_base["tree_git_oid"],
        "candidate completion source base tree",
        COMMIT,
    )
    require_string(
        source["manifest_sha256"],
        "candidate completion source manifest SHA-256",
        SHA256,
    )
    for key, label in (
        ("overlay_source_tree_git_oid", "overlay source tree"),
        ("replayed_live_tree_git_oid", "replayed live tree"),
        ("replayed_source_tree_git_oid", "replayed source tree"),
        ("sealed_target_tree_git_oid", "sealed target tree"),
        ("source_tap_commit", "source tap commit"),
        ("source_tap_tree_git_oid", "source tap tree"),
    ):
        require_string(
            source[key],
            f"candidate completion {label}",
            COMMIT,
        )
    if (
        completion["schema"] != 2
        or completion["kind"]
        != "kandelo-homebrew-prefix-campaign-completion"
        or completion["campaign"] != "prefix-v1"
        or completion["campaign_release"] != campaign_release
        or completion["catalog_cohort_sha256"] != cohort_sha256
        or completion["expected_parent_commit"]
        != expected_live["commit"]
        or completion["guest_layout_sha256"] != layout_sha256
        or completion["handoffs_sha256"] != handoffs_sha256
    ):
        fail("candidate campaign completion differs from finalization")
    for relative in CAMPAIGN_RETIREMENT_PATHS:
        path = candidate_tap_root / relative
        if path.exists() or path.is_symlink():
            fail(f"final tap candidate retains {relative}")
    if any(
        path.name == ".git"
        for path in candidate_tap_root.rglob(".git")
    ):
        fail("final tap candidate contains nested Git authority")
    if filesystem_git_tree_oid(
        candidate_tap_root,
        "final tap candidate",
    ) != candidate_tree:
        fail("final tap candidate tree differs from finalization")
    return finalization, finalization_payload


def git_ref_exists(root: pathlib.Path, reference: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "show-ref", "--verify", "--quiet", reference],
            cwd=root,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot inspect output ref: {error}")
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    detail = result.stderr.decode("utf-8", errors="replace")[-16_384:]
    fail(f"cannot inspect output ref: {detail}")


def create_final_tap_commit(
    *,
    candidate_tap_root: pathlib.Path,
    finalization_path: pathlib.Path,
    live_tap_root: pathlib.Path,
    output_ref: str,
    commit_receipt_output: pathlib.Path,
) -> None:
    candidate_tap_root = real_directory(
        candidate_tap_root,
        "final tap candidate",
    )
    finalization_path = regular_file(
        finalization_path,
        "finalization receipt",
    )
    if paths_overlap(candidate_tap_root, live_tap_root.resolve()):
        fail("final tap candidate overlaps the live tap authority")
    try:
        finalization_path.resolve().relative_to(candidate_tap_root)
    except ValueError:
        pass
    else:
        fail("finalization receipt must be outside the candidate tap")
    finalization, finalization_payload = validate_finalization_candidate(
        candidate_tap_root=candidate_tap_root,
        finalization_path=finalization_path,
    )
    expected_live = finalization["expected_live"]
    live_tap_root = exact_live_tap_checkout(
        live_tap_root,
        expected_live["commit"],
        expected_live["tree_git_oid"],
    )
    source = finalization["source"]
    source_commit = source["source_tap_commit"]
    actual_source_tree = run_git(
        live_tap_root,
        ["rev-parse", f"{source_commit}^{{tree}}"],
        "final commit source tap tree",
    ).decode("ascii", errors="strict").strip()
    actual_base_tree = run_git(
        live_tap_root,
        ["rev-parse", f"{source['base']['commit']}^{{tree}}"],
        "final commit sealed base tree",
    ).decode("ascii", errors="strict").strip()
    if (
        actual_source_tree != source["source_tap_tree_git_oid"]
        or actual_base_tree != source["base"]["tree_git_oid"]
        or not git_is_ancestor(
            live_tap_root,
            source["base"]["commit"],
            source_commit,
            "final commit sealed base ancestry",
        )
        or not git_is_ancestor(
            live_tap_root,
            source_commit,
            expected_live["commit"],
            "final commit source ancestry",
        )
    ):
        fail("final commit live history differs from its source replay")
    rejected_live_paths = sorted(
        set(
            git_changed_paths(
                live_tap_root,
                source_commit,
                expected_live["commit"],
                "final commit live changes after campaign source",
            )
        )
        - FINAL_TAP_ALLOWED_CONTROL_DRIFT_PATHS
    )
    # WHY: the receipt is not permission to choose an arbitrary parent. Repeat
    # the complete source ancestry and narrow drift proof immediately before
    # creating the compare-and-swap commit from the live object database.
    if rejected_live_paths:
        fail(
            "final commit live tap changed outside reviewed control paths: "
            + ", ".join(rejected_live_paths)
        )
    output_ref = require_string(output_ref, "output ref")
    if not output_ref.startswith("refs/heads/"):
        fail("output ref must be a full refs/heads/... name")
    run_git(
        live_tap_root,
        ["check-ref-format", output_ref],
        "output ref format",
    )
    if git_ref_exists(live_tap_root, output_ref):
        fail("output ref already exists")
    commit_receipt_output = validate_new_output(
        commit_receipt_output,
        "final commit receipt",
        (candidate_tap_root, finalization_path, live_tap_root),
    )

    temporary = pathlib.Path(
        tempfile.mkdtemp(
            prefix=f".{commit_receipt_output.name}.",
            dir=commit_receipt_output.parent,
        )
    )
    created_ref = False
    commit_oid = ""
    try:
        stable_candidate = temporary / "worktree"
        shutil.copytree(
            candidate_tap_root,
            stable_candidate,
            symlinks=True,
        )
        validate_finalization_candidate(
            candidate_tap_root=stable_candidate,
            finalization_path=finalization_path,
        )
        git_dir = pathlib.Path(
            run_git(
                live_tap_root,
                ["rev-parse", "--absolute-git-dir"],
                "live tap Git directory",
            ).decode("utf-8", errors="strict").strip()
        ).resolve()
        environment = dict(os.environ)
        for name in (
            "GIT_AUTHOR_DATE",
            "GIT_COMMITTER_DATE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_WORK_TREE",
        ):
            environment.pop(name, None)
        # WHY: a failed ref/receipt transaction must be safely retryable.
        # Fixed identity and time make the same parent, tree, and message
        # reproduce the same commit object instead of accumulating orphans.
        environment.update(
            {
                "GIT_AUTHOR_EMAIL": CAMPAIGN_COMMIT_EMAIL,
                "GIT_AUTHOR_NAME": CAMPAIGN_COMMIT_NAME,
                "GIT_AUTHOR_DATE": (
                    f"{CAMPAIGN_COMMIT_TIMESTAMP} "
                    f"{CAMPAIGN_COMMIT_TIMEZONE}"
                ),
                "GIT_COMMITTER_EMAIL": CAMPAIGN_COMMIT_EMAIL,
                "GIT_COMMITTER_NAME": CAMPAIGN_COMMIT_NAME,
                "GIT_COMMITTER_DATE": (
                    f"{CAMPAIGN_COMMIT_TIMESTAMP} "
                    f"{CAMPAIGN_COMMIT_TIMEZONE}"
                ),
                "GIT_DIR": str(git_dir),
                "GIT_INDEX_FILE": str(temporary / "index"),
                "GIT_WORK_TREE": str(stable_candidate),
            }
        )
        run_git(
            stable_candidate,
            ["read-tree", "--empty"],
            "private final tap index",
            environment=environment,
        )
        run_git(
            stable_candidate,
            ["add", "--all", "--force", "--", "."],
            "private final tap worktree",
            environment=environment,
        )
        staged_tree = run_git(
            stable_candidate,
            ["write-tree"],
            "staged final tap tree",
            environment=environment,
        ).decode("ascii", errors="strict").strip()
        if staged_tree != finalization["candidate"]["tree_git_oid"]:
            fail("private Git index differs from the candidate tree")
        commit_oid = run_git(
            stable_candidate,
            [
                "commit-tree",
                staged_tree,
                "-p",
                expected_live["commit"],
                "-m",
                FINAL_TAP_COMMIT_MESSAGE.rstrip("\n"),
            ],
            "final tap commit",
            environment=environment,
        ).decode("ascii", errors="strict").strip()
        require_string(commit_oid, "final tap commit", COMMIT)
        parents = run_git(
            live_tap_root,
            ["rev-list", "--parents", "-n", "1", commit_oid],
            "final tap commit parents",
        ).decode("ascii", errors="strict").strip().split()
        commit_tree = run_git(
            live_tap_root,
            ["rev-parse", f"{commit_oid}^{{tree}}"],
            "final tap commit tree",
        ).decode("ascii", errors="strict").strip()
        commit_message = run_git(
            live_tap_root,
            ["show", "-s", "--format=%B", commit_oid],
            "final tap commit message",
        ).decode("utf-8", errors="strict")
        if (
            parents != [commit_oid, expected_live["commit"]]
            or commit_tree != staged_tree
            or commit_message.rstrip("\n")
            != FINAL_TAP_COMMIT_MESSAGE.rstrip("\n")
        ):
            fail("final tap commit has the wrong parent, tree, or message")
        commit_receipt = {
            "candidate": {"tree_git_oid": staged_tree},
            "commit": {
                "oid": commit_oid,
                "parent": expected_live["commit"],
                "tree_git_oid": staged_tree,
            },
            "finalization": {
                "path": "finalization.json",
                "sha256": sha256_bytes(finalization_payload),
            },
            "kind": "kandelo-homebrew-prefix-campaign-final-commit",
            "output_ref": output_ref,
            "schema": 1,
        }
        staged_receipt = temporary / "commit-receipt.json"
        staged_receipt.write_bytes(pretty_json(commit_receipt))
        exact_live_tap_checkout(
            live_tap_root,
            expected_live["commit"],
            expected_live["tree_git_oid"],
        )
        run_git(
            live_tap_root,
            ["update-ref", output_ref, commit_oid, "0" * 40],
            "new final tap output ref",
        )
        created_ref = True
        if run_git(
            live_tap_root,
            ["rev-parse", output_ref],
            "new final tap output ref",
        ).decode("ascii", errors="strict").strip() != commit_oid:
            fail("new final tap output ref differs from its commit")
        os.link(staged_receipt, commit_receipt_output)
    except BaseException as primary:
        if created_ref:
            try:
                run_git(
                    live_tap_root,
                    ["update-ref", "-d", output_ref, commit_oid],
                    "final tap output ref rollback",
                )
            except BaseException as rollback:
                fail(
                    "final tap commit failed and its ref rollback failed: "
                    f"{primary}; {rollback}"
                )
        raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def prepare_selection(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    roots: list[str],
    arch: str,
    handoff_roots: list[pathlib.Path],
    output: pathlib.Path,
    bottle_merger: DependencyBottleMerger = (
        default_dependency_bottle_merger
    ),
    sidecar_generator: SidecarGenerator = default_sidecar_generator,
    tap_validator: TapValidator = default_tap_validator,
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    if arch not in ("wasm32", "wasm64"):
        fail("selection architecture is invalid")
    guest_layout = exact_keys(
        campaign["authority"].get("guest_layout"),
        {"path", "sha256"},
        "campaign guest layout",
    )
    layout_sha256 = require_string(
        guest_layout["sha256"],
        "campaign guest layout SHA-256",
        SHA256,
    )
    kandelo_abi = require_int(
        campaign["authority"].get("current_kandelo_abi"),
        "campaign Kandelo ABI",
        1,
        2**32 - 1,
    )
    ordered = selected_formula_order(campaign, index, roots)
    selected_names = set(ordered)
    source_tap_root = real_directory(
        source_tap_root, "campaign target source"
    )
    handoff_roots = [
        real_directory(root, "selection handoff root")
        for root in handoff_roots
    ]
    output = validate_new_output(
        output,
        "closed selection output",
        (campaign_path, source_tap_root, *handoff_roots),
    )

    input_snapshot = pathlib.Path(
        tempfile.mkdtemp(
            prefix=f".{output.name}.inputs.",
            dir=output.parent,
        )
    )
    try:
        # WHY: handoff paths are local directories even when their contents
        # came from immutable releases. The sidecar generator opens each
        # archive later, so validate and consume one private snapshot instead
        # of allowing an edit/restore race between those two operations.
        stable_handoff_roots: list[pathlib.Path] = []
        for position, handoff_root in enumerate(handoff_roots):
            stable = input_snapshot / f"handoff-{position}"
            shutil.copytree(handoff_root, stable, symlinks=True)
            stable_handoff_roots.append(stable)

        loaded: dict[
            str, tuple[pathlib.Path, dict[str, Any], bytes]
        ] = {}
        identities: dict[str, tuple[str, str]] = {}
        for handoff_root in stable_handoff_roots:
            handoff, payload = load_handoff(
                handoff_root, campaign, campaign_payload
            )
            name = require_string(
                handoff["formula"].get("name"),
                "selection handoff Formula",
                FORMULA,
            )
            if name in loaded:
                fail(f"selection handoff {name} is duplicated")
            if name not in selected_names:
                fail(
                    f"selection handoff {name} is outside "
                    "the selected closure"
                )
            if handoff["formula"] != campaign_formula_evidence(
                campaign, index[name]
            ):
                fail(
                    f"selection handoff {name} differs from the campaign"
                )
            validate_handoff_arches(handoff, index[name])
            handoff_publication(
                handoff, arch, f"selection handoff {name}"
            )
            loaded[name] = (handoff_root, handoff, payload)
            digest = sha256_bytes(payload)
            identities[name] = (handoff_tag(payload), digest)
        if set(loaded) != selected_names:
            missing = sorted(selected_names - set(loaded))
            fail(f"selected dependency closure lacks handoffs {missing}")
        for name in ordered:
            handoff = loaded[name][1]
            expected_dependencies = {
                dependency: identities[dependency]
                for dependency in dependency_closure(
                    campaign, index, name
                )
            }
            validate_dependency_records(
                handoff["dependency_handoffs"],
                expected_dependencies,
            )
        temporary = pathlib.Path(
            tempfile.mkdtemp(
                prefix=f".{output.name}.",
                dir=output.parent,
            )
        )
    except BaseException:
        shutil.rmtree(input_snapshot, ignore_errors=True)
        raise
    try:
        result = temporary / "selection"
        tap_root = result / "tap"
        shutil.copytree(source_tap_root, tap_root, symlinks=True)
        for name in ordered:
            validate_source_root(tap_root, campaign, index[name])
        clear_generated_sidecars(tap_root)
        # WHY: the candidate is a closed consumer input, not a preview of the
        # whole campaign. Omitting unselected Formulae prevents Brew from
        # discovering a sibling whose bottle or dependency closure is absent.
        restrict_formulae(tap_root, selected_names)
        canonical_root = temporary / "bottle-inputs"
        canonical_root.mkdir()
        selection_formulae: list[dict[str, Any]] = []
        for name in ordered:
            handoff_root, handoff, payload = loaded[name]
            publication = handoff_publication(
                handoff, arch, f"selection handoff {name}"
            )
            publication_root = handoff_root / f"payload/{arch}"
            validate_handoff_publication_shape(
                publication_root,
                publication,
                campaign,
                index[name],
                arch,
            )
            archive_relative = publication_semantic_path(
                publication,
                "bottle_archive",
                f"selection handoff {name}/{arch}",
            )
            bottle_json_relative = publication_semantic_path(
                publication,
                "bottle_json",
                f"selection handoff {name}/{arch}",
            )
            sidecars_relative = publication_semantic_path(
                publication,
                "sidecars_input",
                f"selection handoff {name}/{arch}",
            )
            archive_record = handoff_publication_file(
                publication,
                f"payload/{arch}/{archive_relative}",
                f"selection handoff {name}/{arch}",
            )
            canonical, bottle_digest, root_url, cellar = (
                validate_dependency_bottle_input(
                    bottle_json=(
                        publication_root / bottle_json_relative
                    ),
                    handoff=handoff,
                    arch=arch,
                    archive_record=archive_record,
                    campaign=campaign,
                )
            )
            canonical_path = private_destination(
                canonical_root,
                f"{name}.json",
                f"{name}/{arch} selection bottle JSON",
            )
            canonical_path.write_bytes(pretty_json(canonical))
            bottle_merger(
                tap_root=tap_root,
                campaign=campaign,
                formula=name,
                arch=arch,
                bottle_json=canonical_path,
                sha256=bottle_digest,
                root_url=root_url,
                cellar=cellar,
            )
            sidecar_generator(
                tap_root=tap_root,
                input_path=(
                    publication_root / sidecars_relative
                ),
                prefix_campaign_layout_sha256=layout_sha256,
            )
            selection_formulae.append(
                {
                    "archive": {
                        "bytes": archive_record["bytes"],
                        "sha256": archive_record["sha256"],
                    },
                    "formula": name,
                    "handoff": {
                        "manifest_sha256": sha256_bytes(payload),
                        "tag": handoff_tag(payload),
                    },
                    "version": handoff["formula"]["version"],
                }
            )
        metadata, _metadata_payload = load_json_bytes(
            tap_root / "Kandelo/metadata.json",
            "selected tap metadata",
            canonical=False,
        )
        packages = (
            metadata.get("packages")
            if isinstance(metadata, dict)
            else None
        )
        if not isinstance(packages, list):
            fail("selected tap metadata has no package inventory")
        metadata_names = sorted(
            require_string(
                package.get("name")
                if isinstance(package, dict)
                else None,
                "selected tap metadata package",
                FORMULA,
            )
            for package in packages
        )
        if metadata_names != sorted(selected_names):
            fail(
                "selected tap metadata differs from the exact "
                "dependency closure"
            )
        # WHY: matching package names do not prove that Formula bottle blocks,
        # link manifests, provenance reports, and archive-derived inventories
        # agree. The normal whole-tap validator must accept those cross-file
        # contracts before Brew or the unchanged VFS builder uses this tap.
        tap_validator(
            tap_root=tap_root,
            prefix_campaign_layout_sha256=layout_sha256,
        )
        selection = {
            "arch": arch,
            "campaign": {
                "guest_layout_sha256": layout_sha256,
                "sha256": sha256_bytes(campaign_payload),
                "tag": (
                    "homebrew-prefix-campaign-sha256-"
                    f"{sha256_bytes(campaign_payload)}"
                ),
            },
            "formulae": selection_formulae,
            "kandelo_abi": kandelo_abi,
            "kind": "kandelo-homebrew-closed-selection-candidate",
            "roots": sorted(set(roots)),
            "schema": 1,
            "tap": {
                "name": campaign["authority"]["tap_name"],
                "path": "tap",
                "prepared_tree_git_oid": filesystem_git_tree_oid(
                    tap_root, "selected tap"
                ),
                "repository": campaign["authority"]["tap_repository"],
                "source_commit": campaign["authority"][
                    "source_tap_commit"
                ],
                "source_tree_git_oid": source_tree_identity(
                    campaign["authority"]
                ),
            },
        }
        selection_payload = pretty_json(selection)
        result.mkdir(exist_ok=True)
        (result / "selection.json").write_bytes(selection_payload)
        # WHY: this command prepares a locally consumable candidate only. A
        # deployment must first publish these exact bytes at an immutable
        # locator, prove resolver/VFS readback, and then move its named product
        # pointer through that system's own compare-and-swap transaction.
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        shutil.rmtree(input_snapshot, ignore_errors=True)


def stage_dependency_bottle_inputs(
    *,
    loaded_handoffs: LoadedDependencyHandoffs,
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
    arch: str,
    output: pathlib.Path,
) -> list[dict[str, Any]]:
    output.mkdir(parents=True)
    staged: dict[str, dict[str, Any]] = {}
    expected_names = dependency_closure(
        campaign,
        index,
        formula_name,
    )
    if tuple(sorted(loaded_handoffs)) != expected_names:
        fail("loaded dependency handoffs differ from the campaign closure")
    for name in expected_names:
        root, handoff, _payload = loaded_handoffs[name]
        expected_formula = campaign_formula_evidence(
            campaign, index[name]
        )
        if handoff["formula"] != expected_formula:
            fail(f"dependency handoff {name} differs from the campaign")
        publication = handoff_publication(
            handoff,
            arch,
            f"dependency {name}",
        )
        bottle_path = (
            f"payload/{arch}/"
            + publication_semantic_path(
                publication,
                "bottle_json",
                f"dependency {name}/{arch}",
            )
        )
        archive_path = (
            f"payload/{arch}/"
            + publication_semantic_path(
                publication,
                "bottle_archive",
                f"dependency {name}/{arch}",
            )
        )
        bottle_record = handoff_publication_file(
            publication,
            bottle_path,
            f"dependency {name}/{arch}",
        )
        archive_record = handoff_publication_file(
            publication,
            archive_path,
            f"dependency {name}/{arch}",
        )
        # WHY: the Formula merge needs only bottle metadata. Copying every
        # dependency archive would add gigabytes of I/O without strengthening
        # the manifest SHA-256 binding already checked by load_handoff().
        raw_destination = private_destination(
            output,
            f"{name}/raw-bottle.json",
            f"{name}/{arch} staged bottle JSON",
        )
        copied, digest = copy_verified(
            root / bottle_path,
            raw_destination,
            expected_bytes=bottle_record["bytes"],
            expected_sha256=bottle_record["sha256"],
        )
        if (
            copied != bottle_record["bytes"]
            or digest != bottle_record["sha256"]
        ):
            fail(f"dependency {name}/{arch} changed while copied")
        canonical, bottle_digest, root_url, cellar = (
            validate_dependency_bottle_input(
                bottle_json=raw_destination,
                handoff=handoff,
                arch=arch,
                archive_record=archive_record,
                campaign=campaign,
            )
        )
        destination = private_destination(
            output,
            f"{name}/bottle.json",
            f"{name}/{arch} canonical bottle JSON",
        )
        # WHY: Homebrew's raw receipt keeps provenance-rich tag fields and a
        # tap-qualified key, while the static Formula merger deliberately
        # accepts only this minimal short-name document.
        with destination.open("xb") as canonical_output:
            canonical_output.write(pretty_json(canonical))
        staged[name] = {
            "bottle_json": destination,
            "cellar": cellar,
            "root_url": root_url,
            "sha256": bottle_digest,
        }
    if tuple(sorted(staged)) != expected_names:
        fail("staged dependency bottles differ from the campaign closure")
    return [
        {"formula": name, **staged[name]}
        for name in expected_names
    ]


PublicationValidator = Callable[
    [
        dict[str, Any],
        dict[str, Any],
        str,
        pathlib.Path,
        pathlib.Path,
        str,
    ],
    None,
]


def snapshot_source_root(
    source: pathlib.Path,
    destination: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> pathlib.Path:
    try:
        shutil.copytree(source, destination, symlinks=True)
    except OSError as error:
        fail(f"cannot snapshot campaign target source: {error}")
    # WHY: validation tools must never observe a mutable checkout and then
    # permit different bytes to be sealed. The private copy is authoritative
    # only after its complete Git tree and selected Formula match the campaign.
    return validate_source_root(destination, campaign, formula)


def prepare_arch_checkout(
    *,
    source: pathlib.Path,
    destination: pathlib.Path,
    dependency_input_root: pathlib.Path,
    loaded_handoffs: LoadedDependencyHandoffs,
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula: dict[str, Any],
    arch: str,
    dependency_merger: DependencyBottleMerger,
) -> tuple[pathlib.Path, str, str]:
    root = snapshot_source_root(
        source,
        destination,
        campaign,
        formula,
    )
    before = filesystem_git_leaf_inventory(
        root,
        f"{formula['name']}/{arch} source checkout",
    )
    staged = stage_dependency_bottle_inputs(
        loaded_handoffs=loaded_handoffs,
        campaign=campaign,
        index=index,
        formula_name=formula["name"],
        arch=arch,
        output=dependency_input_root,
    )
    for dependency in staged:
        dependency_merger(
            tap_root=root,
            campaign=campaign,
            formula=dependency["formula"],
            arch=arch,
            bottle_json=dependency["bottle_json"],
            sha256=dependency["sha256"],
            root_url=dependency["root_url"],
            cellar=dependency["cellar"],
        )
    after = filesystem_git_leaf_inventory(
        root,
        f"{formula['name']}/{arch} prepared checkout",
    )
    changed = tuple(
        sorted(
            path
            for path in set(before) | set(after)
            if before.get(path) != after.get(path)
        )
    )
    expected_changed = tuple(
        f"Formula/{name}.rb"
        for name in dependency_closure(
            campaign,
            index,
            formula["name"],
        )
    )
    if changed != expected_changed:
        fail(
            "dependency bottle composition changed files outside "
            "its exact Formula closure"
        )
    target_tree = source_tree_identity(campaign["authority"])
    target_commit = deterministic_campaign_commit_oid(
        parent=campaign["authority"]["source_tap_commit"],
        tree=target_tree,
        label="sealed target source",
    )
    prepared_tree = filesystem_git_tree_oid(
        root,
        f"{formula['name']}/{arch} prepared checkout",
    )
    # WHY: build jobs create this synthetic commit locally and cannot publish
    # it. Recomputing its Git object ID from sealed inputs lets the trusted
    # executor bind the handoff without trusting a job-supplied receipt.
    prepared_commit = deterministic_campaign_commit_oid(
        parent=target_commit,
        tree=prepared_tree,
        label=f"{formula['name']}/{arch} dependency bottles",
    )
    return root, prepared_tree, prepared_commit


def snapshot_publication(
    source: pathlib.Path,
    destination: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
) -> tuple[pathlib.Path, dict[str, dict[str, Any]]]:
    validate_publication_shape(source, formula, arch)
    destination.mkdir(parents=True)
    records: dict[str, dict[str, Any]] = {}
    for relative in PUBLICATION_FILES:
        copied = destination / relative
        copy_verified(source / relative, copied)
        handoff_relative = f"payload/{arch}/{relative}"
        records[relative] = file_record(
            copied,
            handoff_relative,
            publication_asset_name(arch, relative),
        )
    validate_publication_shape(destination, formula, arch)
    return destination, records


def derive_reuse(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    old_tap_root: pathlib.Path,
    formula_name: str,
    arch: str,
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
    asset_fetcher: Callable[
        [str, pathlib.Path, int, str], None
    ] | None = None,
) -> None:
    if asset_fetcher is None:
        asset_fetcher = anonymous_bottle_readback
    campaign, campaign_payload, index = load_campaign(campaign_path)
    formula_name = require_string(formula_name, "Formula name", FORMULA)
    if formula_name not in index:
        fail(f"Formula {formula_name} is outside the campaign")
    if arch not in ("wasm32", "wasm64"):
        fail("reuse architecture is invalid")
    formula = index[formula_name]
    variant = validate_reuse_variant(campaign, formula, arch)
    source_tap_root = validate_source_root(
        source_tap_root, campaign, formula
    )
    old_tap_commit = require_string(
        campaign["authority"].get("old_tap_commit"),
        "campaign old tap commit",
        COMMIT,
    )
    old_tap_root = exact_git_checkout(
        old_tap_root, old_tap_commit, "historical tap input"
    )
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "reuse Formula handoff output",
        (
            campaign_path,
            source_tap_root,
            old_tap_root,
            *dependency_roots,
        ),
    )
    (
        dependency_records,
        dependency_identities,
        _loaded_dependency_handoffs,
    ) = load_dependency_handoff_set(
        dependency_roots,
        campaign,
        campaign_payload,
        index,
        formula_name,
        (arch,),
    )
    extracted = historical_reuse_inputs(
        campaign=campaign,
        formula=formula,
        variant=variant,
        arch=arch,
        old_tap_root=old_tap_root,
    )
    layout = campaign_guest_layout(campaign)
    old_record = variant["old_record"]
    if old_record["built_from"]["kandelo_repository"].lower() != (
        "automattic/kandelo"
    ):
        fail(f"{formula_name}/{arch} historical Kandelo source is substituted")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        publication = temporary / "publication"
        (publication / "composition").mkdir(parents=True)
        (publication / "reuse").mkdir()
        archive = publication / "reuse/bottle.tar.gz"
        # WHY: campaign inspection is durable evidence about a prior read,
        # not permission to trust local runner state. Re-fetching the public
        # content-addressed blob proves both that it remains anonymously
        # consumable and that the handoff carries the exact historical bytes.
        asset_fetcher(
            old_record["url"],
            archive,
            old_record["bytes"],
            old_record["sha256"],
        )
        if (
            regular_file(
                archive,
                f"{formula_name}/{arch} anonymous bottle readback",
                MAX_ASSET_BYTES,
            ).stat().st_size
            != old_record["bytes"]
            or sha256_file(archive) != old_record["sha256"]
        ):
            fail(
                f"{formula_name}/{arch} anonymous bottle bytes changed"
            )
        (publication / "reuse/bottle.json").write_bytes(
            pretty_json(
                reuse_bottle_json(
                    campaign,
                    formula,
                    arch,
                    old_record["sha256"],
                    layout,
                )
            )
        )
        (publication / "composition/sidecars-input.json").write_bytes(
            pretty_json(
                reuse_sidecars_input(
                    campaign,
                    formula,
                    variant,
                    arch,
                    extracted,
                    layout,
                )
            )
        )
        (publication / "reuse/evidence.json").write_bytes(
            pretty_json(
                reuse_evidence_document(
                    campaign_payload,
                    formula,
                    variant,
                    arch,
                    extracted,
                )
            )
        )
        validate_reuse_publication_shape(
            publication, campaign, formula, arch
        )

        result = temporary / "handoff"
        result.mkdir()
        records: list[dict[str, Any]] = []
        for relative in REUSE_PUBLICATION_FILES:
            destination = result / f"payload/{arch}/{relative}"
            copy_verified(publication / relative, destination)
            records.append(
                file_record(
                    destination,
                    f"payload/{arch}/{relative}",
                    publication_asset_name(arch, relative),
                )
            )
        manifest = {
            "campaign": {"sha256": sha256_bytes(campaign_payload)},
            "dependency_handoffs": dependency_records,
            "formula": campaign_formula_evidence(campaign, formula),
            "kind": "kandelo-homebrew-prefix-formula-handoff",
            "publications": [
                {"arch": arch, "files": records, "kind": "reuse"}
            ],
            "schema": HANDOFF_SCHEMA,
            "source": {
                "kandelo_commit": campaign["authority"][
                    "kandelo_commit"
                ],
                "source_tap_commit": campaign["authority"][
                    "source_tap_commit"
                ],
                "target_tree_git_oid": source_tree_identity(
                    campaign["authority"]
                ),
                "tap_name": campaign["authority"]["tap_name"],
                "tap_repository": campaign["authority"][
                    "tap_repository"
                ],
            },
        }
        validate_dependency_records(
            manifest["dependency_handoffs"], dependency_identities
        )
        (result / "handoff.json").write_bytes(pretty_json(manifest))
        load_handoff(result, campaign, campaign_payload)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def derive_build(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    formula_name: str,
    publications: list[tuple[str, pathlib.Path]],
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
    validator: PublicationValidator = default_publication_validator,
    dependency_merger: DependencyBottleMerger = (
        default_dependency_bottle_merger
    ),
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    formula_name = require_string(formula_name, "Formula name", FORMULA)
    if formula_name not in index:
        fail(f"Formula {formula_name} is outside the campaign")
    formula = index[formula_name]
    source_tap_root = validate_source_root(
        source_tap_root, campaign, formula
    )
    if not publications:
        fail("Formula handoff needs at least one publication")
    declared_arches = [
        variant.get("arch")
        for variant in formula.get("variants", [])
        if isinstance(variant, dict)
    ]
    actual_arches = [arch for arch, _path in publications]
    if (
        actual_arches != sorted(set(actual_arches))
        or not actual_arches
        or any(arch not in declared_arches for arch in actual_arches)
    ):
        fail("publication architectures are outside the campaign")
    publications = [
        (
            arch,
            real_directory(
                publication, f"{formula_name}/{arch} publication"
            ),
        )
        for arch, publication in publications
    ]
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "Formula handoff output",
        (
            campaign_path,
            source_tap_root,
            *(publication for _arch, publication in publications),
            *dependency_roots,
        ),
    )
    (
        dependency_records,
        dependency_identities,
        loaded_dependency_handoffs,
    ) = load_dependency_handoff_set(
        dependency_roots,
        campaign,
        campaign_payload,
        index,
        formula_name,
        actual_arches,
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        result = temporary / "handoff"
        result.mkdir()
        publication_records: list[dict[str, Any]] = []
        for arch, publication in publications:
            private_publication, bound_records = snapshot_publication(
                publication,
                temporary / "publications" / arch,
                formula,
                arch,
            )
            private_source, prepared_tree, prepared_commit = (
                prepare_arch_checkout(
                    source=source_tap_root,
                    destination=temporary / "sources" / arch,
                    dependency_input_root=(
                        temporary / "dependency-inputs" / arch
                    ),
                    loaded_handoffs=loaded_dependency_handoffs,
                    campaign=campaign,
                    index=index,
                    formula=formula,
                    arch=arch,
                    dependency_merger=dependency_merger,
                )
            )
            validator(
                campaign,
                formula,
                arch,
                private_publication,
                private_source,
                prepared_commit,
            )
            if (
                filesystem_git_tree_oid(
                    private_source,
                    f"{formula_name}/{arch} prepared checkout",
                )
                != prepared_tree
            ):
                fail(
                    f"{formula_name}/{arch} prepared checkout changed "
                    "after validation"
                )
            validate_publication_shape(
                private_publication, formula, arch
            )
            records: list[dict[str, Any]] = []
            for relative in PUBLICATION_FILES:
                record = bound_records[relative]
                destination = result / record["path"]
                copied, digest = copy_verified(
                    private_publication / relative,
                    destination,
                    expected_bytes=record["bytes"],
                    expected_sha256=record["sha256"],
                )
                if (
                    copied != record["bytes"]
                    or digest != record["sha256"]
                ):
                    fail(
                        "private publication changed after validation"
                    )
                records.append(record)
            publication_records.append(
                {"arch": arch, "files": records, "kind": "build"}
            )
        manifest = {
            "campaign": {"sha256": sha256_bytes(campaign_payload)},
            "dependency_handoffs": dependency_records,
            "formula": campaign_formula_evidence(campaign, formula),
            "kind": "kandelo-homebrew-prefix-formula-handoff",
            "publications": publication_records,
            "schema": HANDOFF_SCHEMA,
            "source": {
                "kandelo_commit": campaign["authority"][
                    "kandelo_commit"
                ],
                "source_tap_commit": campaign["authority"][
                    "source_tap_commit"
                ],
                "target_tree_git_oid": source_tree_identity(
                    campaign["authority"]
                ),
                "tap_name": campaign["authority"]["tap_name"],
                "tap_repository": campaign["authority"][
                    "tap_repository"
                ],
            },
        }
        validate_dependency_records(
            manifest["dependency_handoffs"],
            dependency_identities,
        )
        (result / "handoff.json").write_bytes(pretty_json(manifest))
        load_handoff(result, campaign, campaign_payload)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def prepare_release(
    *,
    campaign_path: pathlib.Path,
    handoff_root: pathlib.Path,
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    handoff_root = real_directory(
        handoff_root, "Formula handoff root"
    )
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "prepared release output",
        (campaign_path, handoff_root, *dependency_roots),
    )
    handoff, handoff_payload = load_handoff(
        handoff_root, campaign, campaign_payload
    )
    name = require_string(
        handoff["formula"].get("name"), "handoff Formula", FORMULA
    )
    records, identities = validate_dependency_handoffs(
        dependency_roots,
        campaign,
        campaign_payload,
        index,
        name,
        (
            publication["arch"]
            for publication in handoff["publications"]
        ),
    )
    if handoff["dependency_handoffs"] != records:
        fail("Formula handoff dependency evidence changed before release")
    validate_dependency_records(handoff["dependency_handoffs"], identities)
    if handoff["formula"] != campaign_formula_evidence(
        campaign, index[name]
    ):
        fail("Formula handoff differs from its campaign Formula")
    validate_handoff_arches(handoff, index[name])
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        assets = temporary / "assets"
        assets.mkdir()
        asset_records: list[dict[str, Any]] = []
        handoff_asset = assets / "handoff.json"
        handoff_asset.write_bytes(handoff_payload)
        handoff_record = file_record(
            handoff_asset, "handoff.json", "handoff.json"
        )
        asset_records.append(
            {
                "bytes": handoff_record["bytes"],
                "name": "handoff.json",
                "sha256": handoff_record["sha256"],
            }
        )
        for publication in handoff["publications"]:
            for record in publication["files"]:
                source = handoff_root / record["path"]
                destination = assets / record["asset_name"]
                copied, digest = copy_verified(
                    source,
                    destination,
                    expected_bytes=record["bytes"],
                    expected_sha256=record["sha256"],
                )
                if copied != record["bytes"] or digest != record["sha256"]:
                    fail("prepared release asset changed while copied")
                asset_records.append(
                    {
                        "bytes": copied,
                        "name": record["asset_name"],
                        "sha256": digest,
                    }
                )
        asset_records.sort(key=lambda item: item["name"])
        tag = handoff_tag(handoff_payload)
        authority = campaign["authority"]
        release = {
            "accepted_existing_asset_sets": [],
            "assets": asset_records,
            "body": (
                f"Immutable {name} handoff for the Kandelo Homebrew "
                "guest-prefix campaign."
            ),
            "preferred_asset_names": [
                record["name"] for record in asset_records
            ],
            "repository": authority["tap_repository"].lower(),
            "schema": 1,
            "tag": tag,
            "target_commitish": authority["source_tap_commit"],
            "title": f"Kandelo Homebrew prefix handoff: {name}",
        }
        (temporary / "release-manifest.json").write_bytes(
            pretty_json(release)
        )
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def http_json(url: str, label: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "kandelo-homebrew-prefix-campaign",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=HTTP_TIMEOUT
        ) as response:
            payload = response.read(MAX_JSON_BYTES + 1)
    except (OSError, urllib.error.URLError) as error:
        fail(f"cannot fetch {label}: {error}")
    if not payload or len(payload) > MAX_JSON_BYTES:
        fail(f"{label} exceeds its JSON size bound")
    try:
        return json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is invalid JSON: {error}")


def http_asset(
    url: str,
    output: pathlib.Path,
    expected_bytes: int,
    expected_sha256: str,
) -> None:
    if not url.startswith("https://"):
        fail("release asset URL must use HTTPS")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "kandelo-homebrew-prefix-campaign"},
    )
    try:
        with urllib.request.urlopen(
            request, timeout=HTTP_TIMEOUT
        ) as response, output.open("xb") as destination:
            digest = hashlib.sha256()
            copied = 0
            while chunk := response.read(1024 * 1024):
                copied += len(chunk)
                if copied > expected_bytes:
                    fail("release asset exceeds its declared byte count")
                digest.update(chunk)
                destination.write(chunk)
    except ExecutorError:
        raise
    except (OSError, urllib.error.URLError) as error:
        fail(f"cannot fetch release asset: {error}")
    if copied != expected_bytes or digest.hexdigest() != expected_sha256:
        fail("release asset bytes differ from GitHub release evidence")


JsonFetcher = Callable[[str, str], Any]
AssetFetcher = Callable[[str, pathlib.Path, int, str], None]


def release_assets(
    repository: str,
    tag: str,
    *,
    json_fetcher: JsonFetcher = http_json,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    repository = require_string(repository, "release repository", REPOSITORY)
    tag = require_string(tag, "release tag")
    encoded = urllib.parse.quote(tag, safe="")
    release = json_fetcher(
        f"https://api.github.com/repos/{repository}/releases/tags/{encoded}",
        "GitHub release",
    )
    if not isinstance(release, dict):
        fail("GitHub release response must be an object")
    if (
        release.get("tag_name") != tag
        or release.get("draft") is not False
        or release.get("prerelease") is not False
        or release.get("immutable") is not True
        or not isinstance(release.get("id"), int)
        or release["id"] < 1
    ):
        fail("GitHub release is not the exact public immutable release")
    raw_assets = release.get("assets")
    if (
        not isinstance(raw_assets, list)
        or not raw_assets
        or len(raw_assets) > MAX_RELEASE_ASSETS
    ):
        fail("GitHub release asset inventory is invalid")
    assets: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(raw_assets):
        if not isinstance(value, dict):
            fail(f"GitHub release asset #{index} is invalid")
        name = require_string(
            value.get("name"),
            f"GitHub release asset #{index} name",
            ASSET_NAME,
        )
        if name in assets:
            fail(f"GitHub release repeats asset {name}")
        byte_count = require_int(
            value.get("size"),
            f"GitHub release asset {name} size",
            1,
            MAX_ASSET_BYTES,
        )
        digest_value = require_string(
            value.get("digest"),
            f"GitHub release asset {name} digest",
        )
        if not digest_value.startswith("sha256:"):
            fail(f"GitHub release asset {name} lacks a SHA-256 digest")
        digest = require_string(
            digest_value.removeprefix("sha256:"),
            f"GitHub release asset {name} SHA-256",
            SHA256,
        )
        require_int(
            value.get("id"),
            f"GitHub release asset {name} id",
            1,
        )
        if value.get("state") != "uploaded":
            fail(f"GitHub release asset {name} is not uploaded")
        download_url = require_string(
            value.get("browser_download_url"),
            f"GitHub release asset {name} URL",
        )
        expected_url = (
            f"https://github.com/{repository}/releases/download/"
            f"{urllib.parse.quote(tag, safe='')}/"
            f"{urllib.parse.quote(name, safe='')}"
        )
        if download_url.lower() != expected_url.lower():
            fail(f"GitHub release asset {name} has an unexpected URL")
        assets[name] = {
            "bytes": byte_count,
            "sha256": digest,
            "url": download_url,
        }
    return assets, release


def fetch_one_asset(
    assets: dict[str, dict[str, Any]],
    name: str,
    output: pathlib.Path,
    *,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    if name not in assets:
        fail(f"GitHub release lacks asset {name}")
    record = assets[name]
    asset_fetcher(
        record["url"],
        output,
        record["bytes"],
        record["sha256"],
    )


def commit_output_pair(
    staged_output: pathlib.Path,
    output: pathlib.Path,
    staged_receipt: pathlib.Path,
    receipt_output: pathlib.Path,
) -> None:
    regular_file(
        staged_receipt,
        "staged readback receipt",
        MAX_JSON_BYTES,
    )
    output_is_directory = staged_output.is_dir()
    committed = False
    try:
        # WHY: POSIX has no one-call commit for two arbitrary pathnames.
        # Install the data first, then publish the receipt; if the second
        # name loses a race, roll the data back so the whole command remains
        # safely retryable.
        if output_is_directory:
            os.rename(staged_output, output)
        else:
            regular_file(
                staged_output,
                "staged readback output",
                MAX_ASSET_BYTES,
            )
            os.link(staged_output, output)
        committed = True
        os.link(staged_receipt, receipt_output)
    except OSError as error:
        if committed:
            try:
                if output_is_directory:
                    os.rename(output, staged_output)
                else:
                    output.unlink()
            except OSError as rollback_error:
                fail(
                    "cannot roll back an incomplete readback commit: "
                    f"{rollback_error}"
                )
        fail(f"cannot commit readback output and receipt together: {error}")


def fetch_campaign_release(
    *,
    repository: str,
    tag: str,
    output: pathlib.Path,
    receipt_output: pathlib.Path,
    json_fetcher: JsonFetcher = http_json,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    match = CAMPAIGN_TAG.fullmatch(tag)
    if match is None:
        fail("campaign release tag is invalid")
    output, receipt_output = validate_output_pair(
        output,
        "campaign output",
        receipt_output,
        "campaign receipt output",
        (),
    )
    assets, release = release_assets(
        repository, tag, json_fetcher=json_fetcher
    )
    if set(assets) != {"campaign.json"}:
        fail("campaign release must contain exactly campaign.json")
    campaign_asset = assets["campaign.json"]
    if (
        campaign_asset["bytes"] > MAX_JSON_BYTES
        or campaign_asset["sha256"] != match.group(1)
    ):
        fail("campaign release evidence differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        staged = temporary / "campaign.json"
        fetch_one_asset(
            assets,
            "campaign.json",
            staged,
            asset_fetcher=asset_fetcher,
        )
        campaign, payload, _index = load_campaign(staged)
        if sha256_bytes(payload) != match.group(1):
            fail("campaign release tag differs from campaign.json")
        authority = campaign["authority"]
        if authority["tap_repository"].lower() != repository.lower():
            fail(
                "campaign release repository differs from campaign authority"
            )
        if release.get("target_commitish") != authority[
            "source_tap_commit"
        ]:
            fail("campaign release target differs from campaign authority")
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(
            pretty_json(
                {
                    "asset": {
                        "bytes": len(payload),
                        "name": "campaign.json",
                        "sha256": sha256_bytes(payload),
                    },
                    "kind": (
                        "kandelo-homebrew-prefix-campaign-readback"
                    ),
                    "release_id": release["id"],
                    "repository": repository.lower(),
                    "schema": 1,
                    "tag": tag,
                    "target_commitish": authority[
                        "source_tap_commit"
                    ],
                }
            )
        )
        commit_output_pair(
            staged,
            output,
            staged_receipt,
            receipt_output,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def fetch_release(
    *,
    campaign_path: pathlib.Path,
    tag: str,
    output: pathlib.Path,
    receipt_output: pathlib.Path,
    dependency_roots: list[pathlib.Path],
    json_fetcher: JsonFetcher = http_json,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    match = HANDOFF_TAG.fullmatch(tag)
    if match is None:
        fail("Formula handoff release tag is invalid")
    campaign, campaign_payload, index = load_campaign(campaign_path)
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output, receipt_output = validate_output_pair(
        output,
        "Formula handoff output",
        receipt_output,
        "Formula handoff receipt output",
        (campaign_path, *dependency_roots),
    )
    authority = campaign["authority"]
    assets, release = release_assets(
        authority["tap_repository"],
        tag,
        json_fetcher=json_fetcher,
    )
    if release.get("target_commitish") != authority["source_tap_commit"]:
        fail("Formula handoff release targets the wrong source commit")
    if "handoff.json" not in assets:
        fail("Formula handoff release lacks handoff.json")
    handoff_asset = assets["handoff.json"]
    if (
        handoff_asset["bytes"] > MAX_JSON_BYTES
        or handoff_asset["sha256"] != match.group(1)
    ):
        fail("Formula handoff release evidence differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        handoff_root = temporary / "handoff"
        handoff_root.mkdir()
        handoff_path = handoff_root / "handoff.json"
        fetch_one_asset(
            assets,
            "handoff.json",
            handoff_path,
            asset_fetcher=asset_fetcher,
        )
        handoff, handoff_payload = load_json_bytes(
            handoff_path, "downloaded Formula handoff manifest"
        )
        handoff, inventory, expected_assets = (
            validate_handoff_inventory(
                handoff,
                campaign,
                campaign_payload,
                handoff_payload,
            )
        )
        if sha256_bytes(handoff_payload) != match.group(1):
            fail("Formula handoff tag differs from handoff.json")
        if set(assets) != expected_assets:
            fail("Formula handoff release contains unexpected assets")
        for record in inventory:
            released = assets[record["asset_name"]]
            if (
                released["bytes"] != record["bytes"]
                or released["sha256"] != record["sha256"]
            ):
                fail(
                    "Formula handoff release evidence differs from "
                    "handoff.json"
                )
        formula_record = handoff["formula"]
        if not isinstance(formula_record, dict):
            fail("downloaded handoff Formula is invalid")
        name = require_string(
            formula_record.get("name"),
            "downloaded handoff Formula",
            FORMULA,
        )
        if name not in index or formula_record != (
            campaign_formula_evidence(campaign, index[name])
        ):
            fail("downloaded Formula handoff differs from the campaign")
        validate_handoff_arches(handoff, index[name])
        records, identities = validate_dependency_handoffs(
            dependency_roots,
            campaign,
            campaign_payload,
            index,
            name,
            (
                publication["arch"]
                for publication in handoff["publications"]
            ),
        )
        if handoff["dependency_handoffs"] != records:
            fail("downloaded Formula handoff dependency evidence is invalid")
        validate_dependency_records(
            handoff["dependency_handoffs"], identities
        )
        for record in inventory:
            destination = private_destination(
                handoff_root,
                record["path"],
                "downloaded handoff payload",
            )
            fetch_one_asset(
                assets,
                record["asset_name"],
                destination,
                asset_fetcher=asset_fetcher,
            )
            if (
                destination.stat().st_size != record["bytes"]
                or sha256_file(destination) != record["sha256"]
            ):
                fail(
                    "downloaded handoff payload differs from handoff.json"
                )
        load_handoff(handoff_root, campaign, campaign_payload)
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(
            pretty_json(
                {
                    "formula": name,
                    "handoff_sha256": match.group(1),
                    "kind": (
                        "kandelo-homebrew-prefix-handoff-readback"
                    ),
                    "release_id": release["id"],
                    "repository": authority[
                        "tap_repository"
                    ].lower(),
                    "schema": 1,
                    "tag": tag,
                    "target_commitish": authority[
                        "source_tap_commit"
                    ],
                }
            )
        )
        commit_output_pair(
            handoff_root,
            output,
            staged_receipt,
            receipt_output,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def parse_publication(value: str) -> tuple[str, pathlib.Path]:
    arch, separator, path = value.partition("=")
    if separator != "=" or arch not in ("wasm32", "wasm64") or not path:
        fail("--publication must be wasm32=<dir> or wasm64=<dir>")
    return arch, pathlib.Path(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    campaign = commands.add_parser("fetch-campaign-release")
    campaign.add_argument("--repository", required=True)
    campaign.add_argument("--tag", required=True)
    campaign.add_argument("--out", required=True)
    campaign.add_argument("--receipt-out", required=True)

    derive = commands.add_parser("derive-build")
    derive.add_argument("--campaign", required=True)
    derive.add_argument("--source-tap-root", required=True)
    derive.add_argument("--formula", required=True)
    derive.add_argument(
        "--publication", action="append", default=[], required=True
    )
    derive.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    derive.add_argument("--out", required=True)

    reuse = commands.add_parser("derive-reuse")
    reuse.add_argument("--campaign", required=True)
    reuse.add_argument("--source-tap-root", required=True)
    reuse.add_argument("--old-tap-root", required=True)
    reuse.add_argument("--formula", required=True)
    reuse.add_argument(
        "--arch", choices=("wasm32", "wasm64"), required=True
    )
    reuse.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    reuse.add_argument("--out", required=True)

    prepare = commands.add_parser("prepare-release")
    prepare.add_argument("--campaign", required=True)
    prepare.add_argument("--handoff", required=True)
    prepare.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    prepare.add_argument("--out", required=True)

    selection = commands.add_parser("prepare-selection")
    selection.add_argument("--campaign", required=True)
    selection.add_argument("--source-tap-root", required=True)
    selection.add_argument(
        "--root-formula", action="append", default=[], required=True
    )
    selection.add_argument(
        "--arch", choices=("wasm32", "wasm64"), required=True
    )
    selection.add_argument(
        "--handoff", action="append", default=[], required=True
    )
    selection.add_argument("--out", required=True)

    final_tap = commands.add_parser("prepare-final-tap")
    final_tap.add_argument("--campaign", required=True)
    final_tap.add_argument("--source-tap-root", required=True)
    final_tap.add_argument("--live-tap-root", required=True)
    final_tap.add_argument(
        "--handoff", action="append", default=[], required=True
    )
    final_tap.add_argument("--expected-live-commit", required=True)
    final_tap.add_argument(
        "--expected-live-tree-git-oid", required=True
    )
    final_tap.add_argument("--out", required=True)
    final_tap.add_argument("--finalization-out", required=True)

    final_commit = commands.add_parser("create-final-tap-commit")
    final_commit.add_argument("--candidate-tap-root", required=True)
    final_commit.add_argument("--finalization", required=True)
    final_commit.add_argument("--live-tap-root", required=True)
    final_commit.add_argument("--output-ref", required=True)
    final_commit.add_argument("--commit-receipt-out", required=True)

    fetch = commands.add_parser("fetch-release")
    fetch.add_argument("--campaign", required=True)
    fetch.add_argument("--tag", required=True)
    fetch.add_argument("--out", required=True)
    fetch.add_argument("--receipt-out", required=True)
    fetch.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "fetch-campaign-release":
            fetch_campaign_release(
                repository=arguments.repository,
                tag=arguments.tag,
                output=pathlib.Path(arguments.out),
                receipt_output=pathlib.Path(arguments.receipt_out),
            )
        elif arguments.command == "derive-build":
            derive_build(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(arguments.source_tap_root),
                formula_name=arguments.formula,
                publications=[
                    parse_publication(value)
                    for value in arguments.publication
                ],
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "derive-reuse":
            derive_reuse(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(
                    arguments.source_tap_root
                ),
                old_tap_root=pathlib.Path(arguments.old_tap_root),
                formula_name=arguments.formula,
                arch=arguments.arch,
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "prepare-release":
            prepare_release(
                campaign_path=pathlib.Path(arguments.campaign),
                handoff_root=pathlib.Path(arguments.handoff),
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "prepare-selection":
            prepare_selection(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(
                    arguments.source_tap_root
                ),
                roots=arguments.root_formula,
                arch=arguments.arch,
                handoff_roots=[
                    pathlib.Path(value)
                    for value in arguments.handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "prepare-final-tap":
            prepare_final_tap(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(
                    arguments.source_tap_root
                ),
                live_tap_root=pathlib.Path(arguments.live_tap_root),
                handoff_roots=[
                    pathlib.Path(value) for value in arguments.handoff
                ],
                expected_live_commit=arguments.expected_live_commit,
                expected_live_tree_git_oid=(
                    arguments.expected_live_tree_git_oid
                ),
                output=pathlib.Path(arguments.out),
                finalization_output=pathlib.Path(
                    arguments.finalization_out
                ),
            )
        elif arguments.command == "create-final-tap-commit":
            create_final_tap_commit(
                candidate_tap_root=pathlib.Path(
                    arguments.candidate_tap_root
                ),
                finalization_path=pathlib.Path(arguments.finalization),
                live_tap_root=pathlib.Path(arguments.live_tap_root),
                output_ref=arguments.output_ref,
                commit_receipt_output=pathlib.Path(
                    arguments.commit_receipt_out
                ),
            )
        elif arguments.command == "fetch-release":
            fetch_release(
                campaign_path=pathlib.Path(arguments.campaign),
                tag=arguments.tag,
                output=pathlib.Path(arguments.out),
                receipt_output=pathlib.Path(arguments.receipt_out),
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
            )
        else:
            raise AssertionError(arguments.command)
        return 0
    except (ExecutorError, OSError, UnicodeError) as error:
        print(
            f"homebrew-prefix-campaign-executor.py: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
