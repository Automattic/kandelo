#!/usr/bin/env python3
"""Seal, read, select, and compose prefix-campaign Formula handoffs."""

from __future__ import annotations

import argparse
import functools
import hashlib
import importlib.util
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
import zipfile
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
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
OCI_TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
RUST_TARGET = re.compile(r"^[a-z0-9_][a-z0-9_.-]{2,127}$")
CAMPAIGN_TAG = re.compile(
    r"^homebrew-prefix-campaign-sha256-([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
SELECTION_TAG = re.compile(
    r"^homebrew-prefix-selection-sha256-([0-9a-f]{64})$"
)
SAFE_PATH = re.compile(
    r"^[A-Za-z0-9_.+-]+(?:/[A-Za-z0-9_.+-]+)*$"
)
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_SUCCESSOR_SCOPE_BYTES = 4 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_FORMULAE = 256
MAX_VARIANTS = MAX_FORMULAE * 2
MAX_DEPENDENCIES = 256
MAX_RELEASE_ASSETS = 32
MAX_GITHUB_TOKEN_BYTES = 4 * 1024
MAX_SELECTION_FILES = 8_192
MAX_SELECTION_TREE_BYTES = 512 * 1024 * 1024
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
SELECTION_DESCRIPTOR_ASSET = "closed-selection.json"
SELECTION_ARCHIVE_ASSET = "closed-selection.zip"
SELECTION_ARCHIVE_WRITE_FORMAT = "zip-stored-v2"
SELECTION_ARCHIVE_READ_FORMATS = (
    "zip-stored-v1",
    SELECTION_ARCHIVE_WRITE_FORMAT,
)
MAX_SELECTION_SYMLINK_BYTES = 1024
CAMPAIGN_FORMULA_TOOL = ROOT / "scripts/homebrew_campaign_formula.py"


class ExecutorError(RuntimeError):
    """A fail-closed campaign handoff error."""


def fail(message: str) -> NoReturn:
    raise ExecutorError(message)


def load_tool(name: str, path: pathlib.Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        fail(f"cannot load reviewed tool {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


CAMPAIGN_FORMULA = load_tool(
    "homebrew_prefix_campaign_executor_formula",
    CAMPAIGN_FORMULA_TOOL,
)


def dev_shell_command(*arguments: str) -> list[str]:
    # WHY: repository tests may already be running inside dev-shell.sh. That
    # shell deliberately removes the Nix CLI from PATH, so nesting the wrapper
    # would fail even though every declared tool is already present.
    if os.environ.get("KANDELO_DEV_SHELL_TOOL_PATH"):
        return list(arguments)
    return [
        "bash",
        str(ROOT / "scripts/dev-shell.sh"),
        *arguments,
    ]


@functools.cache
def rustc_host_target() -> str:
    command = dev_shell_command("rustc", "-vV")
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot derive the Rust host target: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-4096:]
        fail(f"cannot derive the Rust host target: {detail}")
    host_lines = [
        line.removeprefix("host: ")
        for line in result.stdout.decode(
            "utf-8", errors="replace"
        ).splitlines()
        if line.startswith("host: ")
    ]
    if (
        len(host_lines) != 1
        or RUST_TARGET.fullmatch(host_lines[0]) is None
    ):
        fail("rustc did not report one valid host target")
    return host_lines[0]


def host_xtask_command(*arguments: str) -> list[str]:
    # WHY: Kandelo's Cargo default is the Wasm kernel target. These xtasks
    # execute on the runner, so leaving the target implicit tries to compile
    # the host-side publisher for Wasm before it can inspect a selection.
    return dev_shell_command(
        "cargo",
        "run",
        "--release",
        "-p",
        "xtask",
        "--target",
        rustc_host_target(),
        "--quiet",
        "--",
        *arguments,
    )


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


def dependency_names_for_field(
    formula: dict[str, Any],
    tap_name: str,
    field: str,
) -> tuple[str, ...]:
    values = formula.get(field)
    if not isinstance(values, list) or len(values) > MAX_DEPENDENCIES:
        fail(f"{formula.get('name')} {field} are invalid")
    prefix = f"{tap_name}/"
    result: list[str] = []
    prior = ""
    for index, value in enumerate(values):
        value = exact_keys(
            value,
            {"full_name", "version"},
            f"{formula.get('name')} {field} #{index}",
        )
        full_name = require_string(
            value["full_name"],
            f"{formula.get('name')} {field} #{index} full_name",
        )
        if not full_name.startswith(prefix):
            fail(f"campaign {field} entry is not a same-tap Formula")
        name = full_name.removeprefix(prefix)
        require_string(name, "campaign dependency name", FORMULA)
        require_string(
            value["version"], f"campaign {field} version", VERSION
        )
        if name <= prior:
            fail(f"campaign {field} must be unique and sorted")
        prior = name
        result.append(name)
    return tuple(result)


def dependency_names(
    formula: dict[str, Any],
    tap_name: str,
) -> tuple[str, ...]:
    return dependency_names_for_field(formula, tap_name, "dependencies")


def runtime_dependency_names(
    formula: dict[str, Any],
    tap_name: str,
) -> tuple[str, ...]:
    # WHY: old campaigns predate dependency scopes, so every recorded edge
    # was both a build-order edge and part of the installed guest closure.
    field = (
        "runtime_dependencies"
        if "runtime_dependencies" in formula
        else "dependencies"
    )
    return dependency_names_for_field(formula, tap_name, field)


def runtime_dependency_records(
    formula: dict[str, Any],
    tap_name: str,
) -> list[dict[str, str]]:
    # WHY: older sealed campaigns had one dependency field. Treat that field
    # as runtime identity only when the newer scoped field is absent, so their
    # immutable manifests and handoffs remain readable.
    field = (
        "runtime_dependencies"
        if "runtime_dependencies" in formula
        else "dependencies"
    )
    runtime_dependency_names(formula, tap_name)
    return formula[field]


def successor_scope_authority(
    authority: dict[str, Any],
    campaign_schema: int,
) -> dict[str, str] | None:
    value = authority.get("successor_scope")
    if value is None:
        # Legacy schema-3 campaigns sealed before overlap scopes remain valid.
        return None
    if campaign_schema != 3:
        fail("only a schema-3 campaign may name a successor scope")
    value = exact_keys(
        value,
        {"path", "sha256"},
        "campaign successor scope",
    )
    return {
        "path": safe_relative(
            value["path"], "campaign successor scope path"
        ),
        "sha256": require_string(
            value["sha256"],
            "campaign successor scope SHA-256",
            SHA256,
        ),
    }


def validate_successor_scope_checkout(
    source_tap_root: pathlib.Path,
    campaign: dict[str, Any],
) -> None:
    record = successor_scope_authority(
        campaign["authority"], campaign["schema"]
    )
    if record is None:
        return
    recovery = exact_keys(
        campaign["authority"].get("predecessor_recovery_source"),
        {"commit", "repository"},
        "campaign successor scope recovery source",
    )
    recovery_commit = require_string(
        recovery["commit"],
        "campaign successor scope recovery commit",
        COMMIT,
    )
    size_payload = run_git(
        source_tap_root,
        ["cat-file", "-s", f"{recovery_commit}:{record['path']}"],
        "campaign successor scope size",
        maximum=64,
    ).decode("ascii", errors="strict").strip()
    if (
        re.fullmatch(r"[1-9][0-9]*", size_payload) is None
        or int(size_payload, 10) > MAX_SUCCESSOR_SCOPE_BYTES
    ):
        fail("campaign successor scope has an invalid Git object size")
    payload = run_git(
        source_tap_root,
        ["show", f"{recovery_commit}:{record['path']}"],
        "campaign successor scope",
        maximum=MAX_SUCCESSOR_SCOPE_BYTES,
    )
    try:
        scope = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda item: fail(
                f"campaign successor scope contains invalid constant {item}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"campaign successor scope is not strict UTF-8 JSON: {error}")
    if payload != pretty_json(scope):
        fail("campaign successor scope is not canonical pretty JSON")
    if sha256_bytes(payload) != record["sha256"]:
        fail("campaign successor scope differs from its recovery authority")


def validate_predecessor_reuse_recovery_checkout(
    campaign: dict[str, Any],
    recovery_tap_root: pathlib.Path | None,
) -> pathlib.Path | None:
    scope = successor_scope_authority(
        campaign["authority"], campaign["schema"]
    )
    if recovery_tap_root is None:
        if scope is not None:
            fail("scoped predecessor reuse requires a recovery tap checkout")
        return None

    authority = campaign["authority"]
    recovery = exact_keys(
        authority.get("predecessor_recovery_source"),
        {"commit", "repository"},
        "predecessor reuse recovery source",
    )
    recovery_commit = require_string(
        recovery["commit"],
        "predecessor reuse recovery source commit",
        COMMIT,
    )
    recovery_repository = require_string(
        recovery["repository"],
        "predecessor reuse recovery source repository",
        REPOSITORY,
    )
    if recovery_repository.lower() != authority["tap_repository"].lower():
        fail("predecessor reuse recovery repository is inconsistent")
    recovery_tap_root = exact_git_checkout(
        recovery_tap_root,
        recovery_commit,
        "predecessor reuse recovery tap checkout",
    )
    if scope is not None:
        # WHY: a materialized target source intentionally excludes recovery
        # controls. A scoped reseal therefore needs this separate protected
        # checkout before it may produce any successor handoff bytes.
        validate_successor_scope_checkout(recovery_tap_root, campaign)
    return recovery_tap_root


def validate_destination_admission(
    formula: dict[str, Any],
    predecessor_campaign_tags: frozenset[str],
) -> frozenset[str]:
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
    legacy_admission = (
        admission["schema"] == 1
        and admission["method"] == "anonymous-oras-manifest-probe"
    )
    public_index_admission = (
        admission["schema"] == 2
        and admission["method"]
        == "anonymous-oras-public-index-probe"
    )
    if not legacy_admission and not public_index_admission:
        fail(f"campaign Formula {name} destination admission is invalid")
    if legacy_admission:
        probe = exact_keys(
            admission["probe"],
            {"digest", "kind", "schema", "status"},
            f"campaign Formula {name} destination probe",
        )
        if probe["schema"] != 1 or probe["kind"] != "manifest":
            fail(f"campaign Formula {name} destination probe is invalid")
        observed_arches: frozenset[str] | None = None
    else:
        probe = exact_keys(
            admission["probe"],
            {
                "children",
                "digest",
                "kind",
                "schema",
                "size",
                "status",
            },
            f"campaign Formula {name} destination probe",
        )
        children = probe["children"]
        if (
            probe["schema"] != 1
            or probe["kind"] != "public-index"
            or not isinstance(children, list)
        ):
            fail(f"campaign Formula {name} destination probe is invalid")
        child_arches: list[str] = []
        for position, child in enumerate(children):
            child = exact_keys(
                child,
                {
                    "arch",
                    "bottle_sha256",
                    "bottle_size",
                    "homebrew_ref",
                    "manifest_digest",
                    "manifest_size",
                },
                f"campaign Formula {name} destination child {position}",
            )
            arch = child["arch"]
            if (
                arch not in ("wasm32", "wasm64")
                or not isinstance(child["bottle_sha256"], str)
                or SHA256.fullmatch(child["bottle_sha256"]) is None
                or not isinstance(child["bottle_size"], int)
                or isinstance(child["bottle_size"], bool)
                or not 1 <= child["bottle_size"] <= MAX_ASSET_BYTES
                or not isinstance(child["homebrew_ref"], str)
                or OCI_TAG.fullmatch(child["homebrew_ref"]) is None
                or not isinstance(child["manifest_digest"], str)
                or OCI_DIGEST.fullmatch(child["manifest_digest"]) is None
                or not isinstance(child["manifest_size"], int)
                or isinstance(child["manifest_size"], bool)
                or not 1 <= child["manifest_size"] <= MAX_JSON_BYTES
            ):
                fail(
                    f"campaign Formula {name} destination child "
                    f"{position} is invalid"
                )
            child_arches.append(arch)
        if child_arches != sorted(set(child_arches)):
            fail(
                f"campaign Formula {name} destination children are not "
                "a canonical architecture set"
            )
        observed_arches = frozenset(child_arches)
    kind = admission["kind"]
    variants = formula.get("variants")
    if kind == "archived-predecessor-exact-presence":
        digest = probe["digest"]
        if (
            probe["status"] != "present"
            or not isinstance(digest, str)
            or OCI_DIGEST.fullmatch(digest) is None
            or (
                public_index_admission
                and (
                    not isinstance(probe["size"], int)
                    or isinstance(probe["size"], bool)
                    or not 1 <= probe["size"] <= MAX_JSON_BYTES
                    or not observed_arches
                )
            )
            or not isinstance(variants, list)
            or not variants
        ):
            fail(
                f"campaign Formula {name} predecessor presence is invalid"
            )
        used: set[str] = set()
        reuse_arches: set[str] = set()
        variant_arches: set[str] = set()
        for variant in variants:
            if not isinstance(variant, dict):
                fail(
                    f"campaign Formula {name} predecessor variant is invalid"
                )
            arch = variant.get("arch")
            if arch not in ("wasm32", "wasm64") or arch in variant_arches:
                fail(
                    f"campaign Formula {name} predecessor variant is invalid"
                )
            variant_arches.add(arch)
            if "reuse_source" not in variant:
                if legacy_admission or arch in (observed_arches or ()):
                    fail(
                        f"campaign Formula {name}/{arch} predecessor source "
                        "is missing"
                    )
                continue
            source = exact_keys(
                variant.get("reuse_source"),
                {"arch", "campaign_tag", "handoff_tag", "kind"},
                f"campaign Formula {name}/{arch} predecessor source",
            )
            if (
                source["kind"] != "predecessor-handoff"
                or source["arch"] != arch
            ):
                fail(
                    f"campaign Formula {name}/{arch} predecessor source "
                    "is invalid"
                )
            campaign_tag = require_string(
                source["campaign_tag"],
                f"campaign Formula {name}/{arch} predecessor campaign tag",
                CAMPAIGN_TAG,
            )
            require_string(
                source["handoff_tag"],
                f"campaign Formula {name}/{arch} predecessor handoff tag",
                HANDOFF_TAG,
            )
            if campaign_tag not in predecessor_campaign_tags:
                fail(
                    f"campaign Formula {name}/{arch} predecessor campaign "
                    "is not archived"
                )
            used.add(campaign_tag)
            reuse_arches.add(arch)
        if public_index_admission and (
            frozenset(reuse_arches) != observed_arches
            or not observed_arches.issubset(variant_arches)
        ):
            fail(
                f"campaign Formula {name} predecessor inventory differs "
                "from its reuse sources"
            )
        return frozenset(used)
    if isinstance(variants, list) and any(
        isinstance(variant, dict) and "reuse_source" in variant
        for variant in variants
    ):
        fail(
            f"campaign Formula {name} predecessor source has no exact "
            "destination"
        )
    if kind == "anonymous-absence":
        if (
            probe["status"] != "missing"
            or probe["digest"] is not None
            or (
                public_index_admission
                and (probe["size"] is not None or probe["children"] != [])
            )
        ):
            fail(
                f"campaign Formula {name} anonymous absence is invalid"
            )
        return frozenset()
    if kind != "first-package-namespace-bootstrap-required":
        fail(f"campaign Formula {name} destination admission is invalid")
    if (
        probe["status"] != "auth-required"
        or probe["digest"] is not None
        or (
            public_index_admission
            and (probe["size"] is not None or probe["children"] != [])
        )
    ):
        fail(f"campaign Formula {name} namespace bootstrap probe is invalid")

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
    return frozenset()


def validate_predecessor_recovery_authority(
    authority: dict[str, Any],
    campaign_schema: int,
) -> frozenset[str]:
    records = authority.get("predecessor_recovery")
    recovery_source = authority.get("predecessor_recovery_source")
    if campaign_schema == 2:
        if records is not None or recovery_source is not None:
            fail("schema-2 campaign cannot name predecessor recovery")
        return frozenset()
    recovery_source = exact_keys(
        recovery_source,
        {"commit", "repository"},
        "predecessor recovery source",
    )
    require_string(
        recovery_source["commit"],
        "predecessor recovery source commit",
        COMMIT,
    )
    recovery_repository = require_string(
        recovery_source["repository"],
        "predecessor recovery source repository",
        REPOSITORY,
    )
    if recovery_repository.lower() != authority["tap_repository"].lower():
        fail("predecessor recovery source repository is inconsistent")
    if not isinstance(records, list) or not records:
        fail("schema-3 campaign lacks predecessor recovery authority")
    paths: list[str] = []
    tags: set[str] = set()
    for position, record in enumerate(records):
        record = exact_keys(
            record,
            {
                "activation_commit",
                "archive",
                "campaign",
                "kandelo_commit",
                "source_tap_commit",
                "target_tree_git_oid",
            },
            f"predecessor recovery #{position}",
        )
        for key in (
            "activation_commit",
            "kandelo_commit",
            "source_tap_commit",
            "target_tree_git_oid",
        ):
            require_string(
                record[key], f"predecessor recovery #{position} {key}", COMMIT
            )
        archive = exact_keys(
            record["archive"],
            {"path", "sha256"},
            f"predecessor recovery #{position} archive",
        )
        campaign = exact_keys(
            record["campaign"],
            {"sha256", "tag"},
            f"predecessor recovery #{position} campaign",
        )
        path = safe_relative(
            archive["path"],
            f"predecessor recovery #{position} archive path",
        )
        archive_sha256 = require_string(
            archive["sha256"],
            f"predecessor recovery #{position} archive SHA-256",
            SHA256,
        )
        campaign_sha256 = require_string(
            campaign["sha256"],
            f"predecessor recovery #{position} campaign SHA-256",
            SHA256,
        )
        tag = require_string(
            campaign["tag"],
            f"predecessor recovery #{position} campaign tag",
            CAMPAIGN_TAG,
        )
        tag_match = CAMPAIGN_TAG.fullmatch(tag)
        if (
            tag_match is None
            or tag_match.group(1) != campaign_sha256
            or path
            != (
                "Kandelo/campaigns/prefix-v1/aborted-campaigns/"
                f"{campaign_sha256}.json"
            )
            or tag in tags
        ):
            fail(
                f"predecessor recovery #{position} is not content-addressed"
            )
        paths.append(path)
        tags.add(tag)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        fail("predecessor recovery archives must be unique and sorted")
    return frozenset(tags)


def validate_previous_formula_version(formula: dict[str, Any]) -> None:
    if "previous_version" not in formula:
        return
    name = formula["name"]
    previous_version = require_string(
        formula["previous_version"],
        f"campaign Formula {name} previous version",
        VERSION,
    )
    observed: set[str] = set()
    for variant in formula["variants"]:
        arch = variant["arch"]
        old_record = variant.get("old_record")
        if not isinstance(old_record, dict):
            fail(
                f"campaign Formula {name} previous version lacks "
                f"{arch} old bottle evidence"
            )
        old_record_sha256 = require_string(
            variant.get("old_record_sha256"),
            f"campaign Formula {name}/{arch} old record SHA-256",
            SHA256,
        )
        if sha256_bytes(canonical_json(old_record)) != old_record_sha256:
            fail(
                f"campaign Formula {name}/{arch} old record differs "
                "from its digest"
            )
        link_manifest = require_string(
            old_record.get("link_manifest"),
            f"campaign Formula {name}/{arch} old link manifest",
        )
        prefix = f"Kandelo/link/{name}-"
        suffix = f"-{arch}.json"
        if not link_manifest.startswith(prefix) or not link_manifest.endswith(
            suffix
        ):
            fail(
                f"campaign Formula {name}/{arch} old link manifest is "
                "not canonical"
            )
        identity = link_manifest[len(prefix) : -len(suffix)]
        match = re.fullmatch(
            r"(.+)-rebuild(?:0|[1-9][0-9]*)",
            identity,
        )
        if match is None or VERSION.fullmatch(match.group(1)) is None:
            fail(
                f"campaign Formula {name}/{arch} old link manifest has "
                "no canonical version"
            )
        observed.add(match.group(1))
    if observed != {previous_version}:
        fail(
            f"campaign Formula {name} previous version differs from its "
            "old bottle evidence"
        )


def load_campaign(
    path: pathlib.Path,
) -> tuple[dict[str, Any], bytes, dict[str, dict[str, Any]]]:
    value, payload = load_json_bytes(path, "campaign manifest")
    if (
        not isinstance(value, dict)
        or value.get("schema") not in (2, 3)
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
    predecessor_campaign_tags = validate_predecessor_recovery_authority(
        authority, value["schema"]
    )
    successor_scope_authority(authority, value["schema"])
    formulae = value.get("formulae")
    if (
        not isinstance(formulae, list)
        or not formulae
        or len(formulae) > MAX_FORMULAE
    ):
        fail("campaign Formula inventory is invalid")
    index: dict[str, dict[str, Any]] = {}
    prior = ""
    used_predecessor_campaign_tags: set[str] = set()
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
        validate_previous_formula_version(formula)
        used_predecessor_campaign_tags.update(
            validate_destination_admission(
                formula, predecessor_campaign_tags
            )
        )
        index[name] = formula
    if used_predecessor_campaign_tags != set(predecessor_campaign_tags):
        fail("campaign predecessor recovery authority is not used exactly")
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
        runtime_records = runtime_dependency_records(formula, tap_name)
        by_name = {
            dependency: edge
            for dependency, edge in zip(
                dependencies,
                formula["dependencies"],
                strict=True,
            )
        }
        expected_runtime = [
            by_name[dependency]
            for dependency in sorted(
                dependency_names_for_field(
                    formula,
                    tap_name,
                    (
                        "runtime_dependencies"
                        if "runtime_dependencies" in formula
                        else "dependencies"
                    ),
                )
            )
            if dependency in by_name
        ]
        if runtime_records != expected_runtime:
            fail(
                f"campaign Formula {name} runtime dependencies are not "
                "an exact scheduling-dependency subset"
            )
    return value, payload, index


def dependency_closure_with(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
    dependency_reader: Callable[
        [dict[str, Any], str], tuple[str, ...]
    ],
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
        for dependency in dependency_reader(index[name], tap_name):
            visit(dependency)
        visiting.remove(name)
        reached.add(name)

    for name in dependency_reader(index[formula_name], tap_name):
        visit(name)
    return tuple(sorted(reached))


def dependency_closure(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
) -> tuple[str, ...]:
    """Return every dependency needed to build and test one Formula."""
    return dependency_closure_with(
        campaign,
        index,
        formula_name,
        dependency_names,
    )


def runtime_dependency_closure(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
) -> tuple[str, ...]:
    """Return only dependencies installed with one Formula in a guest."""
    return dependency_closure_with(
        campaign,
        index,
        formula_name,
        runtime_dependency_names,
    )


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
    guest_cellar = campaign_guest_layout(campaign)["cellar"]
    # WHY: Homebrew uses these symbolic values for relocatable bottles.  The
    # generated Kandelo sidecar still owns the concrete guest placement.
    # Accept only those upstream markers or the exact campaign Cellar; an old
    # retired host path, unknown marker, or other absolute path remains a hard
    # failure.
    if cellar not in (guest_cellar, "any", "any_skip_relocation"):
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
        "dependencies": formula.get(
            "runtime_dependencies",
            formula["dependencies"],
        ),
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


def validate_predecessor_reuse_variant(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    name = formula["name"]
    variant = campaign_variant(formula, arch)
    if not isinstance(variant, dict) or variant.get("arch") != arch:
        fail(f"{name}/{arch} predecessor reuse variant is invalid")
    source = exact_keys(
        variant.get("reuse_source"),
        {"arch", "campaign_tag", "handoff_tag", "kind"},
        f"{name}/{arch} predecessor reuse source",
    )
    if source["kind"] != "predecessor-handoff" or source["arch"] != arch:
        fail(f"{name}/{arch} predecessor reuse source is invalid")
    require_string(
        source["campaign_tag"],
        f"{name}/{arch} predecessor campaign tag",
        CAMPAIGN_TAG,
    )
    require_string(
        source["handoff_tag"],
        f"{name}/{arch} predecessor handoff tag",
        HANDOFF_TAG,
    )
    admission = formula.get("destination", {}).get("admission")
    if (
        not isinstance(admission, dict)
        or admission.get("kind")
        != "archived-predecessor-exact-presence"
        or not isinstance(admission.get("probe"), dict)
        or admission["probe"].get("status") != "present"
        or not isinstance(admission["probe"].get("digest"), str)
        or OCI_DIGEST.fullmatch(admission["probe"]["digest"]) is None
    ):
        fail(f"{name}/{arch} has no exact predecessor destination")
    return variant, source


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
    expected_dependencies = runtime_dependency_records(
        formula,
        campaign["authority"]["tap_name"],
    )
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
        for value in runtime_dependency_records(
            formula,
            campaign["authority"]["tap_name"],
        )
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


def predecessor_reuse_inputs(
    *,
    campaign: dict[str, Any],
    formula: dict[str, Any],
    handoff_root: pathlib.Path,
    handoff: dict[str, Any],
    arch: str,
    expected_formula_source_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    name = formula["name"]
    expected_formula_source_sha256 = require_string(
        expected_formula_source_sha256,
        f"predecessor {name}/{arch} Formula source SHA-256",
        SHA256,
    )
    publication = handoff_publication(
        handoff, arch, f"predecessor {name}/{arch}"
    )
    kind = publication_kind(
        publication, f"predecessor {name}/{arch} publication"
    )
    archive_path = (
        f"payload/{arch}/"
        + publication_semantic_path(
            publication,
            "bottle_archive",
            f"predecessor {name}/{arch}",
        )
    )
    bottle_json_path = (
        f"payload/{arch}/"
        + publication_semantic_path(
            publication,
            "bottle_json",
            f"predecessor {name}/{arch}",
        )
    )
    sidecars_path = (
        f"payload/{arch}/"
        + publication_semantic_path(
            publication,
            "sidecars_input",
            f"predecessor {name}/{arch}",
        )
    )
    archive_record = handoff_publication_file(
        publication,
        archive_path,
        f"predecessor {name}/{arch}",
    )
    bottle_json_record = handoff_publication_file(
        publication,
        bottle_json_path,
        f"predecessor {name}/{arch}",
    )
    sidecars_record = handoff_publication_file(
        publication,
        sidecars_path,
        f"predecessor {name}/{arch}",
    )
    _canonical, bottle_digest, _root_url, _cellar = (
        validate_dependency_bottle_input(
            bottle_json=handoff_root / bottle_json_record["path"],
            handoff=handoff,
            arch=arch,
            archive_record=archive_record,
            campaign=campaign,
        )
    )
    if bottle_digest != archive_record["sha256"]:
        fail(f"predecessor {name}/{arch} bottle digest is inconsistent")

    sidecars, _sidecars_payload = load_json_bytes(
        handoff_root / sidecars_record["path"],
        f"predecessor {name}/{arch} sidecars input",
    )
    sidecars = exact_keys(
        sidecars,
        {
            "generated_at",
            "generator",
            "kandelo_abi",
            "kandelo_commit",
            "kandelo_repository",
            "packages",
            "release_tag",
            "schema",
            "tap_commit",
            "tap_name",
            "tap_repository",
        },
        f"predecessor {name}/{arch} sidecars input",
    )
    authority = campaign["authority"]
    packages = sidecars["packages"]
    if not isinstance(packages, list) or len(packages) != 1:
        fail(f"predecessor {name}/{arch} sidecars lack one package")
    package = exact_keys(
        packages[0],
        {
            "bottle_rebuild",
            "bottles",
            "dependencies",
            "formula_path",
            "formula_revision",
            "formula_source_sha256",
            "full_name",
            "name",
            "version",
        },
        f"predecessor {name}/{arch} package",
    )
    dependencies: list[dict[str, str]] = []
    if not isinstance(package["dependencies"], list):
        fail(f"predecessor {name}/{arch} dependencies are invalid")
    for position, dependency in enumerate(package["dependencies"]):
        dependency = exact_keys(
            dependency,
            {"full_name", "name", "version"},
            f"predecessor {name}/{arch} dependency #{position}",
        )
        if dependency["full_name"] != (
            f"{authority['tap_name']}/{dependency['name']}"
        ):
            fail(f"predecessor {name}/{arch} dependency is ambiguous")
        dependencies.append(
            {
                "full_name": dependency["full_name"],
                "version": dependency["version"],
            }
        )
    bottles = package["bottles"]
    if not isinstance(bottles, list) or len(bottles) != 1:
        fail(f"predecessor {name}/{arch} package has no exact bottle")
    bottle = bottles[0]
    required_bottle_keys = {
        "arch",
        "archived_formula_sha256",
        "bottle_file",
        "bottle_tag",
        "browser_compatible",
        "build",
        "built_at",
        "built_by",
        "cache_key_sha",
        "cellar",
        "env",
        "fork_instrumentation",
        "links",
        "payload_root",
        "prefix",
        "receipts",
        "runtime_support",
        "status",
        "url",
        "validation",
    }
    if (
        not isinstance(bottle, dict)
        or not required_bottle_keys <= set(bottle)
        or not set(bottle) <= required_bottle_keys | {"built_from", "keg"}
    ):
        fail(f"predecessor {name}/{arch} bottle is ambiguous")
    expected_file = f"../{kind}/bottle.tar.gz"
    expected_url = (
        "https://ghcr.io/v2/"
        f"{authority['tap_repository'].lower()}/{name}/"
        f"blobs/sha256:{archive_record['sha256']}"
    )
    layout = campaign_guest_layout(campaign)
    if (
        sidecars["schema"] != 1
        or sidecars["kandelo_abi"] != authority["current_kandelo_abi"]
        or sidecars["kandelo_commit"] != authority["kandelo_commit"]
        or require_string(
            sidecars["kandelo_repository"],
            f"predecessor {name}/{arch} Kandelo repository",
            REPOSITORY,
        ).lower()
        != "automattic/kandelo"
        or sidecars["release_tag"]
        != f"bottles-abi-v{authority['current_kandelo_abi']}"
        or sidecars["tap_commit"] != authority["source_tap_commit"]
        or sidecars["tap_name"] != authority["tap_name"]
        or require_string(
            sidecars["tap_repository"],
            f"predecessor {name}/{arch} tap repository",
            REPOSITORY,
        ).lower()
        != authority["tap_repository"].lower()
        or package["name"] != name
        or package["full_name"] != f"{authority['tap_name']}/{name}"
        or package["version"] != formula["version"]
        or package["bottle_rebuild"]
        != formula["destination"]["bottle_rebuild"]
        or package["formula_path"] != f"Formula/{name}.rb"
        or package["formula_source_sha256"]
        != expected_formula_source_sha256
        or dependencies
        != runtime_dependency_records(
            formula,
            campaign["authority"]["tap_name"],
        )
        or bottle["arch"] != arch
        or bottle["bottle_tag"] != f"{arch}_kandelo"
        or bottle["bottle_file"] != expected_file
        or bottle["cache_key_sha"] != archive_record["sha256"]
        or bottle["cellar"] != layout["cellar"]
        or bottle["prefix"] != layout["prefix"]
        or bottle["status"] != "success"
        or bottle["url"] != expected_url
    ):
        fail(f"predecessor {name}/{arch} sidecars are inconsistent")
    if not isinstance(package["formula_revision"], int) or isinstance(
        package["formula_revision"], bool
    ):
        fail(f"predecessor {name}/{arch} Formula revision is invalid")
    archived_formula_sha256 = require_string(
        bottle["archived_formula_sha256"],
        f"predecessor {name}/{arch} archived Formula SHA-256",
        SHA256,
    )
    if not isinstance(bottle["browser_compatible"], bool):
        fail(f"predecessor {name}/{arch} browser compatibility is invalid")
    for field in ("build", "env", "validation"):
        if not isinstance(bottle[field], dict):
            fail(f"predecessor {name}/{arch} {field} is invalid")
    for field in ("links", "receipts", "runtime_support"):
        if not isinstance(bottle[field], list):
            fail(f"predecessor {name}/{arch} {field} is invalid")
    if bottle["fork_instrumentation"] not in (
        "disabled",
        "not-required",
        "required",
        "unknown",
    ):
        fail(f"predecessor {name}/{arch} fork instrumentation is invalid")
    built_at = require_string(
        bottle["built_at"], f"predecessor {name}/{arch} built_at"
    )
    built_by = require_string(
        bottle["built_by"], f"predecessor {name}/{arch} built_by"
    )
    if not built_by.startswith("https://"):
        fail(f"predecessor {name}/{arch} built_by is not HTTPS")
    if "built_from" in bottle:
        built_from = validate_built_from_record(
            bottle["built_from"],
            f"predecessor {name}/{arch} built_from",
        )
    else:
        # WHY: a build handoff records its producer at the sidecar root,
        # while a reuse handoff already carries the older producer inside the
        # bottle.  Normalize both forms without claiming the successor built
        # bytes that it only revalidated.
        built_from = {
            "formula_sha256": archived_formula_sha256,
            "kandelo_commit": sidecars["kandelo_commit"],
            "kandelo_repository": sidecars["kandelo_repository"],
            "tap_commit": sidecars["tap_commit"],
            "tap_repository": sidecars["tap_repository"],
        }
        validate_built_from_record(
            built_from, f"predecessor {name}/{arch} synthesized producer"
        )
    return (
        {
            "archived_formula_sha256": archived_formula_sha256,
            "browser_compatible": bottle["browser_compatible"],
            "build": bottle["build"],
            "built_at": built_at,
            "built_by": built_by,
            "built_from": built_from,
            "cache_key_sha": bottle["cache_key_sha"],
            "env": bottle["env"],
            "fork_instrumentation": bottle["fork_instrumentation"],
            "formula_revision": package["formula_revision"],
            "links": bottle["links"],
            "payload_root": require_string(
                bottle["payload_root"],
                f"predecessor {name}/{arch} payload root",
            ),
            "receipts": bottle["receipts"],
            "runtime_support": bottle["runtime_support"],
            "url": bottle["url"],
            "validation": bottle["validation"],
        },
        archive_record,
    )


def predecessor_reuse_sidecars_input(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    extracted: dict[str, Any],
) -> dict[str, Any]:
    authority = campaign["authority"]
    layout = campaign_guest_layout(campaign)
    name = formula["name"]
    dependencies = [
        {
            "full_name": value["full_name"],
            "name": value["full_name"].rsplit("/", 1)[1],
            "version": value["version"],
        }
        for value in runtime_dependency_records(
            formula,
            campaign["authority"]["tap_name"],
        )
    ]
    return {
        "generated_at": extracted["built_at"],
        "generator": "Kandelo Homebrew predecessor handoff reseal",
        "kandelo_abi": authority["current_kandelo_abi"],
        "kandelo_commit": authority["kandelo_commit"],
        "kandelo_repository": "Automattic/kandelo",
        "packages": [
            {
                "bottle_rebuild": formula["destination"]["bottle_rebuild"],
                "bottles": [
                    {
                        "arch": arch,
                        "archived_formula_sha256": extracted[
                            "archived_formula_sha256"
                        ],
                        "bottle_file": "../reuse/bottle.tar.gz",
                        "bottle_tag": f"{arch}_kandelo",
                        "browser_compatible": extracted[
                            "browser_compatible"
                        ],
                        "build": extracted["build"],
                        "built_at": extracted["built_at"],
                        "built_by": extracted["built_by"],
                        "built_from": extracted["built_from"],
                        "cache_key_sha": extracted["cache_key_sha"],
                        "cellar": layout["cellar"],
                        "env": extracted["env"],
                        "fork_instrumentation": extracted[
                            "fork_instrumentation"
                        ],
                        "keg": (
                            f"{layout['cellar']}/{name}/{formula['version']}"
                        ),
                        "links": extracted["links"],
                        "payload_root": extracted["payload_root"],
                        "prefix": layout["prefix"],
                        "receipts": extracted["receipts"],
                        "runtime_support": extracted["runtime_support"],
                        "status": "success",
                        "url": extracted["url"],
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
        "release_tag": f"bottles-abi-v{authority['current_kandelo_abi']}",
        "schema": 1,
        "tap_commit": authority["source_tap_commit"],
        "tap_name": authority["tap_name"],
        "tap_repository": authority["tap_repository"],
    }


def predecessor_reuse_evidence_document(
    *,
    campaign_payload: bytes,
    formula: dict[str, Any],
    variant: dict[str, Any],
    arch: str,
    extracted: dict[str, Any],
    predecessor: dict[str, Any],
    destination: dict[str, Any],
    dependency_bottles: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "arch": arch,
        "campaign_sha256": sha256_bytes(campaign_payload),
        "dependency_bottles": dependency_bottles,
        "destination": destination,
        "extracted": extracted,
        "formula": formula["name"],
        "kind": "kandelo-homebrew-prefix-predecessor-reuse-publication",
        "predecessor": predecessor,
        "schema": (
            3 if "admission_manifest_digest" in destination else 2
        ),
        "variant_sha256": sha256_bytes(canonical_json(variant)),
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


def predecessor_recovery_record(
    campaign: dict[str, Any],
    campaign_tag: str,
) -> dict[str, Any]:
    records = campaign["authority"].get("predecessor_recovery")
    if not isinstance(records, list):
        fail("campaign lacks predecessor recovery authority")
    matching = [
        record
        for record in records
        if isinstance(record, dict)
        and isinstance(record.get("campaign"), dict)
        and record["campaign"].get("tag") == campaign_tag
    ]
    if len(matching) != 1:
        fail("predecessor campaign has no unique recovery authority")
    return matching[0]


def validate_predecessor_reuse_publication_shape(
    publication: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    evidence: dict[str, Any],
) -> None:
    name = formula["name"]
    variant, reuse_source = validate_predecessor_reuse_variant(
        campaign, formula, arch
    )
    evidence = exact_keys(
        evidence,
        {
            "arch",
            "campaign_sha256",
            "dependency_bottles",
            "destination",
            "extracted",
            "formula",
            "kind",
            "predecessor",
            "schema",
            "variant_sha256",
        },
        f"{name}/{arch} predecessor reuse evidence",
    )
    if (
        evidence["schema"] not in (2, 3)
        or evidence["kind"]
        != "kandelo-homebrew-prefix-predecessor-reuse-publication"
        or evidence["arch"] != arch
        or evidence["formula"] != name
        or evidence["campaign_sha256"]
        != sha256_bytes(pretty_json(campaign))
        or evidence["variant_sha256"]
        != sha256_bytes(canonical_json(variant))
    ):
        fail(f"{name}/{arch} predecessor reuse evidence is invalid")
    predecessor = exact_keys(
        evidence["predecessor"],
        {
            "bottle",
            "campaign_sha256",
            "campaign_tag",
            "handoff_sha256",
            "handoff_tag",
            "publication_kind",
            "source",
        },
        f"{name}/{arch} predecessor identity",
    )
    campaign_match = CAMPAIGN_TAG.fullmatch(
        require_string(
            predecessor["campaign_tag"],
            f"{name}/{arch} predecessor campaign tag",
        )
    )
    handoff_match = HANDOFF_TAG.fullmatch(
        require_string(
            predecessor["handoff_tag"],
            f"{name}/{arch} predecessor handoff tag",
        )
    )
    if campaign_match is None or handoff_match is None:
        fail(f"{name}/{arch} predecessor tags are not content-addressed")
    if (
        predecessor["campaign_tag"] != reuse_source["campaign_tag"]
        or predecessor["handoff_tag"] != reuse_source["handoff_tag"]
        or predecessor["campaign_sha256"] != campaign_match.group(1)
        or predecessor["handoff_sha256"] != handoff_match.group(1)
        or predecessor["publication_kind"] not in ("build", "reuse")
    ):
        fail(f"{name}/{arch} predecessor identity is inconsistent")
    bottle = exact_keys(
        predecessor["bottle"],
        {"bytes", "sha256"},
        f"{name}/{arch} predecessor bottle",
    )
    bottle_bytes = require_int(
        bottle["bytes"],
        f"{name}/{arch} predecessor bottle bytes",
        1,
        MAX_ASSET_BYTES,
    )
    bottle_sha256 = require_string(
        bottle["sha256"],
        f"{name}/{arch} predecessor bottle SHA-256",
        SHA256,
    )
    source = exact_keys(
        predecessor["source"],
        {
            "kandelo_commit",
            "source_tap_commit",
            "target_tree_git_oid",
            "tap_name",
            "tap_repository",
        },
        f"{name}/{arch} predecessor source",
    )
    for key in (
        "kandelo_commit",
        "source_tap_commit",
        "target_tree_git_oid",
    ):
        require_string(
            source[key], f"{name}/{arch} predecessor {key}", COMMIT
        )
    authority = campaign["authority"]
    recovery = predecessor_recovery_record(
        campaign, predecessor["campaign_tag"]
    )
    # WHY: This evidence describes the tree that produced the old bottle.
    # Bind it to the successor's exact recovery authority; comparing it with
    # the successor tree would make an unrelated Formula rebuild invalidate
    # otherwise unchanged predecessor bytes.
    if (
        source["kandelo_commit"] != recovery["kandelo_commit"]
        or source["source_tap_commit"] != recovery["source_tap_commit"]
        or source["target_tree_git_oid"]
        != recovery["target_tree_git_oid"]
        or source["tap_name"] != authority["tap_name"]
        or require_string(
            source["tap_repository"],
            f"{name}/{arch} predecessor tap repository",
            REPOSITORY,
        ).lower()
        != authority["tap_repository"].lower()
    ):
        fail(f"{name}/{arch} predecessor source closure changed")
    admission = formula["destination"]["admission"]
    if evidence["schema"] == 2:
        destination = exact_keys(
            evidence["destination"],
            {
                "manifest_digest",
                "reference",
                "remote",
                "source_closure_sha256",
            },
            f"{name}/{arch} predecessor destination",
        )
        destination_valid = (
            admission["schema"] == 1
            and destination["manifest_digest"]
            == admission["probe"]["digest"]
            and isinstance(destination["manifest_digest"], str)
            and OCI_DIGEST.fullmatch(destination["manifest_digest"])
            is not None
        )
    else:
        destination = exact_keys(
            evidence["destination"],
            {
                "admission_manifest_digest",
                "observed_manifest_digest",
                "reference",
                "remote",
                "source_closure_sha256",
            },
            f"{name}/{arch} predecessor destination",
        )
        destination_valid = (
            admission["schema"] == 2
            and destination["admission_manifest_digest"]
            == admission["probe"]["digest"]
            and isinstance(
                destination["observed_manifest_digest"], str
            )
            and OCI_DIGEST.fullmatch(
                destination["observed_manifest_digest"]
            )
            is not None
        )
    if (
        not destination_valid
        or destination["reference"]
        != formula["destination"]["reference"]
        or destination["remote"] != formula["destination"]["remote"]
    ):
        fail(f"{name}/{arch} predecessor destination changed")
    require_string(
        destination["source_closure_sha256"],
        f"{name}/{arch} source closure SHA-256",
        SHA256,
    )
    dependency_bottles = evidence["dependency_bottles"]
    if not isinstance(dependency_bottles, list):
        fail(f"{name}/{arch} predecessor dependencies are invalid")
    prior = ""
    for position, dependency in enumerate(dependency_bottles):
        dependency = exact_keys(
            dependency,
            {
                "bytes",
                "formula",
                "predecessor_handoff_tag",
                "sha256",
                "successor_handoff_tag",
            },
            f"{name}/{arch} predecessor dependency #{position}",
        )
        dependency_name = require_string(
            dependency["formula"],
            f"{name}/{arch} predecessor dependency #{position}",
            FORMULA,
        )
        if dependency_name <= prior:
            fail(f"{name}/{arch} predecessor dependencies are not sorted")
        prior = dependency_name
        require_int(
            dependency["bytes"],
            f"{name}/{arch} predecessor dependency bytes",
            1,
            MAX_ASSET_BYTES,
        )
        require_string(
            dependency["sha256"],
            f"{name}/{arch} predecessor dependency SHA-256",
            SHA256,
        )
        for key in ("predecessor_handoff_tag", "successor_handoff_tag"):
            require_string(
                dependency[key],
                f"{name}/{arch} dependency {key}",
                HANDOFF_TAG,
            )
    extracted = exact_keys(
        evidence["extracted"],
        {
            "archived_formula_sha256",
            "browser_compatible",
            "build",
            "built_at",
            "built_by",
            "built_from",
            "cache_key_sha",
            "env",
            "fork_instrumentation",
            "formula_revision",
            "links",
            "payload_root",
            "receipts",
            "runtime_support",
            "url",
            "validation",
        },
        f"{name}/{arch} predecessor extracted evidence",
    )
    validate_built_from_record(
        extracted["built_from"],
        f"{name}/{arch} predecessor producer",
    )
    if (
        extracted["cache_key_sha"] != bottle_sha256
        or extracted["url"]
        != (
            "https://ghcr.io/v2/"
            f"{authority['tap_repository'].lower()}/{name}/"
            f"blobs/sha256:{bottle_sha256}"
        )
    ):
        fail(f"{name}/{arch} predecessor extracted bottle changed")
    archive = regular_file(
        publication / "reuse/bottle.tar.gz",
        f"{name}/{arch} predecessor reused bottle",
        MAX_ASSET_BYTES,
    )
    if archive.stat().st_size != bottle_bytes or sha256_file(
        archive
    ) != bottle_sha256:
        fail(f"{name}/{arch} predecessor reused bottle changed")
    sidecars, _sidecars_payload = load_json_bytes(
        publication / "composition/sidecars-input.json",
        f"{name}/{arch} predecessor reuse sidecars input",
    )
    if sidecars != predecessor_reuse_sidecars_input(
        campaign, formula, arch, extracted
    ):
        fail(f"{name}/{arch} predecessor reuse sidecars are substituted")
    bottle_json, _bottle_payload = load_json_bytes(
        publication / "reuse/bottle.json",
        f"{name}/{arch} predecessor reuse bottle JSON",
    )
    if bottle_json != reuse_bottle_json(
        campaign,
        formula,
        arch,
        bottle_sha256,
        campaign_guest_layout(campaign),
    ):
        fail(f"{name}/{arch} predecessor reuse bottle JSON is substituted")


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
    evidence, _payload = load_json_bytes(
        publication / "reuse/evidence.json",
        f"{name}/{arch} reuse evidence",
    )
    if (
        isinstance(evidence, dict)
        and evidence.get("kind")
        == "kandelo-homebrew-prefix-predecessor-reuse-publication"
    ):
        validate_predecessor_reuse_publication_shape(
            publication,
            campaign,
            formula,
            arch,
            evidence,
        )
        return
    variant = validate_reuse_variant(campaign, formula, arch)
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
    source_tap_root: pathlib.Path,
) -> None:
    kind = publication_kind(
        publication, f"{formula['name']}/{arch} publication"
    )
    if kind == "build":
        validate_publication_shape(
            publication_root,
            formula,
            arch,
            prepared_formula_sha256(
                source_tap_root,
                campaign,
                formula,
            ),
        )
    else:
        validate_reuse_publication_shape(
            publication_root, campaign, formula, arch
        )


def validate_publication_shape(
    publication: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
    expected_formula_sha256: str,
) -> None:
    expected_formula_sha256 = require_string(
        expected_formula_sha256,
        f"{formula['name']}/{arch} prepared Formula SHA-256",
        SHA256,
    )
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
        != expected_formula_sha256
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


def formula_order_with(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    roots: Iterable[str],
    dependency_reader: Callable[
        [dict[str, Any], str], tuple[str, ...]
    ],
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
        for dependency in dependency_reader(index[name], tap_name):
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        ordered.append(name)

    for root in roots:
        visit(root)
    return tuple(ordered)


def selected_formula_order(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    roots: Iterable[str],
) -> tuple[str, ...]:
    """Order Formulae by the complete build-and-test dependency graph."""
    return formula_order_with(
        campaign,
        index,
        roots,
        dependency_names,
    )


def runtime_selected_formula_order(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    roots: Iterable[str],
) -> tuple[str, ...]:
    """Order Formulae by the dependency graph installed in the guest."""
    return formula_order_with(
        campaign,
        index,
        roots,
        runtime_dependency_names,
    )


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
    alias_path = tap_root / "Aliases"
    if alias_path.exists() or alias_path.is_symlink():
        alias_root = real_directory(
            alias_path, "candidate tap Alias directory"
        )
        for path in sorted(
            alias_root.iterdir(), key=lambda item: item.name
        ):
            relative = selection_relative_path(
                path.relative_to(tap_root)
            )
            metadata = path.lstat()
            if not stat.S_ISLNK(metadata.st_mode):
                fail("candidate tap contains an unsafe Alias entry")
            _target, normalized = selection_symlink_target(
                relative,
                os.readlink(path),
                f"candidate tap Alias {relative} target",
            )
            parts = normalized.split("/")
            if (
                len(parts) != 2
                or parts[0] != "Formula"
                or not parts[1].endswith(".rb")
            ):
                fail("candidate tap Alias does not name one Formula")
            formula = require_string(
                parts[1].removesuffix(".rb"),
                f"candidate tap Alias {relative} Formula",
                FORMULA,
            )
            target_path = tap_root / normalized
            try:
                target_metadata = target_path.lstat()
                target_path.resolve(strict=True).relative_to(tap_root)
            except (OSError, ValueError):
                fail("candidate tap Alias target escapes the source tap")
            if not stat.S_ISREG(target_metadata.st_mode):
                fail(
                    "candidate tap Alias must target one regular Formula"
                )
            # WHY: a closed selection intentionally hides unselected Formulae.
            # Keeping their aliases would reveal an unavailable package or
            # leave a dangling link in the independently consumable tap.
            if formula not in selected_names:
                path.unlink()

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
    command = host_xtask_command(
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
    )
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
    command = host_xtask_command(
        "homebrew-validate",
        "--tap-root",
        str(tap_root),
        "--prefix-campaign-layout-sha256",
        require_string(
            prefix_campaign_layout_sha256,
            "prefix campaign layout SHA-256",
            SHA256,
        ),
    )
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


def materialize_sealed_campaign_target(
    *,
    campaign: dict[str, Any],
    history_root: pathlib.Path,
    source_commit_root: pathlib.Path,
    destination: pathlib.Path,
    label: str,
) -> tuple[
    pathlib.Path,
    dict[str, Any],
    list[tuple[str, dict[str, Any] | None, dict[str, Any]]],
]:
    provenance, records = load_source_overlay_contract(
        source_commit_root,
        campaign,
    )
    base = provenance["base"]
    actual_base_tree = run_git(
        history_root,
        ["rev-parse", f"{base['commit']}^{{tree}}"],
        f"{label} sealed base tree",
    ).decode("ascii", errors="strict").strip()
    if actual_base_tree != base["tree_git_oid"]:
        fail(f"{label} sealed base commit has the wrong tree")
    if not git_is_ancestor(
        history_root,
        base["commit"],
        provenance["source_tap_commit"],
        f"{label} sealed base ancestry",
    ):
        fail(f"{label} sealed base is not an ancestor of the source")

    result = git_snapshot(
        history_root,
        base["commit"],
        destination,
        f"{label} sealed target base",
    )
    overlay_root = source_commit_root / campaign["authority"][
        "source_materialization"
    ]["source_root"]
    replay_overlay_files(
        tap_root=result,
        source_root=overlay_root,
        records=records,
        label=f"{label} sealed target replay",
    )
    if (
        filesystem_git_tree_oid(result, f"{label} sealed target")
        != provenance["sealed_target_tree_git_oid"]
    ):
        fail(f"{label} sealed target has the wrong Git tree")
    return result, provenance, records


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
    sealed_target, provenance, records = materialize_sealed_campaign_target(
        campaign=campaign,
        history_root=live_tap_root,
        source_commit_root=source_commit_root,
        destination=snapshot_root / "sealed-target",
        label="campaign",
    )
    provenance = {
        **provenance,
        "source_tap_tree_git_oid": actual_source_tree,
    }

    overlay_root = source_commit_root / campaign["authority"][
        "source_materialization"
    ]["source_root"]
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


def materialize_campaign_source(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    output: pathlib.Path,
) -> None:
    campaign, _campaign_payload, _index = load_campaign(campaign_path)
    provenance = campaign_source_provenance(campaign)
    source_commit = provenance["source_tap_commit"]
    source_tap_root = exact_git_checkout(
        source_tap_root,
        source_commit,
        "campaign source tap checkout",
    )
    validate_successor_scope_checkout(source_tap_root, campaign)
    output = validate_new_output(
        output,
        "materialized campaign source",
        (campaign_path, source_tap_root),
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        # WHY: campaign source is a sealed historical target, not the source
        # commit's complete tree. Rebuild it from the manifest-bound base and
        # overlay with Kandelo's validator so the tap checkout remains inert
        # data and cannot provide executable materialization code.
        source_commit_root = git_snapshot(
            source_tap_root,
            source_commit,
            temporary / "source-commit",
            "campaign complete source commit",
        )
        result, _provenance, _records = (
            materialize_sealed_campaign_target(
                campaign=campaign,
                history_root=source_tap_root,
                source_commit_root=source_commit_root,
                destination=temporary / "target",
                label="campaign",
            )
        )
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


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
                    stable_source,
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
    # WHY: the candidate and receipt are paired local outputs from
    # prepare_final_tap, not independently delegated or downloaded authority.
    # Recheck every fact available from the live Git object database here;
    # campaign composition itself remains inside that earlier trusted step.
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
    ordered = runtime_selected_formula_order(campaign, index, roots)
    selected_names = set(ordered)
    proof_names = set(selected_names)
    for name in selected_names:
        proof_names.update(dependency_closure(campaign, index, name))
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
            if name not in proof_names:
                fail(
                    f"selection handoff {name} is outside "
                    "the selected provenance closure"
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
        if set(loaded) != proof_names:
            missing = sorted(proof_names - set(loaded))
            fail(f"selected provenance closure lacks handoffs {missing}")
        # WHY: build/test-only dependencies are proof inputs, not installed
        # guest members. Verify every selected handoff against the complete
        # build graph before composing only the independently derived runtime
        # closure below.
        for name in sorted(proof_names):
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
                tap_root,
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
                "kandelo_commit": campaign["authority"][
                    "kandelo_commit"
                ],
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


def validate_selection_manifest(
    value: Any,
    payload: bytes,
    tap_root: pathlib.Path,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "arch",
            "campaign",
            "formulae",
            "kandelo_abi",
            "kind",
            "roots",
            "schema",
            "tap",
        },
        "closed selection",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-closed-selection-candidate"
    ):
        fail("closed selection has an unsupported contract")
    if value["arch"] not in ("wasm32", "wasm64"):
        fail("closed selection architecture is invalid")
    require_int(
        value["kandelo_abi"],
        "closed selection Kandelo ABI",
        1,
        2**32 - 1,
    )
    campaign = exact_keys(
        value["campaign"],
        {"guest_layout_sha256", "kandelo_commit", "sha256", "tag"},
        "closed selection campaign",
    )
    campaign_sha256 = require_string(
        campaign["sha256"],
        "closed selection campaign SHA-256",
        SHA256,
    )
    require_string(
        campaign["guest_layout_sha256"],
        "closed selection guest layout SHA-256",
        SHA256,
    )
    require_string(
        campaign["kandelo_commit"],
        "closed selection Kandelo commit",
        COMMIT,
    )
    if campaign["tag"] != (
        f"homebrew-prefix-campaign-sha256-{campaign_sha256}"
    ):
        fail("closed selection campaign tag differs from its digest")

    roots = value["roots"]
    if (
        not isinstance(roots, list)
        or not roots
        or len(roots) > MAX_FORMULAE
    ):
        fail("closed selection roots are invalid")
    checked_roots = [
        require_string(root, "closed selection root", FORMULA)
        for root in roots
    ]
    if checked_roots != sorted(set(checked_roots)):
        fail("closed selection roots must be unique and sorted")

    formulae = value["formulae"]
    if (
        not isinstance(formulae, list)
        or not formulae
        or len(formulae) > MAX_FORMULAE
    ):
        fail("closed selection Formula inventory is invalid")
    names: list[str] = []
    for position, raw in enumerate(formulae):
        formula = exact_keys(
            raw,
            {"archive", "formula", "handoff", "version"},
            f"closed selection Formula #{position}",
        )
        name = require_string(
            formula["formula"],
            f"closed selection Formula #{position} name",
            FORMULA,
        )
        if name in names:
            fail(f"closed selection repeats Formula {name}")
        names.append(name)
        require_string(
            formula["version"],
            f"closed selection Formula {name} version",
            VERSION,
        )
        archive = exact_keys(
            formula["archive"],
            {"bytes", "sha256"},
            f"closed selection Formula {name} archive",
        )
        require_int(
            archive["bytes"],
            f"closed selection Formula {name} archive bytes",
            1,
            MAX_ASSET_BYTES,
        )
        require_string(
            archive["sha256"],
            f"closed selection Formula {name} archive SHA-256",
            SHA256,
        )
        handoff = exact_keys(
            formula["handoff"],
            {"manifest_sha256", "tag"},
            f"closed selection Formula {name} handoff",
        )
        handoff_sha256 = require_string(
            handoff["manifest_sha256"],
            f"closed selection Formula {name} handoff SHA-256",
            SHA256,
        )
        if handoff["tag"] != (
            f"homebrew-prefix-handoff-sha256-{handoff_sha256}"
        ):
            fail(
                f"closed selection Formula {name} handoff tag "
                "differs from its digest"
            )
    if not set(checked_roots).issubset(names):
        fail("closed selection roots are outside its Formula inventory")

    tap = exact_keys(
        value["tap"],
        {
            "name",
            "path",
            "prepared_tree_git_oid",
            "repository",
            "source_commit",
            "source_tree_git_oid",
        },
        "closed selection tap",
    )
    if tap["path"] != "tap":
        fail("closed selection tap path is not canonical")
    require_string(
        tap["name"], "closed selection tap name", REPOSITORY
    )
    require_string(
        tap["repository"],
        "closed selection tap repository",
        REPOSITORY,
    )
    require_string(
        tap["source_commit"],
        "closed selection tap source commit",
        COMMIT,
    )
    require_string(
        tap["source_tree_git_oid"],
        "closed selection tap source tree",
        COMMIT,
    )
    prepared_tree = require_string(
        tap["prepared_tree_git_oid"],
        "closed selection prepared tap tree",
        COMMIT,
    )
    if filesystem_git_tree_oid(tap_root, "closed selection tap") != (
        prepared_tree
    ):
        fail("closed selection tap differs from its prepared Git tree")
    if payload != pretty_json(value):
        fail("closed selection is not canonical pretty JSON")
    return value


def load_selection_candidate(
    root: pathlib.Path,
) -> tuple[dict[str, Any], bytes, pathlib.Path]:
    root = real_directory(root, "closed selection root")
    children = sorted(child.name for child in root.iterdir())
    if children != ["selection.json", "tap"]:
        fail("closed selection root must contain only selection.json and tap")
    value, payload = load_json_bytes(
        root / "selection.json", "closed selection manifest"
    )
    tap_root = real_directory(root / "tap", "closed selection tap")
    return validate_selection_manifest(value, payload, tap_root), payload, tap_root


def selection_relative_path(path: pathlib.PurePath) -> str:
    value = path.as_posix()
    if (
        not value
        or len(value.encode("utf-8")) > 1024
        or value.startswith("/")
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in value)
    ):
        fail("closed selection tap contains an unsafe path")
    parts = value.split("/")
    if any(part in ("", ".", "..", ".git") for part in parts):
        fail("closed selection tap contains an unsafe path")
    return value


def selection_symlink_target(
    link_path: str,
    value: Any,
    label: str,
) -> tuple[str, str]:
    target = require_string(value, label)
    if (
        target.startswith("/")
        or "\\" in target
        or any(
            ord(character) < 0x20 or ord(character) > 0x7E
            for character in target
        )
    ):
        fail(f"{label} is not a safe relative target")
    payload = target.encode("ascii")
    if len(payload) > MAX_SELECTION_SYMLINK_BYTES:
        fail(f"{label} is not a safe relative target")

    parts = link_path.split("/")[:-1]
    for part in target.split("/"):
        if not part:
            fail(f"{label} is not a safe relative target")
        if part == ".":
            continue
        if part == "..":
            if not parts:
                fail(f"{label} escapes the selected tap")
            parts.pop()
        else:
            parts.append(part)
    if not parts:
        fail(f"{label} does not name a selected file")
    normalized = selection_relative_path(
        pathlib.PurePosixPath(*parts)
    )
    return target, normalized


def validate_selection_inventory(
    inventory: Any,
    archive_format: str,
) -> list[dict[str, Any]]:
    if archive_format not in SELECTION_ARCHIVE_READ_FORMATS:
        fail("closed selection archive format is unsupported")
    if (
        not isinstance(inventory, list)
        or not inventory
        or len(inventory) > MAX_SELECTION_FILES
    ):
        fail("closed selection archive inventory is invalid")

    checked: list[dict[str, Any]] = []
    link_targets: dict[str, str] = {}
    prior = ""
    total = 0
    for position, raw in enumerate(inventory):
        if not isinstance(raw, dict):
            fail(
                f"closed selection archive file #{position} is invalid"
            )
        mode_value = raw.get("mode")
        expected_keys = {"bytes", "mode", "path", "sha256"}
        if (
            archive_format == SELECTION_ARCHIVE_WRITE_FORMAT
            and mode_value == "120000"
        ):
            expected_keys.add("target")
        record = exact_keys(
            raw,
            expected_keys,
            f"closed selection archive file #{position}",
        )
        relative = selection_relative_path(
            pathlib.PurePosixPath(
                require_string(
                    record["path"],
                    f"closed selection archive file #{position} path",
                )
            )
        )
        if relative <= prior:
            fail("closed selection archive paths must be unique and sorted")
        prior = relative
        mode = require_string(
            record["mode"],
            f"closed selection archive file {relative} mode",
        )
        allowed_modes = {"100644", "100755"}
        if archive_format == SELECTION_ARCHIVE_WRITE_FORMAT:
            allowed_modes.add("120000")
        if mode not in allowed_modes:
            fail("closed selection archive file mode is unsupported")
        byte_count = require_int(
            record["bytes"],
            f"closed selection archive file {relative} bytes",
            0,
            MAX_ASSET_BYTES,
        )
        total += byte_count
        if total > MAX_SELECTION_TREE_BYTES:
            fail("closed selection archive inventory exceeds its byte bound")
        digest = require_string(
            record["sha256"],
            f"closed selection archive file {relative} SHA-256",
            SHA256,
        )
        if mode == "120000":
            target, normalized = selection_symlink_target(
                relative,
                record["target"],
                f"closed selection archive link {relative} target",
            )
            target_payload = target.encode("utf-8")
            if (
                byte_count != len(target_payload)
                or digest != sha256_bytes(target_payload)
            ):
                fail(
                    "closed selection archive link target evidence differs"
                )
            link_targets[relative] = normalized
        checked.append(record)

    by_path = {record["path"]: record for record in checked}
    for relative in by_path:
        parts = relative.split("/")
        for length in range(1, len(parts)):
            if "/".join(parts[:length]) in by_path:
                fail("closed selection archive paths overlap")
    for relative, target in link_targets.items():
        target_record = by_path.get(target)
        if target_record is None:
            fail(
                f"closed selection archive link {relative} target is "
                "dangling or a directory"
            )
        # WHY: allowing one alias to point through another would make archive
        # extraction order part of the security model. Homebrew aliases point
        # directly to Formula files, so chains and cycles are unnecessary.
        if target_record["mode"] == "120000":
            fail(
                f"closed selection archive link {relative} target is "
                "another link"
            )
    return checked


def selection_tree_inventory(
    tap_root: pathlib.Path,
) -> list[dict[str, Any]]:
    tap_root = real_directory(tap_root, "closed selection tap")
    inventory: list[dict[str, Any]] = []
    total = 0
    for child in sorted(
        tap_root.rglob("*"),
        key=lambda path: path.relative_to(tap_root).as_posix(),
    ):
        relative = selection_relative_path(child.relative_to(tap_root))
        metadata = child.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
            continue
        if stat.S_ISREG(metadata.st_mode) and not child.is_symlink():
            byte_count = require_int(
                metadata.st_size,
                f"closed selection tap file {relative} size",
                0,
                MAX_ASSET_BYTES,
            )
            record = {
                "bytes": byte_count,
                "mode": (
                    "100755"
                    if metadata.st_mode
                    & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    else "100644"
                ),
                "path": relative,
                "sha256": sha256_file(child),
            }
        elif stat.S_ISLNK(metadata.st_mode):
            target, _normalized = selection_symlink_target(
                relative,
                os.readlink(child),
                f"closed selection tap link {relative} target",
            )
            payload = target.encode("utf-8")
            byte_count = len(payload)
            record = {
                "bytes": byte_count,
                "mode": "120000",
                "path": relative,
                "sha256": sha256_bytes(payload),
                "target": target,
            }
        else:
            fail("closed selection tap contains a special file")
        total += byte_count
        if total > MAX_SELECTION_TREE_BYTES:
            fail("closed selection tap exceeds its total byte bound")
        inventory.append(record)
        if len(inventory) > MAX_SELECTION_FILES:
            fail("closed selection tap has too many files")
    if not inventory:
        fail("closed selection tap is empty")
    checked = validate_selection_inventory(
        inventory, SELECTION_ARCHIVE_WRITE_FORMAT
    )
    for record in checked:
        if record["mode"] != "120000":
            continue
        _target, normalized = selection_symlink_target(
            record["path"],
            record["target"],
            f"closed selection tap link {record['path']} target",
        )
        target_path = tap_root / normalized
        try:
            target_metadata = target_path.lstat()
            resolved_target = target_path.resolve(strict=True)
            resolved_target.relative_to(tap_root)
        except (OSError, ValueError):
            fail("closed selection tap link escapes its prepared tree")
        if not stat.S_ISREG(target_metadata.st_mode):
            fail(
                "closed selection tap link must target one regular file"
            )
    return checked


def write_selection_archive(
    tap_root: pathlib.Path,
    destination: pathlib.Path,
    inventory: list[dict[str, Any]],
) -> None:
    # WHY: the release tag ultimately binds the archive's SHA-256. Stored ZIP
    # entries avoid host zlib-version differences, so macOS and Linux produce
    # the same bytes for the same prepared tap tree.
    with zipfile.ZipFile(
        destination,
        mode="x",
        compression=zipfile.ZIP_STORED,
        allowZip64=True,
    ) as archive:
        for record in inventory:
            relative = record["path"]
            source = tap_root / relative
            info = zipfile.ZipInfo(
                filename=f"tap/{relative}",
                date_time=(2000, 1, 1, 0, 0, 0),
            )
            info.create_system = 3
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = int(record["mode"], 8) << 16
            info.flag_bits |= 0x800
            payload = (
                record["target"].encode("utf-8")
                if record["mode"] == "120000"
                else source.read_bytes()
            )
            archive.writestr(info, payload)


def extract_selection_archive(
    archive_path: pathlib.Path,
    output: pathlib.Path,
    inventory: list[dict[str, Any]],
    archive_format: str,
) -> pathlib.Path:
    regular_file(
        archive_path,
        "closed selection tap archive",
        MAX_ASSET_BYTES,
    )
    output = validate_new_output(
        output, "closed selection extracted tap", (archive_path,)
    )
    inventory = validate_selection_inventory(inventory, archive_format)
    expected = {f"tap/{record['path']}": record for record in inventory}
    if len(expected) != len(inventory):
        fail("closed selection tap inventory repeats a path")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        result = temporary / "tap"
        result.mkdir()
        pending_links: list[tuple[pathlib.Path, str, str]] = []
        try:
            with zipfile.ZipFile(archive_path, mode="r") as archive:
                members = archive.infolist()
                if len(members) != len(expected):
                    fail("closed selection archive inventory is incomplete")
                seen: set[str] = set()
                for member in members:
                    if member.filename in seen:
                        fail("closed selection archive repeats a member")
                    seen.add(member.filename)
                    record = expected.get(member.filename)
                    if record is None:
                        fail("closed selection archive contains an unexpected member")
                    if (
                        member.is_dir()
                        or member.flag_bits & 0x1
                        or member.compress_type != zipfile.ZIP_STORED
                        or member.file_size != record["bytes"]
                        or member.compress_size != record["bytes"]
                        or member.file_size > MAX_ASSET_BYTES
                        or member.create_system != 3
                        or ((member.external_attr >> 16) & 0o177777)
                        != int(record["mode"], 8)
                    ):
                        fail("closed selection archive member metadata differs")
                    relative = member.filename.removeprefix("tap/")
                    if f"tap/{selection_relative_path(pathlib.Path(relative))}" != (
                        member.filename
                    ):
                        fail("closed selection archive member path is unsafe")
                    destination = private_destination(
                        result, relative, "closed selection archive member"
                    )
                    digest = hashlib.sha256()
                    copied = 0
                    payload = bytearray()
                    target_handle = (
                        None
                        if record["mode"] == "120000"
                        else destination.open("xb")
                    )
                    try:
                        with archive.open(member, mode="r") as source:
                            while chunk := source.read(1024 * 1024):
                                copied += len(chunk)
                                if copied > record["bytes"]:
                                    fail(
                                        "closed selection archive member "
                                        "exceeds its bound"
                                    )
                                digest.update(chunk)
                                if target_handle is None:
                                    payload.extend(chunk)
                                else:
                                    target_handle.write(chunk)
                    finally:
                        if target_handle is not None:
                            target_handle.close()
                    if (
                        copied != record["bytes"]
                        or digest.hexdigest() != record["sha256"]
                    ):
                        fail("closed selection archive member bytes differ")
                    if record["mode"] == "120000":
                        try:
                            target_value = bytes(payload).decode("utf-8")
                        except UnicodeDecodeError:
                            fail(
                                "closed selection archive link target is "
                                "not UTF-8"
                            )
                        if target_value != record["target"]:
                            fail(
                                "closed selection archive link target "
                                "differs"
                            )
                        _raw, normalized = selection_symlink_target(
                            relative,
                            target_value,
                            "closed selection archive link target",
                        )
                        pending_links.append(
                            (destination, target_value, normalized)
                        )
                    else:
                        destination.chmod(
                            int(record["mode"], 8) & 0o777
                        )
        except (OSError, zipfile.BadZipFile, RuntimeError) as error:
            fail(f"cannot extract closed selection archive: {error}")
        if seen != set(expected):
            fail("closed selection archive inventory is incomplete")
        # WHY: regular files are complete before any alias is created. A
        # malicious archive order therefore cannot redirect a later write
        # through a symlink, even if future callers stop sorting members.
        for destination, target, normalized in pending_links:
            target_path = result / normalized
            try:
                target_metadata = target_path.lstat()
            except OSError:
                fail("closed selection archive link target is unavailable")
            if not stat.S_ISREG(target_metadata.st_mode):
                fail(
                    "closed selection archive link target is not a "
                    "regular file"
                )
            destination = private_destination(
                result,
                destination.relative_to(result).as_posix(),
                "closed selection archive link",
            )
            os.symlink(target, destination)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return output


def validate_selection_descriptor(
    value: Any,
    payload: bytes,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {"kind", "schema", "selection_manifest", "tap_archive"},
        "closed selection descriptor",
    )
    if (
        value["schema"] != 1
        or value["kind"] != "kandelo-homebrew-closed-selection"
    ):
        fail("closed selection descriptor has an unsupported contract")
    selection_record = exact_keys(
        value["selection_manifest"],
        {"bytes", "sha256", "value"},
        "closed selection descriptor manifest",
    )
    selection_payload = pretty_json(selection_record["value"])
    if (
        require_int(
            selection_record["bytes"],
            "closed selection manifest bytes",
            1,
            MAX_JSON_BYTES,
        )
        != len(selection_payload)
        or require_string(
            selection_record["sha256"],
            "closed selection manifest SHA-256",
            SHA256,
        )
        != sha256_bytes(selection_payload)
    ):
        fail("closed selection descriptor manifest evidence differs")
    archive = exact_keys(
        value["tap_archive"],
        {
            "asset",
            "bytes",
            "file_count",
            "format",
            "inventory",
            "sha256",
            "tree_git_oid",
            "uncompressed_bytes",
        },
        "closed selection descriptor tap archive",
    )
    if archive["asset"] != SELECTION_ARCHIVE_ASSET:
        fail("closed selection archive asset is not canonical")
    archive_format = require_string(
        archive["format"], "closed selection archive format"
    )
    if archive_format not in SELECTION_ARCHIVE_READ_FORMATS:
        fail("closed selection archive format is unsupported")
    require_int(
        archive["bytes"],
        "closed selection archive bytes",
        1,
        MAX_ASSET_BYTES,
    )
    require_string(
        archive["sha256"],
        "closed selection archive SHA-256",
        SHA256,
    )
    require_string(
        archive["tree_git_oid"],
        "closed selection archive Git tree",
        COMMIT,
    )
    checked = validate_selection_inventory(
        archive["inventory"], archive_format
    )
    total = sum(record["bytes"] for record in checked)
    if (
        archive["file_count"] != len(checked)
        or archive["uncompressed_bytes"] != total
    ):
        fail("closed selection archive summary differs from its inventory")
    selection = selection_record["value"]
    if not isinstance(selection, dict):
        fail("closed selection descriptor manifest is invalid")
    tap = selection.get("tap")
    if (
        not isinstance(tap, dict)
        or tap.get("prepared_tree_git_oid") != archive["tree_git_oid"]
    ):
        fail("closed selection descriptor tree identities differ")
    if payload != pretty_json(value):
        fail("closed selection descriptor is not canonical pretty JSON")
    return value


def selection_release_manifest(
    *,
    descriptor: dict[str, Any],
    descriptor_payload: bytes,
    archive_path: pathlib.Path,
) -> dict[str, Any]:
    selection = descriptor["selection_manifest"]["value"]
    archive = descriptor["tap_archive"]
    descriptor_sha256 = sha256_bytes(descriptor_payload)
    return {
        "accepted_existing_asset_sets": [],
        "assets": [
            {
                "bytes": len(descriptor_payload),
                "name": SELECTION_DESCRIPTOR_ASSET,
                "sha256": descriptor_sha256,
            },
            {
                "bytes": archive_path.stat().st_size,
                "name": SELECTION_ARCHIVE_ASSET,
                "sha256": archive["sha256"],
            },
        ],
        "body": (
            "Immutable closed Formula selection for one Kandelo consumer. "
            "This is intentionally not the complete tap catalog."
        ),
        "preferred_asset_names": [
            SELECTION_DESCRIPTOR_ASSET,
            SELECTION_ARCHIVE_ASSET,
        ],
        "repository": selection["tap"]["repository"].lower(),
        "schema": 1,
        "tag": f"homebrew-prefix-selection-sha256-{descriptor_sha256}",
        "target_commitish": selection["tap"]["source_commit"],
        "title": "Kandelo Homebrew closed Formula selection",
    }


def prepare_selection_release(
    *, selection_root: pathlib.Path, output: pathlib.Path
) -> None:
    selection_root = real_directory(
        selection_root, "closed selection root"
    )
    output = validate_new_output(
        output, "prepared closed selection release", (selection_root,)
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        # WHY: the candidate may have been prepared by another job. Validate
        # and archive one private snapshot so an edit/restore race cannot put
        # bytes in the release that differ from the reviewed selection.
        snapshot = temporary / "snapshot"
        shutil.copytree(selection_root, snapshot, symlinks=True)
        selection, selection_payload, tap_root = load_selection_candidate(
            snapshot
        )
        inventory = selection_tree_inventory(tap_root)
        assets = temporary / "assets"
        assets.mkdir()
        archive_path = assets / SELECTION_ARCHIVE_ASSET
        write_selection_archive(tap_root, archive_path, inventory)
        archive_bytes = archive_path.stat().st_size
        archive_sha256 = sha256_file(archive_path)
        descriptor = {
            "kind": "kandelo-homebrew-closed-selection",
            "schema": 1,
            "selection_manifest": {
                "bytes": len(selection_payload),
                "sha256": sha256_bytes(selection_payload),
                "value": selection,
            },
            "tap_archive": {
                "asset": SELECTION_ARCHIVE_ASSET,
                "bytes": archive_bytes,
                "file_count": len(inventory),
                "format": SELECTION_ARCHIVE_WRITE_FORMAT,
                "inventory": inventory,
                "sha256": archive_sha256,
                "tree_git_oid": selection["tap"][
                    "prepared_tree_git_oid"
                ],
                "uncompressed_bytes": sum(
                    record["bytes"] for record in inventory
                ),
            },
        }
        descriptor_payload = pretty_json(descriptor)
        descriptor_path = assets / SELECTION_DESCRIPTOR_ASSET
        descriptor_path.write_bytes(descriptor_payload)
        validate_selection_descriptor(descriptor, descriptor_payload)

        extracted = temporary / "self-check-tap"
        extract_selection_archive(
            archive_path,
            extracted,
            inventory,
            SELECTION_ARCHIVE_WRITE_FORMAT,
        )
        if filesystem_git_tree_oid(extracted, "archived closed selection tap") != (
            selection["tap"]["prepared_tree_git_oid"]
        ):
            fail("prepared selection archive changed its Git tree")
        shutil.rmtree(extracted)

        release = selection_release_manifest(
            descriptor=descriptor,
            descriptor_payload=descriptor_payload,
            archive_path=archive_path,
        )
        (temporary / "release-manifest.json").write_bytes(
            pretty_json(release)
        )
        shutil.rmtree(snapshot)
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)


def load_prepared_selection_release(
    prepared_root: pathlib.Path,
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    prepared_root = real_directory(
        prepared_root,
        "prepared closed selection release",
    )
    expected_paths = {
        "assets/closed-selection.json",
        "assets/closed-selection.zip",
        "release-manifest.json",
    }
    observed_files: set[str] = set()
    observed_directories: set[str] = set()
    for child in prepared_root.rglob("*"):
        relative = child.relative_to(prepared_root).as_posix()
        metadata = child.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
            observed_directories.add(relative)
        elif stat.S_ISREG(metadata.st_mode) and not child.is_symlink():
            observed_files.add(relative)
        else:
            fail("prepared closed selection release has an indirect path")
    if (
        observed_files != expected_paths
        or observed_directories != {"assets"}
    ):
        fail("prepared closed selection release has unexpected files")

    descriptor_path = regular_file_within(
        prepared_root,
        f"assets/{SELECTION_DESCRIPTOR_ASSET}",
        "prepared closed selection descriptor",
        MAX_JSON_BYTES,
    )
    descriptor, descriptor_payload = load_json_bytes(
        descriptor_path,
        "prepared closed selection descriptor",
    )
    descriptor = validate_selection_descriptor(
        descriptor,
        descriptor_payload,
    )
    archive_path = regular_file_within(
        prepared_root,
        f"assets/{SELECTION_ARCHIVE_ASSET}",
        "prepared closed selection archive",
        MAX_ASSET_BYTES,
    )
    archive = descriptor["tap_archive"]
    if (
        archive_path.stat().st_size != archive["bytes"]
        or sha256_file(archive_path) != archive["sha256"]
    ):
        fail("prepared closed selection archive differs from its descriptor")

    manifest_path = regular_file_within(
        prepared_root,
        "release-manifest.json",
        "prepared closed selection release manifest",
        MAX_JSON_BYTES,
    )
    manifest, manifest_payload = load_json_bytes(
        manifest_path,
        "prepared closed selection release manifest",
    )
    expected_manifest = selection_release_manifest(
        descriptor=descriptor,
        descriptor_payload=descriptor_payload,
        archive_path=archive_path,
    )
    if (
        manifest != expected_manifest
        or manifest_payload != pretty_json(expected_manifest)
    ):
        fail("prepared closed selection release manifest differs")

    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=".closed-selection-release-readback.")
    )
    try:
        selection_root = temporary / "selection"
        selection_root.mkdir()
        (selection_root / "selection.json").write_bytes(
            pretty_json(descriptor["selection_manifest"]["value"])
        )
        extract_selection_archive(
            archive_path,
            selection_root / "tap",
            archive["inventory"],
            archive["format"],
        )
        selection, selection_payload, _tap_root = load_selection_candidate(
            selection_root
        )
        if (
            selection != descriptor["selection_manifest"]["value"]
            or len(selection_payload)
            != descriptor["selection_manifest"]["bytes"]
            or sha256_bytes(selection_payload)
            != descriptor["selection_manifest"]["sha256"]
        ):
            fail("prepared closed selection differs from its descriptor")
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    return descriptor, descriptor_payload, manifest


def snapshot_selection_release(
    *,
    prepared_root: pathlib.Path,
    output: pathlib.Path,
) -> None:
    prepared_root = real_directory(
        prepared_root,
        "prepared closed selection release",
    )
    output = validate_new_output(
        output,
        "verified closed selection release snapshot",
        (prepared_root,),
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        result = temporary / "release"
        (result / "assets").mkdir(parents=True)
        for relative, maximum in (
            ("release-manifest.json", MAX_JSON_BYTES),
            (f"assets/{SELECTION_DESCRIPTOR_ASSET}", MAX_JSON_BYTES),
            (f"assets/{SELECTION_ARCHIVE_ASSET}", MAX_ASSET_BYTES),
        ):
            source = regular_file_within(
                prepared_root,
                relative,
                f"prepared release {relative}",
                maximum,
            )
            shutil.copyfile(source, result / relative)
        # WHY: validate the private copy, not the caller-owned paths. That
        # turns later publication and semantic readback into one immutable
        # local input even if the caller can edit its directory concurrently.
        load_prepared_selection_release(result)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def fetch_selection_release(
    *,
    repository: str,
    tag: str,
    output: pathlib.Path,
    receipt_output: pathlib.Path,
    json_fetcher: JsonFetcher | None = None,
    asset_fetcher: AssetFetcher | None = None,
) -> None:
    if json_fetcher is None:
        json_fetcher = http_json
    if asset_fetcher is None:
        asset_fetcher = http_asset
    repository = require_string(
        repository, "closed selection repository", REPOSITORY
    ).lower()
    match = SELECTION_TAG.fullmatch(tag)
    if match is None:
        fail("closed selection release tag is invalid")
    output, receipt_output = validate_output_pair(
        output,
        "closed selection output",
        receipt_output,
        "closed selection receipt output",
        (),
    )
    assets, release = release_assets(
        repository, tag, json_fetcher=json_fetcher
    )
    if set(assets) != {
        SELECTION_DESCRIPTOR_ASSET,
        SELECTION_ARCHIVE_ASSET,
    }:
        fail("closed selection release contains unexpected assets")
    descriptor_record = assets[SELECTION_DESCRIPTOR_ASSET]
    if (
        descriptor_record["bytes"] > MAX_JSON_BYTES
        or descriptor_record["sha256"] != match.group(1)
    ):
        fail("closed selection release evidence differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        descriptor_path = temporary / SELECTION_DESCRIPTOR_ASSET
        fetch_one_asset(
            assets,
            SELECTION_DESCRIPTOR_ASSET,
            descriptor_path,
            asset_fetcher=asset_fetcher,
        )
        descriptor, descriptor_payload = load_json_bytes(
            descriptor_path, "downloaded closed selection descriptor"
        )
        descriptor = validate_selection_descriptor(
            descriptor, descriptor_payload
        )
        if sha256_bytes(descriptor_payload) != match.group(1):
            fail("closed selection tag differs from its descriptor")
        selection = descriptor["selection_manifest"]["value"]
        tap = selection["tap"]
        if tap["repository"].lower() != repository:
            fail("closed selection release repository differs")
        if release.get("target_commitish") != tap["source_commit"]:
            fail("closed selection release targets the wrong source commit")
        archive_record = descriptor["tap_archive"]
        released_archive = assets[SELECTION_ARCHIVE_ASSET]
        if (
            released_archive["bytes"] != archive_record["bytes"]
            or released_archive["sha256"] != archive_record["sha256"]
        ):
            fail("closed selection release archive evidence differs")
        archive_path = temporary / SELECTION_ARCHIVE_ASSET
        fetch_one_asset(
            assets,
            SELECTION_ARCHIVE_ASSET,
            archive_path,
            asset_fetcher=asset_fetcher,
        )
        result = temporary / "selection"
        result.mkdir()
        (result / "selection.json").write_bytes(
            pretty_json(selection)
        )
        extract_selection_archive(
            archive_path,
            result / "tap",
            archive_record["inventory"],
            archive_record["format"],
        )
        observed, selection_payload, _tap_root = load_selection_candidate(
            result
        )
        if (
            observed != selection
            or len(selection_payload)
            != descriptor["selection_manifest"]["bytes"]
            or sha256_bytes(selection_payload)
            != descriptor["selection_manifest"]["sha256"]
        ):
            fail("downloaded closed selection differs from its descriptor")
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(
            pretty_json(
                {
                    "arch": selection["arch"],
                    "assets": {
                        SELECTION_DESCRIPTOR_ASSET: {
                            "bytes": descriptor_record["bytes"],
                            "sha256": descriptor_record["sha256"],
                        },
                        SELECTION_ARCHIVE_ASSET: {
                            "bytes": released_archive["bytes"],
                            "sha256": released_archive["sha256"],
                        },
                    },
                    "formula_count": len(selection["formulae"]),
                    "kind": "kandelo-homebrew-closed-selection-readback",
                    "prepared_tree_git_oid": tap[
                        "prepared_tree_git_oid"
                    ],
                    "release_id": release["id"],
                    "repository": repository,
                    "roots": selection["roots"],
                    "schema": 1,
                    "selection_manifest_sha256": descriptor[
                        "selection_manifest"
                    ]["sha256"],
                    "tag": tag,
                    "target_commitish": tap["source_commit"],
                    "visibility": "public-anonymous-readback",
                }
            )
        )
        commit_output_pair(
            result,
            output,
            staged_receipt,
            receipt_output,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def validate_selection_readback_receipt(
    value: Any,
    payload: bytes,
    selection: dict[str, Any],
    selection_payload: bytes,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "arch",
            "assets",
            "formula_count",
            "kind",
            "prepared_tree_git_oid",
            "release_id",
            "repository",
            "roots",
            "schema",
            "selection_manifest_sha256",
            "tag",
            "target_commitish",
            "visibility",
        },
        "closed selection readback receipt",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-closed-selection-readback"
        or value["visibility"] != "public-anonymous-readback"
    ):
        fail("closed selection readback receipt is unsupported")
    assets = exact_keys(
        value["assets"],
        {SELECTION_DESCRIPTOR_ASSET, SELECTION_ARCHIVE_ASSET},
        "closed selection readback assets",
    )
    for name in (SELECTION_DESCRIPTOR_ASSET, SELECTION_ARCHIVE_ASSET):
        asset = exact_keys(
            assets[name],
            {"bytes", "sha256"},
            f"closed selection readback asset {name}",
        )
        require_int(
            asset["bytes"],
            f"closed selection readback asset {name} bytes",
            1,
            MAX_ASSET_BYTES,
        )
        require_string(
            asset["sha256"],
            f"closed selection readback asset {name} SHA-256",
            SHA256,
        )
    tag = require_string(
        value["tag"], "closed selection readback tag"
    )
    match = SELECTION_TAG.fullmatch(tag)
    if (
        match is None
        or match.group(1)
        != assets[SELECTION_DESCRIPTOR_ASSET]["sha256"]
    ):
        fail("closed selection readback tag differs from its descriptor")
    repository = require_string(
        value["repository"],
        "closed selection readback repository",
        REPOSITORY,
    )
    if repository != repository.lower():
        fail("closed selection readback repository is not canonical")
    require_int(
        value["release_id"],
        "closed selection readback release id",
        1,
    )
    require_string(
        value["prepared_tree_git_oid"],
        "closed selection readback prepared tree",
        COMMIT,
    )
    require_string(
        value["selection_manifest_sha256"],
        "closed selection readback manifest SHA-256",
        SHA256,
    )
    require_string(
        value["target_commitish"],
        "closed selection readback target commit",
        COMMIT,
    )
    require_int(
        value["formula_count"],
        "closed selection readback Formula count",
        1,
        MAX_FORMULAE,
    )
    roots = value["roots"]
    if (
        not isinstance(roots, list)
        or not roots
        or len(roots) > MAX_FORMULAE
    ):
        fail("closed selection readback roots are invalid")
    checked_roots = [
        require_string(
            root, "closed selection readback root", FORMULA
        )
        for root in roots
    ]
    if checked_roots != sorted(set(checked_roots)):
        fail("closed selection readback roots must be unique and sorted")

    tap = selection["tap"]
    if (
        value["arch"] != selection["arch"]
        or repository != tap["repository"].lower()
        or value["target_commitish"] != tap["source_commit"]
        or checked_roots != selection["roots"]
        or value["formula_count"] != len(selection["formulae"])
        or value["prepared_tree_git_oid"]
        != tap["prepared_tree_git_oid"]
        or value["selection_manifest_sha256"]
        != sha256_bytes(selection_payload)
    ):
        fail("closed selection readback differs from selected tap bytes")
    if payload != pretty_json(value):
        fail("closed selection readback receipt is not canonical JSON")
    return value


def verify_selection_readback(
    *,
    selection_root: pathlib.Path,
    receipt_path: pathlib.Path,
    output: pathlib.Path,
) -> None:
    selection_root = real_directory(
        selection_root, "closed selection root"
    )
    receipt_path = regular_file(
        receipt_path, "closed selection readback receipt"
    )
    output = validate_new_output(
        output,
        "closed selection verification report",
        (selection_root, receipt_path),
    )
    selection, selection_payload, _tap_root = load_selection_candidate(
        selection_root
    )
    receipt, receipt_payload = load_json_bytes(
        receipt_path, "closed selection readback receipt"
    )
    receipt = validate_selection_readback_receipt(
        receipt,
        receipt_payload,
        selection,
        selection_payload,
    )
    formulae = sorted(
        require_string(
            formula["formula"],
            "closed selection verification Formula",
            FORMULA,
        )
        for formula in selection["formulae"]
    )
    report = {
        "arch": selection["arch"],
        "formula_count": len(formulae),
        "formulae": formulae,
        "kandelo_abi": selection["kandelo_abi"],
        "kind": "kandelo-homebrew-closed-selection-verification",
        "prepared_tree_git_oid": selection["tap"][
            "prepared_tree_git_oid"
        ],
        "readback": {
            "receipt_sha256": sha256_bytes(receipt_payload),
            "release_id": receipt["release_id"],
            "repository": receipt["repository"],
            "tag": receipt["tag"],
            "visibility": receipt["visibility"],
        },
        "roots": selection["roots"],
        "schema": 1,
        "selection_manifest_sha256": sha256_bytes(selection_payload),
        "source_tap_commit": selection["tap"]["source_commit"],
        "tap_name": selection["tap"]["name"],
    }
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", dir=output.parent
    )
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(pretty_json(report))
        os.chmod(temporary, 0o644)
        # WHY: the report is authorization for a detached tap tree. Publish
        # it only after the immutable readback receipt and every tree byte
        # agree, and never replace an authorization another process created.
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


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


def bind_campaign_formula_destination(
    root: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> bool:
    campaign_guest_layout(campaign)
    source = formula["formula_source"]
    try:
        return CAMPAIGN_FORMULA.bind_formula_destination(
            root / source["path"],
            formula["destination"]["bottle_rebuild"],
            source["identity_excluding_bottle_sha256"],
            formula["version"],
            formula.get("previous_version"),
            repository_root=ROOT,
        )
    except CAMPAIGN_FORMULA.CampaignFormulaError as error:
        fail(str(error))


def prepared_formula_sha256(
    source_root: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> str:
    validate_source_formula(source_root, formula)
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix="homebrew-campaign-formula-")
    )
    try:
        source = source_root / formula["formula_source"]["path"]
        destination = temporary / source.name
        shutil.copy2(source, destination, follow_symlinks=False)
        bind_campaign_formula_destination(
            temporary,
            campaign,
            {
                **formula,
                "formula_source": {
                    **formula["formula_source"],
                    "path": destination.name,
                },
            },
        )
        return sha256_file(destination)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


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
    target_tree = source_tree_identity(campaign["authority"])
    target_commit = deterministic_campaign_commit_oid(
        parent=campaign["authority"]["source_tap_commit"],
        tree=target_tree,
        label="sealed target source",
    )
    destination_changed = bind_campaign_formula_destination(
        root,
        campaign,
        formula,
    )
    destination_tree = target_tree
    destination_commit = target_commit
    if destination_changed:
        destination_tree = filesystem_git_tree_oid(
            root,
            f"{formula['name']}/{arch} destination-bound checkout",
        )
        destination_commit = deterministic_campaign_commit_oid(
            parent=target_commit,
            tree=destination_tree,
            label=f"{formula['name']} reserved bottle destination",
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
        sorted(
            {
                *(
                    f"Formula/{name}.rb"
                    for name in dependency_closure(
                        campaign,
                        index,
                        formula["name"],
                    )
                ),
                *(
                    [formula["formula_source"]["path"]]
                    if destination_changed
                    else []
                ),
            }
        )
    )
    if changed != expected_changed:
        fail(
            "dependency bottle composition changed files outside "
            "its exact Formula closure"
        )
    prepared_tree = filesystem_git_tree_oid(
        root,
        f"{formula['name']}/{arch} prepared checkout",
    )
    # WHY: build jobs create this synthetic commit locally and cannot publish
    # it. Recomputing its Git object ID from sealed inputs lets the trusted
    # executor bind the handoff without trusting a job-supplied receipt.
    prepared_commit = deterministic_campaign_commit_oid(
        parent=destination_commit,
        tree=prepared_tree,
        label=f"{formula['name']}/{arch} publisher inputs",
    )
    return root, prepared_tree, prepared_commit


def snapshot_publication(
    source: pathlib.Path,
    destination: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
    expected_formula_sha256: str,
) -> tuple[pathlib.Path, dict[str, dict[str, Any]]]:
    validate_publication_shape(
        source,
        formula,
        arch,
        expected_formula_sha256,
    )
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
    validate_publication_shape(
        destination,
        formula,
        arch,
        expected_formula_sha256,
    )
    return destination, records


PredecessorDestinationVerifier = Callable[
    [
        dict[str, Any],
        dict[str, Any],
        str,
        pathlib.Path,
        dict[str, Any],
        dict[str, Any],
    ],
    dict[str, Any],
]


def load_oci_json_blob(
    layout: pathlib.Path,
    descriptor: dict[str, Any],
    *,
    media_type: str,
    maximum: int,
    label: str,
) -> dict[str, Any]:
    descriptor = exact_keys(
        descriptor,
        {"digest", "mediaType", "size"},
        f"{label} descriptor",
    )
    digest = require_string(
        descriptor["digest"], f"{label} digest", OCI_DIGEST
    ).removeprefix("sha256:")
    size = require_int(
        descriptor["size"], f"{label} bytes", 1, maximum
    )
    if descriptor["mediaType"] != media_type:
        fail(f"{label} has the wrong OCI media type")
    path = regular_file(
        layout / "blobs/sha256" / digest,
        label,
        maximum,
    )
    if path.stat().st_size != size or sha256_file(path) != digest:
        fail(f"{label} differs from its OCI descriptor")
    value, _payload = load_json_bytes(path, label, canonical=False)
    if not isinstance(value, dict):
        fail(f"{label} is not a JSON object")
    return value


def default_predecessor_destination_verifier(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    source_tap_root: pathlib.Path,
    archive_record: dict[str, Any],
    extracted: dict[str, Any],
) -> dict[str, Any]:
    # WHY: The immutable OCI index preserves the producer's source closure.
    # Recompute the successor closure with its reviewed tool and require the
    # digests to agree. A Formula-support edit or closure-parser change must
    # rebuild the bottle even when the selected Formula itself is unchanged.
    name = formula["name"]
    destination = formula["destination"]
    admission = destination["admission"]
    expected_digest = admission["probe"]["digest"]
    admitted_children: dict[str, dict[str, Any]] | None = None
    if admission["schema"] == 2:
        admitted_children = {
            child["arch"]: child
            for child in admission["probe"]["children"]
        }
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f"kandelo-predecessor-{name}-{arch}-")
    )
    try:
        current_closure_path = temporary / "current-source-closure.json"
        run_oci_layout_command(
            [
                "source-closure",
                "--tap-root",
                str(source_tap_root),
                "--kandelo-root",
                str(ROOT),
                "--tap-repository",
                campaign["authority"]["tap_repository"],
                "--tap-name",
                campaign["authority"]["tap_name"],
                "--formula",
                name,
                "--out",
                str(current_closure_path),
            ],
            f"derive current source closure for {name}/{arch}",
        )
        current_closure, _current_closure_payload = load_json_bytes(
            current_closure_path,
            f"{name}/{arch} current source closure",
        )
        current_closure = exact_keys(
            current_closure,
            {
                "formula",
                "formula_identity_sha256",
                "formula_mode",
                "schema",
                "source_closure_sha256",
                "tap_name",
                "tap_repository",
            },
            f"{name}/{arch} current source closure",
        )
        current_source_closure_sha256 = require_string(
            current_closure["source_closure_sha256"],
            f"{name}/{arch} current source closure SHA-256",
            SHA256,
        )
        current_formula_identity = require_string(
            current_closure["formula_identity_sha256"],
            f"{name}/{arch} current Formula identity",
            SHA256,
        )
        current_formula_mode = require_string(
            current_closure["formula_mode"],
            f"{name}/{arch} current Formula mode",
        )
        current_tap_name = require_string(
            current_closure["tap_name"],
            f"{name}/{arch} current tap name",
            REPOSITORY,
        )
        current_tap_repository = require_string(
            current_closure["tap_repository"],
            f"{name}/{arch} current tap repository",
            REPOSITORY,
        )
        if (
            current_closure["schema"] != 2
            or current_closure["formula"] != name
            or current_formula_identity
            != formula["formula_source"][
                "identity_excluding_bottle_sha256"
            ]
            or current_formula_mode not in ("100644", "100755")
            or current_tap_name != campaign["authority"]["tap_name"]
            or current_tap_repository.lower()
            != campaign["authority"]["tap_repository"].lower()
        ):
            fail(f"{name}/{arch} current source closure is invalid")
        registry_config = temporary / "anonymous-registry.json"
        registry_config.write_bytes(pretty_json({"auths": {}}))
        layout = temporary / "layout"
        result_path = temporary / "import.json"
        run_oci_layout_command(
            [
                "import-public-index",
                "--remote",
                destination["remote"],
                "--reference",
                destination["reference"],
                "--registry-config",
                str(registry_config),
                "--out-layout",
                str(layout),
                "--out-result",
                str(result_path),
            ],
            f"import predecessor OCI index for {name}/{arch}",
        )
        result, _result_payload = load_json_bytes(
            result_path, f"{name}/{arch} predecessor OCI import"
        )
        if (
            not isinstance(result, dict)
            or set(result) != {"digest", "layout", "schema", "status"}
            or result.get("layout") != str(layout)
            or result.get("schema") != 1
            or result.get("status") != "present"
            or not isinstance(result.get("digest"), str)
            or OCI_DIGEST.fullmatch(result["digest"]) is None
            or (
                admitted_children is None
                and result["digest"] != expected_digest
            )
        ):
            fail(f"{name}/{arch} predecessor OCI destination changed")
        observed_digest = result["digest"]

        authority = campaign["authority"]
        index, _index_payload = load_json_bytes(
            layout / "index.json", f"{name}/{arch} imported OCI index"
        )
        index = exact_keys(
            index,
            {"manifests", "mediaType", "schemaVersion"},
            f"{name}/{arch} imported OCI index",
        )
        roots = index["manifests"]
        if (
            index["schemaVersion"] != 2
            or index["mediaType"]
            != "application/vnd.oci.image.index.v1+json"
            or not isinstance(roots, list)
            or len(roots) != 1
        ):
            fail(f"{name}/{arch} imported OCI root is invalid")
        root = exact_keys(
            roots[0],
            {"annotations", "digest", "mediaType", "size"},
            f"{name}/{arch} imported OCI root",
        )
        if root["digest"] != observed_digest:
            fail(f"{name}/{arch} imported OCI root digest changed")
        top = load_oci_json_blob(
            layout,
            {
                "digest": root["digest"],
                "mediaType": root["mediaType"],
                "size": root["size"],
            },
            media_type="application/vnd.oci.image.index.v1+json",
            maximum=MAX_JSON_BYTES,
            label=f"{name}/{arch} public top index",
        )
        top = exact_keys(
            top,
            {"annotations", "manifests", "mediaType", "schemaVersion"},
            f"{name}/{arch} public top index",
        )
        semantic_annotation_keys = {
            "dev.kandelo.homebrew.abi",
            "dev.kandelo.homebrew.bottle_rebuild",
            "dev.kandelo.homebrew.formula",
            "dev.kandelo.homebrew.formula_revision",
            "dev.kandelo.homebrew.formula_source_identity_sha256",
            "dev.kandelo.homebrew.pkg_version",
            "dev.kandelo.homebrew.source_closure_sha256",
            "dev.kandelo.homebrew.tap_repository",
        }
        annotation_keys = semantic_annotation_keys | {
            "com.github.package.type",
            "org.opencontainers.image.ref.name",
            "org.opencontainers.image.source",
            "org.opencontainers.image.title",
            "org.opencontainers.image.version",
        }
        annotations = exact_keys(
            top["annotations"],
            annotation_keys,
            f"{name}/{arch} public top annotations",
        )
        source_closure_sha256 = require_string(
            annotations["dev.kandelo.homebrew.source_closure_sha256"],
            f"{name}/{arch} source closure SHA-256",
            SHA256,
        )
        if source_closure_sha256 != current_source_closure_sha256:
            fail(f"{name}/{arch} predecessor source closure changed")
        formula_identity = formula["formula_source"][
            "identity_excluding_bottle_sha256"
        ]
        expected_annotations = {
            "com.github.package.type": "homebrew_bottle",
            "dev.kandelo.homebrew.abi": str(
                authority["current_kandelo_abi"]
            ),
            "dev.kandelo.homebrew.bottle_rebuild": str(
                formula["destination"]["bottle_rebuild"]
            ),
            "dev.kandelo.homebrew.formula": name,
            "dev.kandelo.homebrew.formula_revision": str(
                extracted["formula_revision"]
            ),
            "dev.kandelo.homebrew.formula_source_identity_sha256": (
                formula_identity
            ),
            "dev.kandelo.homebrew.pkg_version": formula["version"],
            "dev.kandelo.homebrew.source_closure_sha256": (
                source_closure_sha256
            ),
            "dev.kandelo.homebrew.tap_repository": authority[
                "tap_repository"
            ].lower(),
            "org.opencontainers.image.ref.name": destination["reference"],
            "org.opencontainers.image.source": (
                "https://github.com/"
                f"{authority['tap_repository'].lower()}"
            ),
            "org.opencontainers.image.title": (
                f"{authority['tap_name']}/{name}"
            ),
            "org.opencontainers.image.version": formula["version"],
        }
        if (
            top["schemaVersion"] != 2
            or top["mediaType"]
            != "application/vnd.oci.image.index.v1+json"
            or annotations != expected_annotations
        ):
            fail(f"{name}/{arch} public top metadata changed")
        manifests = top["manifests"]
        if not isinstance(manifests, list):
            fail(f"{name}/{arch} public OCI architecture set changed")
        actual_children: dict[str, dict[str, Any]] = {}
        for position, value in enumerate(manifests):
            child = exact_keys(
                value,
                {"annotations", "digest", "mediaType", "platform", "size"},
                f"{name}/{arch} public child descriptor {position}",
            )
            platform = child["platform"]
            if platform not in (
                {
                    "architecture": "wasm",
                    "os": "kandelo",
                    "variant": "wasm32",
                },
                {
                    "architecture": "wasm",
                    "os": "kandelo",
                    "variant": "wasm64",
                },
            ):
                fail(f"{name}/{arch} public OCI architecture set changed")
            child_arch = platform["variant"]
            if child_arch in actual_children:
                fail(f"{name}/{arch} public OCI architecture set changed")
            actual_children[child_arch] = child
        if admitted_children is None:
            declared_arches = {
                variant["arch"]
                for variant in formula["variants"]
                if isinstance(variant, dict) and "reuse_source" in variant
            }
            if set(actual_children) != declared_arches:
                fail(f"{name}/{arch} public OCI architecture set changed")
        else:
            declared_arches = {
                variant["arch"]
                for variant in formula["variants"]
                if isinstance(variant, dict)
            }
            if (
                not set(admitted_children).issubset(actual_children)
                or not set(actual_children).issubset(declared_arches)
            ):
                fail(f"{name}/{arch} public OCI architecture set changed")
            for admitted_arch, admitted in admitted_children.items():
                current = actual_children[admitted_arch]
                if (
                    current["digest"] != admitted["manifest_digest"]
                    or current["size"] != admitted["manifest_size"]
                    or current["annotations"].get(
                        "org.opencontainers.image.ref.name"
                    )
                    != admitted["homebrew_ref"]
                ):
                    fail(
                        f"{name}/{arch} admitted public OCI child changed"
                    )
                current_manifest = load_oci_json_blob(
                    layout,
                    {
                        "digest": current["digest"],
                        "mediaType": current["mediaType"],
                        "size": current["size"],
                    },
                    media_type=(
                        "application/vnd.oci.image.manifest.v1+json"
                    ),
                    maximum=MAX_JSON_BYTES,
                    label=(
                        f"{name}/{admitted_arch} admitted public child "
                        "manifest"
                    ),
                )
                current_layers = current_manifest.get("layers")
                if (
                    not isinstance(current_layers, list)
                    or len(current_layers) != 1
                    or current_layers[0].get("digest")
                    != f"sha256:{admitted['bottle_sha256']}"
                    or current_layers[0].get("size")
                    != admitted["bottle_size"]
                ):
                    fail(
                        f"{name}/{arch} admitted public OCI bottle changed"
                    )
        matching_child = actual_children.get(arch)
        if matching_child is None:
            fail(f"{name}/{arch} public OCI child is missing")
        child = exact_keys(
            matching_child,
            {"annotations", "digest", "mediaType", "platform", "size"},
            f"{name}/{arch} public child descriptor",
        )
        child_manifest = load_oci_json_blob(
            layout,
            {
                "digest": child["digest"],
                "mediaType": child["mediaType"],
                "size": child["size"],
            },
            media_type="application/vnd.oci.image.manifest.v1+json",
            maximum=MAX_JSON_BYTES,
            label=f"{name}/{arch} public child manifest",
        )
        child_manifest = exact_keys(
            child_manifest,
            {"annotations", "config", "layers", "mediaType", "schemaVersion"},
            f"{name}/{arch} public child manifest",
        )
        child_annotations = child["annotations"]
        manifest_annotations = child_manifest["annotations"]
        if not isinstance(child_annotations, dict) or not isinstance(
            manifest_annotations, dict
        ):
            fail(f"{name}/{arch} public child metadata changed")
        child_source_closure_sha256 = require_string(
            child_annotations.get(
                "dev.kandelo.homebrew.source_closure_sha256"
            ),
            f"{name}/{arch} child source closure SHA-256",
            SHA256,
        )
        manifest_source_closure_sha256 = require_string(
            manifest_annotations.get(
                "dev.kandelo.homebrew.source_closure_sha256"
            ),
            f"{name}/{arch} child manifest source closure SHA-256",
            SHA256,
        )
        if not (
            source_closure_sha256
            == child_source_closure_sha256
            == manifest_source_closure_sha256
            == current_source_closure_sha256
        ):
            fail(f"{name}/{arch} predecessor source closure changed")
        expected_semantics = {
            key: expected_annotations[key]
            for key in semantic_annotation_keys
        }
        if any(
            child_annotations.get(key) != value
            or manifest_annotations.get(key) != value
            for key, value in expected_semantics.items()
        ):
            fail(f"{name}/{arch} public child metadata changed")
        layers = child_manifest["layers"]
        if not isinstance(layers, list) or len(layers) != 1:
            fail(f"{name}/{arch} public child has no exact bottle layer")
        layer = exact_keys(
            layers[0],
            {"annotations", "digest", "mediaType", "size"},
            f"{name}/{arch} public bottle layer",
        )
        expected_layer_digest = f"sha256:{archive_record['sha256']}"
        if (
            layer["digest"] != expected_layer_digest
            or layer["size"] != archive_record["bytes"]
            or layer["mediaType"]
            != "application/vnd.oci.image.layer.v1.tar+gzip"
            or child["annotations"].get("sh.brew.bottle.digest")
            != archive_record["sha256"]
            or child["annotations"].get("sh.brew.bottle.size")
            != str(archive_record["bytes"])
        ):
            fail(f"{name}/{arch} public OCI bottle layer changed")
        layer_path = regular_file(
            layout / "blobs/sha256" / archive_record["sha256"],
            f"{name}/{arch} public OCI bottle layer",
            MAX_ASSET_BYTES,
        )
        if (
            layer_path.stat().st_size != archive_record["bytes"]
            or sha256_file(layer_path) != archive_record["sha256"]
        ):
            fail(f"{name}/{arch} public OCI bottle bytes changed")
        return {
            **(
                {
                    "manifest_digest": expected_digest,
                }
                if admitted_children is None
                else {
                    "admission_manifest_digest": expected_digest,
                    "observed_manifest_digest": observed_digest,
                }
            ),
            "reference": destination["reference"],
            "remote": destination["remote"],
            "source_closure_sha256": source_closure_sha256,
        }
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


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


def handoff_bottle_identity(
    root: pathlib.Path,
    handoff: dict[str, Any],
    campaign: dict[str, Any],
    arch: str,
) -> dict[str, Any]:
    name = handoff["formula"]["name"]
    publication = handoff_publication(
        handoff, arch, f"{name}/{arch} bottle identity"
    )
    archive_path = (
        f"payload/{arch}/"
        + publication_semantic_path(
            publication,
            "bottle_archive",
            f"{name}/{arch} bottle identity",
        )
    )
    bottle_json_path = (
        f"payload/{arch}/"
        + publication_semantic_path(
            publication,
            "bottle_json",
            f"{name}/{arch} bottle identity",
        )
    )
    archive_record = handoff_publication_file(
        publication,
        archive_path,
        f"{name}/{arch} bottle identity",
    )
    bottle_json_record = handoff_publication_file(
        publication,
        bottle_json_path,
        f"{name}/{arch} bottle identity",
    )
    _canonical, digest, _root_url, _cellar = (
        validate_dependency_bottle_input(
            bottle_json=root / bottle_json_record["path"],
            handoff=handoff,
            arch=arch,
            archive_record=archive_record,
            campaign=campaign,
        )
    )
    if digest != archive_record["sha256"]:
        fail(f"{name}/{arch} bottle identity is inconsistent")
    return {
        "bytes": archive_record["bytes"],
        "path": archive_record["path"],
        "sha256": archive_record["sha256"],
    }


def validate_predecessor_campaign_compatibility(
    campaign: dict[str, Any],
    predecessor: dict[str, Any],
    formula: dict[str, Any],
    predecessor_formula: dict[str, Any],
) -> None:
    name = formula["name"]
    authority = campaign["authority"]
    predecessor_authority = predecessor["authority"]
    if (
        campaign_formula_evidence(campaign, formula)
        != campaign_formula_evidence(predecessor, predecessor_formula)
        # WHY: Formula evidence intentionally carries only runtime identity.
        # Predecessor byte reuse must also preserve the complete build/test
        # graph or it would attribute old bytes to dependencies they never
        # observed.
        or formula["dependencies"] != predecessor_formula["dependencies"]
        # WHY: The complete target tree identifies a campaign, not one
        # Formula's bottle inputs. A successor may intentionally rebuild an
        # unrelated Formula. The selected Formula digest above and its full
        # build/test dependency graph here keep reuse scoped to inputs that
        # could have produced these bytes.
        or authority["current_kandelo_abi"]
        != predecessor_authority["current_kandelo_abi"]
        or authority["guest_layout"]
        != predecessor_authority["guest_layout"]
        or authority["tap_name"] != predecessor_authority["tap_name"]
        or authority["tap_repository"].lower()
        != predecessor_authority["tap_repository"].lower()
        or authority.get("native_homebrew_commit")
        != predecessor_authority.get("native_homebrew_commit")
        or authority.get("abi_snapshot")
        != predecessor_authority.get("abi_snapshot")
    ):
        fail(f"{name} predecessor campaign changes a bottle input")
    tools = authority.get("tools")
    predecessor_tools = predecessor_authority.get("tools")
    required_tools = {
        "host/src/homebrew-vfs-fetch.ts",
        "scripts/homebrew-formula-source-digest.rb",
        "scripts/homebrew-inspect-bottle.py",
        "scripts/homebrew-publication-limits.sh",
        "scripts/homebrew-validate-wasm-artifact.sh",
        "scripts/homebrew-verify-public-bottle.ts",
    }
    if (
        not isinstance(tools, dict)
        or not isinstance(predecessor_tools, dict)
        or any(
            tools.get(path) != predecessor_tools.get(path)
            or not isinstance(tools.get(path), str)
            or SHA256.fullmatch(tools[path]) is None
            for path in required_tools
        )
    ):
        fail(f"{name} predecessor validation contract changed")


def validate_predecessor_recovery_binding(
    *,
    campaign: dict[str, Any],
    predecessor: dict[str, Any],
    predecessor_payload: bytes,
    campaign_tag: str,
) -> None:
    # WHY: the predecessor manifest describes the bytes that already exist,
    # but only the current campaign may authorize their use now. Bind the
    # immutable old manifest back to the exact recovery record instead of
    # treating possession of an old handoff as successor authority.
    record = predecessor_recovery_record(campaign, campaign_tag)
    campaign_sha256 = sha256_bytes(predecessor_payload)
    predecessor_authority = predecessor["authority"]
    if (
        record["campaign"]["sha256"] != campaign_sha256
        or record["kandelo_commit"]
        != predecessor_authority["kandelo_commit"]
        or record["source_tap_commit"]
        != predecessor_authority["source_tap_commit"]
        or record["target_tree_git_oid"]
        != source_tree_identity(predecessor_authority)
    ):
        fail("predecessor campaign differs from its recovery authority")


def derive_predecessor_reuse(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    predecessor_campaign_path: pathlib.Path,
    predecessor_handoff_root: pathlib.Path,
    formula_name: str,
    arch: str,
    predecessor_dependency_roots: list[pathlib.Path],
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
    recovery_tap_root: pathlib.Path | None = None,
    destination_verifier: PredecessorDestinationVerifier = (
        default_predecessor_destination_verifier
    ),
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    recovery_tap_root = validate_predecessor_reuse_recovery_checkout(
        campaign, recovery_tap_root
    )
    predecessor, predecessor_payload, predecessor_index = load_campaign(
        predecessor_campaign_path
    )
    formula_name = require_string(formula_name, "Formula name", FORMULA)
    if formula_name not in index or formula_name not in predecessor_index:
        fail(f"Formula {formula_name} is outside a predecessor campaign")
    if arch not in ("wasm32", "wasm64"):
        fail("predecessor reuse architecture is invalid")
    formula = index[formula_name]
    predecessor_formula = predecessor_index[formula_name]
    variant, reuse_source = validate_predecessor_reuse_variant(
        campaign, formula, arch
    )
    predecessor_campaign_match = CAMPAIGN_TAG.fullmatch(
        reuse_source["campaign_tag"]
    )
    if predecessor_campaign_match is None:
        fail("predecessor campaign tag is not content-addressed")
    if sha256_bytes(predecessor_payload) != predecessor_campaign_match.group(1):
        fail("predecessor campaign tag differs from its manifest")
    validate_predecessor_campaign_compatibility(
        campaign, predecessor, formula, predecessor_formula
    )
    source_tap_root = validate_source_root(
        source_tap_root, campaign, formula
    )
    validate_predecessor_recovery_binding(
        campaign=campaign,
        predecessor=predecessor,
        predecessor_payload=predecessor_payload,
        campaign_tag=reuse_source["campaign_tag"],
    )
    predecessor_handoff_root = real_directory(
        predecessor_handoff_root, "predecessor Formula handoff"
    )
    predecessor_dependency_roots = [
        real_directory(root, "predecessor dependency handoff")
        for root in predecessor_dependency_roots
    ]
    dependency_roots = [
        real_directory(root, "successor dependency handoff")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "predecessor reuse Formula handoff output",
        (
            campaign_path,
            source_tap_root,
            *(
                ()
                if recovery_tap_root is None
                else (recovery_tap_root,)
            ),
            predecessor_campaign_path,
            predecessor_handoff_root,
            *predecessor_dependency_roots,
            *dependency_roots,
        ),
    )
    predecessor_handoff, predecessor_handoff_payload = load_handoff(
        predecessor_handoff_root,
        predecessor,
        predecessor_payload,
    )
    predecessor_handoff_match = HANDOFF_TAG.fullmatch(
        reuse_source["handoff_tag"]
    )
    if predecessor_handoff_match is None:
        fail("predecessor handoff tag is not content-addressed")
    if (
        sha256_bytes(predecessor_handoff_payload)
        != predecessor_handoff_match.group(1)
        or predecessor_handoff["formula"]
        != campaign_formula_evidence(campaign, formula)
    ):
        fail("predecessor Formula handoff differs from its successor")
    validate_handoff_arches(predecessor_handoff, predecessor_formula)
    predecessor_publication = handoff_publication(
        predecessor_handoff,
        arch,
        f"predecessor {formula_name}/{arch}",
    )
    predecessor_kind = publication_kind(
        predecessor_publication,
        f"predecessor {formula_name}/{arch}",
    )
    # WHY: the old dependency handoffs prove what the bottle was built with;
    # the new handoffs prove what the successor campaign will expose. Both
    # closures must describe the same bottle bytes before this Formula can be
    # rebound without rebuilding it.
    (
        predecessor_dependency_records,
        predecessor_dependency_identities,
        predecessor_loaded_dependencies,
    ) = load_dependency_handoff_set(
        predecessor_dependency_roots,
        predecessor,
        predecessor_payload,
        predecessor_index,
        formula_name,
        (arch,),
    )
    if (
        predecessor_handoff["dependency_handoffs"]
        != predecessor_dependency_records
    ):
        fail("predecessor handoff dependency evidence changed")
    validate_dependency_records(
        predecessor_handoff["dependency_handoffs"],
        predecessor_dependency_identities,
    )
    (
        dependency_records,
        dependency_identities,
        loaded_dependencies,
    ) = load_dependency_handoff_set(
        dependency_roots,
        campaign,
        campaign_payload,
        index,
        formula_name,
        (arch,),
    )
    dependency_names_expected = dependency_closure(
        campaign, index, formula_name
    )
    if tuple(sorted(predecessor_loaded_dependencies)) != (
        dependency_names_expected
    ) or tuple(sorted(loaded_dependencies)) != dependency_names_expected:
        fail("predecessor and successor dependency closures differ")
    dependency_bottles: list[dict[str, Any]] = []
    for dependency_name in dependency_names_expected:
        predecessor_root, predecessor_value, predecessor_value_payload = (
            predecessor_loaded_dependencies[dependency_name]
        )
        successor_root, successor_value, successor_value_payload = (
            loaded_dependencies[dependency_name]
        )
        predecessor_bottle = handoff_bottle_identity(
            predecessor_root,
            predecessor_value,
            predecessor,
            arch,
        )
        successor_bottle = handoff_bottle_identity(
            successor_root,
            successor_value,
            campaign,
            arch,
        )
        if {
            "bytes": predecessor_bottle["bytes"],
            "sha256": predecessor_bottle["sha256"],
        } != {
            "bytes": successor_bottle["bytes"],
            "sha256": successor_bottle["sha256"],
        }:
            fail(f"dependency {dependency_name}/{arch} bottle changed")
        dependency_bottles.append(
            {
                "bytes": predecessor_bottle["bytes"],
                "formula": dependency_name,
                "predecessor_handoff_tag": handoff_tag(
                    predecessor_value_payload
                ),
                "sha256": predecessor_bottle["sha256"],
                "successor_handoff_tag": handoff_tag(
                    successor_value_payload
                ),
            }
        )
    validate_dependency_records(dependency_records, dependency_identities)
    # WHY: build handoffs bind the Formula after build-only bottle metadata
    # is normalized to its reserved destination. Reuse handoffs instead bind
    # the sealed successor Formula that authorized those historical bytes.
    expected_predecessor_formula_sha256 = (
        prepared_formula_sha256(
            source_tap_root,
            predecessor,
            predecessor_formula,
        )
        if predecessor_kind == "build"
        else predecessor_formula["formula_source"]["sha256"]
    )
    extracted, archive_record = predecessor_reuse_inputs(
        campaign=predecessor,
        formula=predecessor_formula,
        handoff_root=predecessor_handoff_root,
        handoff=predecessor_handoff,
        arch=arch,
        expected_formula_source_sha256=(
            expected_predecessor_formula_sha256
        ),
    )
    destination = destination_verifier(
        campaign,
        formula,
        arch,
        source_tap_root,
        archive_record,
        extracted,
    )
    destination_keys = (
        {
            "admission_manifest_digest",
            "observed_manifest_digest",
            "reference",
            "remote",
            "source_closure_sha256",
        }
        if formula["destination"]["admission"]["schema"] == 2
        else {
            "manifest_digest",
            "reference",
            "remote",
            "source_closure_sha256",
        }
    )
    destination = exact_keys(
        destination,
        destination_keys,
        f"{formula_name}/{arch} predecessor destination proof",
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        publication = temporary / "publication"
        (publication / "composition").mkdir(parents=True)
        (publication / "reuse").mkdir()
        archive_source = predecessor_handoff_root / archive_record["path"]
        archive = publication / "reuse/bottle.tar.gz"
        copy_verified(
            archive_source,
            archive,
            expected_bytes=archive_record["bytes"],
            expected_sha256=archive_record["sha256"],
        )
        (publication / "reuse/bottle.json").write_bytes(
            pretty_json(
                reuse_bottle_json(
                    campaign,
                    formula,
                    arch,
                    archive_record["sha256"],
                    campaign_guest_layout(campaign),
                )
            )
        )
        (publication / "composition/sidecars-input.json").write_bytes(
            pretty_json(
                predecessor_reuse_sidecars_input(
                    campaign, formula, arch, extracted
                )
            )
        )
        predecessor_record = {
            "bottle": {
                "bytes": archive_record["bytes"],
                "sha256": archive_record["sha256"],
            },
            "campaign_sha256": sha256_bytes(predecessor_payload),
            "campaign_tag": reuse_source["campaign_tag"],
            "handoff_sha256": sha256_bytes(predecessor_handoff_payload),
            "handoff_tag": reuse_source["handoff_tag"],
            "publication_kind": predecessor_kind,
            "source": predecessor_handoff["source"],
        }
        evidence = predecessor_reuse_evidence_document(
            campaign_payload=campaign_payload,
            formula=formula,
            variant=variant,
            arch=arch,
            extracted=extracted,
            predecessor=predecessor_record,
            destination=destination,
            dependency_bottles=dependency_bottles,
        )
        (publication / "reuse/evidence.json").write_bytes(
            pretty_json(evidence)
        )
        validate_reuse_publication_shape(
            publication, campaign, formula, arch
        )

        result = temporary / "handoff"
        result.mkdir()
        records: list[dict[str, Any]] = []
        for relative in REUSE_PUBLICATION_FILES:
            destination_path = result / f"payload/{arch}/{relative}"
            copy_verified(publication / relative, destination_path)
            records.append(
                file_record(
                    destination_path,
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
                "kandelo_commit": campaign["authority"]["kandelo_commit"],
                "source_tap_commit": campaign["authority"][
                    "source_tap_commit"
                ],
                "target_tree_git_oid": source_tree_identity(
                    campaign["authority"]
                ),
                "tap_name": campaign["authority"]["tap_name"],
                "tap_repository": campaign["authority"]["tap_repository"],
            },
        }
        (result / "handoff.json").write_bytes(pretty_json(manifest))
        load_handoff(result, campaign, campaign_payload)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def run_oci_layout_command(arguments: list[str], label: str) -> None:
    command = [
        sys.executable,
        str(ROOT / "scripts/homebrew-oci-layout.py"),
        *arguments,
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
        fail(f"cannot {label}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(f"cannot {label}: {detail}")


def compose_reuse_child(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    handoff_root: pathlib.Path,
    formula_name: str,
    arch: str,
    output: pathlib.Path,
) -> None:
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
    handoff_root = real_directory(handoff_root, "reuse Formula handoff")
    handoff, _handoff_payload = load_handoff(
        handoff_root, campaign, campaign_payload
    )
    if handoff["formula"] != campaign_formula_evidence(campaign, formula):
        fail("reuse Formula handoff names another Formula")
    if len(handoff["publications"]) != 1:
        fail("reuse Formula handoff must contain one publication")
    publication = handoff_publication(
        handoff, arch, f"{formula_name}/{arch} reuse publication"
    )
    if publication_kind(
        publication, f"{formula_name}/{arch} reuse publication"
    ) != "reuse":
        fail("reuse OCI composition requires a reuse publication")
    output = validate_new_output(
        output,
        "reuse OCI child output",
        (campaign_path, source_tap_root, handoff_root),
    )
    bottle_json_record = handoff_publication_file(
        publication,
        "payload/" + arch + "/reuse/bottle.json",
        f"{formula_name}/{arch} reuse publication",
    )
    archive_record = handoff_publication_file(
        publication,
        "payload/" + arch + "/reuse/bottle.tar.gz",
        f"{formula_name}/{arch} reuse publication",
    )
    bottle_json = handoff_root / bottle_json_record["path"]
    archive = handoff_root / archive_record["path"]
    canonical, digest, root_url, _cellar = (
        validate_dependency_bottle_input(
            bottle_json=bottle_json,
            handoff=handoff,
            arch=arch,
            archive_record=archive_record,
            campaign=campaign,
        )
    )
    old_record = variant["old_record"]
    if (
        digest != old_record["sha256"]
        or archive_record["bytes"] != old_record["bytes"]
    ):
        fail("reuse OCI input differs from the admitted historical bottle")

    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        canonical_bottle = temporary / "bottle.json"
        # WHY: dependency merging deliberately consumes a short Formula key,
        # while OCI publication binds the complete tap-qualified Homebrew
        # identity.  Requalify the already-validated minimal record at this
        # boundary instead of weakening either consumer's input contract.
        canonical_bottle.write_bytes(
            pretty_json(
                {
                    f"{campaign['authority']['tap_name']}/{formula_name}": (
                        canonical[formula_name]
                    )
                }
            )
        )
        child = temporary / "child"
        layout = child / "layout"
        receipt_path = child / "receipt.json"
        authority = campaign["authority"]
        # WHY: reuse preserves the public archive bytes, but its new target
        # rebuild is a distinct Homebrew package identity. Compose that
        # identity from sealed inputs before any registry credential exists.
        run_oci_layout_command(
            [
                "build-child",
                "--formula",
                formula_name,
                "--arch",
                arch,
                "--abi",
                str(authority["current_kandelo_abi"]),
                "--tap-repository",
                authority["tap_repository"],
                "--tap-name",
                authority["tap_name"],
                "--tap-commit",
                authority["source_tap_commit"],
                "--kandelo-commit",
                authority["kandelo_commit"],
                "--bottle-root-url",
                root_url,
                "--bottle",
                str(archive),
                "--bottle-json",
                str(canonical_bottle),
                "--kandelo-root",
                str(ROOT),
                "--tap-root",
                str(source_tap_root),
                "--out-layout",
                str(layout),
                "--out-receipt",
                str(receipt_path),
            ],
            f"compose reuse OCI child for {formula_name}/{arch}",
        )
        run_oci_layout_command(
            [
                "validate-child",
                "--layout",
                str(layout),
                "--receipt",
                str(receipt_path),
            ],
            f"validate reuse OCI child for {formula_name}/{arch}",
        )
        receipt, _receipt_payload = load_json_bytes(
            receipt_path,
            f"{formula_name}/{arch} reuse OCI child receipt",
            canonical=False,
        )
        if not isinstance(receipt, dict):
            fail("reuse OCI child receipt is not an object")
        rebuild = formula["destination"]["bottle_rebuild"]
        revision_match = re.search(r"_([1-9][0-9]*)$", formula["version"])
        formula_revision = (
            int(revision_match.group(1), 10) if revision_match else 0
        )
        expected_child_ref = f"{formula['version']}.{arch}_kandelo"
        if rebuild:
            expected_child_ref += f".{rebuild}"
        expected = {
            "abi": authority["current_kandelo_abi"],
            "arch": arch,
            "bottle_rebuild": rebuild,
            "formula": formula_name,
            "formula_revision": formula_revision,
            "formula_source_identity_sha256": formula["formula_source"][
                "identity_excluding_bottle_sha256"
            ],
            "formula_source_sha256": old_record["built_from"][
                "formula_sha256"
            ],
            "kandelo_commit": authority["kandelo_commit"],
            "pkg_version": formula["version"],
            "schema": 2,
            "tap_commit": authority["source_tap_commit"],
            "tap_name": authority["tap_name"],
            "tap_repository": authority["tap_repository"],
            "top_ref": formula["destination"]["reference"],
        }
        for key, value in expected.items():
            if receipt.get(key) != value:
                fail(f"reuse OCI child receipt has wrong {key}")
        if (
            receipt.get("kind") != "child"
            or receipt.get("bottle")
            != {
                "bytes": old_record["bytes"],
                "sha256": old_record["sha256"],
                "url": old_record["url"],
            }
            or not isinstance(receipt.get("oci"), dict)
            or receipt["oci"].get("homebrew_ref")
            != expected_child_ref
            or receipt["oci"].get("platform")
            != {
                "architecture": "wasm",
                "os": "kandelo",
                "variant": arch,
            }
        ):
            fail("reuse OCI child receipt differs from the campaign target")
        walk_regular_files(child, "reuse OCI child output")
        os.rename(child, output)
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
            prepared_formula_digest = sha256_file(
                private_source / formula["formula_source"]["path"]
            )
            private_publication, bound_records = snapshot_publication(
                publication,
                temporary / "publications" / arch,
                formula,
                arch,
                prepared_formula_digest,
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
                private_publication,
                formula,
                arch,
                prepared_formula_digest,
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


def github_api_token(url: str) -> str | None:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.github.com"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token is None:
        return None
    if (
        not token
        or any(not 0x21 <= ord(character) <= 0x7E for character in token)
        or len(token.encode("utf-8")) > MAX_GITHUB_TOKEN_BYTES
    ):
        fail("GitHub API token is malformed")
    return token


def http_json(url: str, label: str) -> Any:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "kandelo-homebrew-prefix-campaign",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    token = github_api_token(url)
    if token is not None:
        # WHY: GitHub-hosted runners share a very small anonymous API quota.
        # Authenticate only the first api.github.com metadata request. An
        # unredirected header cannot leak the token if GitHub redirects to
        # another host. Release assets remain anonymous so public availability
        # is still proved separately.
        request.add_unredirected_header(
            "Authorization",
            f"Bearer {token}",
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

    materialize_source = commands.add_parser("materialize-campaign-source")
    materialize_source.add_argument("--campaign", required=True)
    materialize_source.add_argument("--source-tap-root", required=True)
    materialize_source.add_argument("--out", required=True)

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

    predecessor_reuse = commands.add_parser(
        "derive-predecessor-reuse"
    )
    predecessor_reuse.add_argument("--campaign", required=True)
    predecessor_reuse.add_argument("--source-tap-root", required=True)
    predecessor_reuse.add_argument("--recovery-tap-root")
    predecessor_reuse.add_argument(
        "--predecessor-campaign", required=True
    )
    predecessor_reuse.add_argument(
        "--predecessor-handoff", required=True
    )
    predecessor_reuse.add_argument("--formula", required=True)
    predecessor_reuse.add_argument(
        "--arch", choices=("wasm32", "wasm64"), required=True
    )
    predecessor_reuse.add_argument(
        "--predecessor-dependency-handoff",
        action="append",
        default=[],
    )
    predecessor_reuse.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    predecessor_reuse.add_argument("--out", required=True)

    compose_reuse = commands.add_parser("compose-reuse-child")
    compose_reuse.add_argument("--campaign", required=True)
    compose_reuse.add_argument("--source-tap-root", required=True)
    compose_reuse.add_argument("--handoff", required=True)
    compose_reuse.add_argument("--formula", required=True)
    compose_reuse.add_argument(
        "--arch", choices=("wasm32", "wasm64"), required=True
    )
    compose_reuse.add_argument("--out", required=True)

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

    selection_release = commands.add_parser(
        "prepare-selection-release"
    )
    selection_release.add_argument("--selection", required=True)
    selection_release.add_argument("--out", required=True)

    snapshot_selection = commands.add_parser(
        "snapshot-selection-release"
    )
    snapshot_selection.add_argument("--prepared-release", required=True)
    snapshot_selection.add_argument("--out", required=True)

    fetch_selection = commands.add_parser("fetch-selection-release")
    fetch_selection.add_argument("--repository", required=True)
    fetch_selection.add_argument("--tag", required=True)
    fetch_selection.add_argument("--out", required=True)
    fetch_selection.add_argument("--receipt-out", required=True)

    verify_selection = commands.add_parser(
        "verify-selection-readback"
    )
    verify_selection.add_argument("--selection", required=True)
    verify_selection.add_argument("--receipt", required=True)
    verify_selection.add_argument("--report-out", required=True)

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
        elif arguments.command == "materialize-campaign-source":
            materialize_campaign_source(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(arguments.source_tap_root),
                output=pathlib.Path(arguments.out),
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
        elif arguments.command == "derive-predecessor-reuse":
            derive_predecessor_reuse(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(
                    arguments.source_tap_root
                ),
                recovery_tap_root=(
                    pathlib.Path(arguments.recovery_tap_root)
                    if arguments.recovery_tap_root is not None
                    else None
                ),
                predecessor_campaign_path=pathlib.Path(
                    arguments.predecessor_campaign
                ),
                predecessor_handoff_root=pathlib.Path(
                    arguments.predecessor_handoff
                ),
                formula_name=arguments.formula,
                arch=arguments.arch,
                predecessor_dependency_roots=[
                    pathlib.Path(value)
                    for value in (
                        arguments.predecessor_dependency_handoff
                    )
                ],
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "compose-reuse-child":
            compose_reuse_child(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(
                    arguments.source_tap_root
                ),
                handoff_root=pathlib.Path(arguments.handoff),
                formula_name=arguments.formula,
                arch=arguments.arch,
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
        elif arguments.command == "prepare-selection-release":
            prepare_selection_release(
                selection_root=pathlib.Path(arguments.selection),
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "snapshot-selection-release":
            snapshot_selection_release(
                prepared_root=pathlib.Path(arguments.prepared_release),
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "fetch-selection-release":
            fetch_selection_release(
                repository=arguments.repository,
                tag=arguments.tag,
                output=pathlib.Path(arguments.out),
                receipt_output=pathlib.Path(arguments.receipt_out),
            )
        elif arguments.command == "verify-selection-readback":
            verify_selection_readback(
                selection_root=pathlib.Path(arguments.selection),
                receipt_path=pathlib.Path(arguments.receipt),
                output=pathlib.Path(arguments.report_out),
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
