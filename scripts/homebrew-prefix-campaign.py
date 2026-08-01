#!/usr/bin/env python3
"""Derive or recheck the Kandelo Homebrew guest-prefix campaign."""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime
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
from collections.abc import Callable
from typing import Any, NoReturn


COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
FORMULA_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAP_PATH = re.compile(r"^[A-Za-z0-9._@%+=:-]+(?:/[A-Za-z0-9._@%+=:-]+)*$")
LINK_RELATIVE_PATH = re.compile(
    r"^[A-Za-z0-9._@%+=,:\[\]-]+(?:/[A-Za-z0-9._@%+=,:\[\]-]+)*$"
)
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_COMMAND_OUTPUT = 64 * 1024
MAX_JOBS = 8
METADATA_PATH = "Kandelo/metadata.json"
LAYOUT_PATH = "homebrew/kandelo-guest-layout.json"
INPUTS_PATH = "homebrew/guest-prefix-campaign-inputs.json"
SOURCE_AUTHORITY_PATH = "Kandelo/prefix-campaign-authority.json"
SOURCE_MANIFEST_PATH = "Kandelo/campaigns/prefix-v1/manifest.json"
SOURCE_MATERIALIZER_PATH = "scripts/prefix-campaign-source.py"
INSPECTOR_PATH = "scripts/homebrew-inspect-bottle.py"
CAMPAIGN_TOOL_PATH = "scripts/homebrew-prefix-campaign.py"
READBACK_PATH = "scripts/homebrew-verify-public-bottle.ts"
READBACK_FETCH_PATH = "host/src/homebrew-vfs-fetch.ts"
OCI_TOOL_PATH = "scripts/homebrew-oci-layout.py"
FORMULA_DIGEST_PATH = "scripts/homebrew-formula-source-digest.rb"
WASM_VALIDATOR_PATH = "scripts/homebrew-validate-wasm-artifact.sh"
PUBLICATION_LIMITS_PATH = "scripts/homebrew-publication-limits.sh"
ABI_PATH = "crates/shared/src/lib.rs"
ABI_SNAPSHOT_PATH = "abi/snapshot.json"
EXPLICIT_BUILD_ROOT = "/__kandelo_prefix_campaign_build_root__"
RECIPE_MANIFEST_NAME = "recipe.json"
RETIRED_PREFIX_NEGATIVE_TEST_PATHS = {
    "Kandelo/formula_support/test/kandelo_formula_support_test.rb",
}
RETIRED_PREFIX_HISTORICAL_DIRECTORIES = (
    "Kandelo/reports/failures/",
    "Kandelo/reports/rollbacks/",
)


# WHY: campaign JSON is capped separately at 64 MiB, but a valid compressed
# bottle may be much larger. Load the publisher's single archive policy instead
# of letting an unrelated document limit reject packages such as TeX Live.
def load_compressed_bottle_limit() -> int:
    script = pathlib.Path(__file__).with_name("homebrew-publication-limits.sh")
    command = (
        'set -euo pipefail; source "$1"; '
        'printf "%s\\n" "$HOMEBREW_MAX_BOTTLE_BYTES"'
    )
    try:
        result = subprocess.run(
            ["bash", "-c", command, "homebrew-publication-limit", str(script)],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(
            f"cannot load compressed Homebrew bottle limit: {error}"
        ) from error
    value = result.stdout.decode("ascii", errors="strict").strip()
    if (
        result.returncode != 0
        or re.fullmatch(r"[1-9][0-9]*", value) is None
    ):
        detail = result.stderr.decode("utf-8", errors="replace")[:4096]
        raise RuntimeError(
            f"cannot load compressed Homebrew bottle limit: {detail}"
        )
    return int(value, 10)


MAX_COMPRESSED_BOTTLE_BYTES = load_compressed_bottle_limit()

METADATA_KEYS = {
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
}
PACKAGE_KEYS = {
    "bottle_rebuild",
    "bottles",
    "dependencies",
    "formula_metadata",
    "formula_path",
    "formula_revision",
    "full_name",
    "name",
    "version",
}
FORMULA_SIDECAR_KEYS = {
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
}
BOTTLE_ALLOWED_KEYS = {
    "arch",
    "bottle_tag",
    "browser_compatible",
    "built_at",
    "built_by",
    "built_from",
    "bytes",
    "cache_key_sha",
    "cellar",
    "error",
    "fallback_built_at",
    "fallback_bytes",
    "fallback_cache_key_sha",
    "fallback_link_manifest",
    "fallback_sha256",
    "fallback_url",
    "fork_instrumentation",
    "kandelo_abi",
    "last_attempt",
    "last_attempt_by",
    "link_manifest",
    "prefix",
    "queued_at",
    "runtime_support",
    "sha256",
    "status",
    "url",
}
BOTTLE_REQUIRED_KEYS = {
    "arch",
    "bottle_tag",
    "browser_compatible",
    "built_by",
    "built_from",
    "cellar",
    "fork_instrumentation",
    "kandelo_abi",
    "prefix",
    "runtime_support",
    "status",
}
SUCCESS_KEYS = {"bytes", "cache_key_sha", "link_manifest", "sha256", "url"}
BUILT_FROM_KEYS = {
    "formula_sha256",
    "kandelo_commit",
    "kandelo_repository",
    "tap_commit",
    "tap_repository",
}
LINK_KEYS = {
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
}
PROVENANCE_KEYS = {
    "bottle",
    "build",
    "formula",
    "metadata",
    "repositories",
    "schema",
    "subject",
    "validation",
}
PROVENANCE_SUBJECT_KEYS = {
    "arch",
    "bottle_rebuild",
    "kandelo_abi",
    "package",
    "version",
}
PROVENANCE_REPOSITORY_KEYS = {
    "kandelo_commit",
    "kandelo_repository",
    "tap_commit",
    "tap_repository",
}
PROVENANCE_FORMULA_KEYS = {"path", "sha256"}
PROVENANCE_BOTTLE_KEYS = {
    "bottle_tag",
    "bytes",
    "cache_key_sha",
    "cellar",
    "prefix",
    "sha256",
    "url",
}
PROVENANCE_BUILD_KEYS = {
    "brew_version",
    "dev_shell",
    "github_run",
    "job",
    "runner_os",
    "sdk_fingerprint",
    "sysroot_fingerprint",
}
PROVENANCE_METADATA_KEYS = {
    "formula_json",
    "link_manifest_json",
    "metadata_json",
    "provenance_json",
}
OUTCOME_NAMES = {
    "bottle_build",
    "browser_smoke",
    "homebrew_audit",
    "node_smoke",
    "schema",
    "support_data_test",
}
LAYOUT_KEYS = {
    "cellar",
    "kind",
    "prefix",
    "repository",
    "retired_prefixes",
    "schema",
    "stable_entrypoint",
}


class CampaignError(RuntimeError):
    """A fail-closed campaign derivation error."""


def fail(message: str) -> NoReturn:
    raise CampaignError(message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_object_id(kind: str, payload: bytes) -> str:
    header = f"{kind} {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()


def filesystem_git_tree_oid(root: pathlib.Path, label: str) -> str:
    root = real_directory(root, label)

    def visit(directory: pathlib.Path) -> bytes:
        entries: list[tuple[bytes, bytes]] = []
        for child in directory.iterdir():
            name = child.name.encode("utf-8")
            if b"\0" in name or b"/" in name:
                fail(f"{label} contains an unsafe entry name")
            metadata = child.lstat()
            if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
                payload = visit(child)
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


def duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON object repeats key {key!r}")
        result[key] = value
    return result


def regular_file(path: pathlib.Path, label: str, maximum: int = MAX_JSON_BYTES) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a regular non-symlink file: {path}")
    if metadata.st_size > maximum:
        fail(f"{label} exceeds {maximum} bytes")
    return path


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a real non-symlink directory: {path}")
    return path.resolve()


def load_json_with_bytes(path: pathlib.Path, label: str) -> tuple[Any, bytes]:
    regular_file(path, label)
    payload = path.read_bytes()
    try:
        document = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda value: fail(f"{label} contains {value}"),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid strict UTF-8 JSON: {error}")
    return document, payload


def load_json(path: pathlib.Path, label: str) -> Any:
    return load_json_with_bytes(path, label)[0]


def exact_keys(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} must contain exactly {sorted(keys)}")
    return value


def allowed_keys(
    value: Any, required: set[str], allowed: set[str], label: str
) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    actual = set(value)
    if not required <= actual or not actual <= allowed:
        fail(
            f"{label} requires {sorted(required)} and permits only "
            f"{sorted(allowed)}"
        )
    return value


def require_string(
    value: Any, label: str, pattern: re.Pattern[str] | None = None
) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        fail(f"{label} must be a non-empty string")
    if pattern is not None and pattern.fullmatch(value) is None:
        fail(f"{label} has an invalid value: {value!r}")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} must be an integer >= {minimum}")
    return value


def require_sha256(value: Any, label: str) -> str:
    return require_string(value, label, SHA256)


def require_commit(value: Any, label: str) -> str:
    return require_string(value, label, COMMIT)


def require_tap_path(value: Any, label: str) -> str:
    path = require_string(value, label, TAP_PATH)
    # WHY: the JSON schemas' character grammar also admits "." and "..".
    # Campaign paths are authority-bearing filesystem inputs, so accepting
    # either segment would let a reviewed recipe or sidecar name escape its
    # owning directory while still looking schema-valid.
    if any(segment in (".", "..") for segment in path.split("/")):
        fail(f"{label} must not contain dot path segments")
    return path


def require_timestamp(value: Any, label: str) -> str:
    timestamp = require_string(value, label)
    if not timestamp.endswith("Z"):
        fail(f"{label} must be an RFC 3339 UTC timestamp")
    try:
        parsed = datetime.datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError:
        fail(f"{label} must be an RFC 3339 UTC timestamp")
    if parsed.tzinfo != datetime.timezone.utc:
        fail(f"{label} must be an RFC 3339 UTC timestamp")
    return timestamp


def regular_file_within(
    root: pathlib.Path,
    relative: str,
    label: str,
    maximum: int = MAX_JSON_BYTES,
) -> pathlib.Path:
    relative = require_tap_path(relative, f"{label} path")
    root = real_directory(root, f"{label} root")
    path = root.joinpath(*relative.split("/"))
    # WHY: checking only the final component does not prevent an intermediate
    # symlink from redirecting a reviewed relative path outside the exact Git
    # snapshot.
    current = root
    for component in relative.split("/")[:-1]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            fail(f"{label} parent does not exist: {current}")
        if not stat.S_ISDIR(metadata.st_mode) or current.is_symlink():
            fail(f"{label} parent must be a real directory: {current}")
    path = regular_file(path, label, maximum)
    if not path_is_within(path.resolve(), root):
        fail(f"{label} escapes its exact Git snapshot")
    return path


def run_command(
    command: list[str],
    *,
    cwd: pathlib.Path,
    label: str,
    timeout: int,
    environment: dict[str, str] | None = None,
) -> bytes:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=environment,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot run {label}: {error}")
    if len(result.stdout) > MAX_COMMAND_OUTPUT or len(result.stderr) > MAX_COMMAND_OUTPUT:
        fail(f"{label} output exceeds {MAX_COMMAND_OUTPUT} bytes")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:4096]
        fail(f"{label} failed: {detail}")
    return result.stdout


def git_authority(root: pathlib.Path, expected: str, label: str) -> pathlib.Path:
    root = real_directory(root, label)
    expected = require_commit(expected, f"{label} expected commit")
    top = run_command(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=root,
        label=f"{label} Git root check",
        timeout=30,
    ).decode("utf-8", errors="strict").strip()
    if pathlib.Path(top).resolve() != root:
        fail(f"{label} is not the exact Git worktree root")
    head = run_command(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        label=f"{label} Git HEAD check",
        timeout=30,
    ).decode("ascii", errors="strict").strip()
    if head != expected:
        fail(f"{label} HEAD {head} does not match exact commit {expected}")
    dirty = run_command(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=root,
        label=f"{label} cleanliness check",
        timeout=30,
    )
    if dirty:
        fail(f"{label} worktree is dirty")
    return root


def git_blob(root: pathlib.Path, commit: str, relative: str, label: str) -> bytes:
    relative = require_tap_path(relative, f"{label} path")
    try:
        result = subprocess.run(
            ["git", "show", f"{commit}:{relative}"],
            cwd=root,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot read {label}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:4096]
        fail(f"cannot read {label}: {detail}")
    if len(result.stdout) > MAX_JSON_BYTES:
        fail(f"{label} exceeds {MAX_JSON_BYTES} bytes")
    return result.stdout


def historical_metadata_history(
    root: pathlib.Path, commit: str
) -> list[tuple[str, str]]:
    output = run_command(
        [
            "git",
            "log",
            "--diff-filter=AM",
            "--format=%H",
            commit,
            "--",
            METADATA_PATH,
        ],
        cwd=root,
        label="old tap metadata history",
        timeout=120,
    ).decode("ascii", errors="strict")
    commits = output.splitlines()
    if not commits or len(commits) > 4096:
        fail("old tap metadata history is empty or unreasonably large")
    history: list[tuple[str, str]] = []
    for index, revision in enumerate(commits):
        revision = require_commit(revision, f"old metadata revision #{index}")
        history.append(
            (
                revision,
                sha256_bytes(
                    git_blob(
                        root,
                        revision,
                        METADATA_PATH,
                        f"old metadata revision {revision}",
                    )
                ),
            )
        )
    return history


def git_snapshot(
    root: pathlib.Path,
    commit: str,
    destination: pathlib.Path,
    label: str,
) -> pathlib.Path:
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
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:4096]
        fail(f"cannot snapshot {label}: {detail}")
    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            # Python's data filter rejects absolute paths, traversal, device
            # nodes, and links escaping the destination. The campaign then
            # applies stricter non-symlink checks to every authority-bearing
            # file it actually consumes.
            archive.extractall(destination, filter="data")
    except (OSError, tarfile.TarError) as error:
        fail(f"cannot extract exact {label} snapshot: {error}")
    finally:
        archive_path.unlink(missing_ok=True)
    return real_directory(destination, f"{label} snapshot")


def validate_overlay_file_record(value: Any, label: str) -> dict[str, Any]:
    record = exact_keys(
        value,
        {"blob_git_oid", "bytes", "mode", "sha256"},
        label,
    )
    require_commit(record["blob_git_oid"], f"{label} Git blob")
    require_sha256(record["sha256"], f"{label} SHA-256")
    require_int(record["bytes"], f"{label} bytes")
    if record["mode"] not in ("100644", "100755"):
        fail(f"{label} has an unsupported file mode")
    return record


def validate_overlay_file(
    path: pathlib.Path,
    record: dict[str, Any],
    label: str,
) -> None:
    path = regular_file(path, label, MAX_JSON_BYTES)
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


def candidate_source_snapshot(
    root: pathlib.Path,
    commit: str,
    destination: pathlib.Path,
) -> tuple[pathlib.Path, dict[str, Any]]:
    if destination.exists() or destination.is_symlink():
        fail("candidate source snapshot output already exists")
    parent = real_directory(destination.parent, "candidate output parent")
    with tempfile.TemporaryDirectory(
        prefix=".candidate-source-commit-", dir=parent
    ) as temporary_name:
        committed_root = git_snapshot(
            root,
            commit,
            pathlib.Path(temporary_name) / "source",
            "candidate source tap input",
        )
        authority_path = committed_root / SOURCE_AUTHORITY_PATH
        manifest_path = committed_root / SOURCE_MANIFEST_PATH
        materializer_path = committed_root / SOURCE_MATERIALIZER_PATH
        protected_paths = (
            authority_path,
            manifest_path,
            materializer_path,
        )
        present = [
            path.exists() or path.is_symlink() for path in protected_paths
        ]
        if any(present) and not all(present):
            fail(
                "candidate tap contains an incomplete protected source overlay"
            )
        if not any(present):
            tree = run_command(
                ["git", "rev-parse", f"{commit}^{{tree}}"],
                cwd=root,
                label="candidate source tap tree",
                timeout=30,
            ).decode("ascii", errors="strict").strip()
            require_commit(tree, "candidate source tap tree")
            if (
                filesystem_git_tree_oid(
                    committed_root, "candidate source tap snapshot"
                )
                != tree
            ):
                fail("candidate source snapshot differs from its Git tree")
            os.rename(committed_root, destination)
            return destination, {
                "kind": "exact-git-tree-v1",
                "tree_git_oid": tree,
            }

        authority, authority_bytes = load_json_with_bytes(
            authority_path, "candidate source overlay authority"
        )
        if authority_bytes != pretty_json(authority):
            fail("candidate source overlay authority is not canonical JSON")
        if not isinstance(authority, dict):
            fail("candidate source overlay authority must be an object")
        target = exact_keys(
            authority.get("target_source"),
            {
                "manifest_path",
                "manifest_sha256",
                "source_root",
                "source_tree_git_oid",
                "target_tree_git_oid",
            },
            "candidate source overlay target",
        )
        if (
            target["manifest_path"] != SOURCE_MANIFEST_PATH
            or target["source_root"]
            != "Kandelo/campaigns/prefix-v1/source"
        ):
            fail("candidate source overlay uses unexpected protected paths")
        manifest_sha = require_sha256(
            target["manifest_sha256"],
            "candidate source overlay manifest SHA-256",
        )
        source_tree = require_commit(
            target["source_tree_git_oid"],
            "candidate source overlay source tree",
        )
        target_tree = require_commit(
            target["target_tree_git_oid"],
            "candidate source overlay target tree",
        )
        manifest, manifest_bytes = load_json_with_bytes(
            manifest_path, "candidate source overlay manifest"
        )
        if manifest_bytes != pretty_json(manifest):
            fail("candidate source overlay manifest is not canonical JSON")
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
            "candidate source overlay manifest",
        )
        base = exact_keys(
            manifest["base"],
            {"commit", "tree_git_oid"},
            "candidate source overlay base",
        )
        base_commit = require_commit(
            base["commit"], "candidate source overlay base commit"
        )
        base_tree = require_commit(
            base["tree_git_oid"], "candidate source overlay base tree"
        )
        if (
            sha256_bytes(manifest_bytes) != manifest_sha
            or manifest["schema"] != 1
            or manifest["kind"]
            != "kandelo-homebrew-prefix-campaign-source-overlay"
            or manifest["campaign"] != "prefix-v1"
            or manifest["source_root"] != target["source_root"]
            or manifest["target_tree_git_oid"] != target_tree
        ):
            fail(
                "candidate source overlay manifest differs from its authority"
            )
        source_root = committed_root / target["source_root"]
        if (
            filesystem_git_tree_oid(
                source_root, "candidate source overlay payload"
            )
            != source_tree
        ):
            fail(
                "candidate source overlay payload differs from its authority"
            )
        regular_file(
            materializer_path,
            "candidate source overlay materializer",
            1024 * 1024,
        )
        actual_base_tree = run_command(
            ["git", "rev-parse", f"{base_commit}^{{tree}}"],
            cwd=root,
            label="candidate source overlay base tree",
            timeout=30,
        ).decode("ascii", errors="strict").strip()
        if actual_base_tree != base_tree:
            fail("candidate source overlay base differs from its sealed tree")
        files = manifest["files"]
        if not isinstance(files, list) or not files:
            fail(
                "candidate source overlay must contain a non-empty file list"
            )
        expected_sources: set[pathlib.Path] = set()
        prior = ""
        records: list[tuple[str, dict[str, Any]]] = []
        for index, value in enumerate(files):
            value = exact_keys(
                value,
                {"base", "path", "target"},
                f"candidate source overlay file #{index}",
            )
            relative = require_tap_path(
                value["path"],
                f"candidate source overlay file #{index} path",
            )
            if relative <= prior:
                fail(
                    "candidate source overlay files must be unique and sorted"
                )
            prior = relative
            target_record = validate_overlay_file_record(
                value["target"],
                f"candidate source overlay file #{index} target",
            )
            source = source_root / relative
            expected_sources.add(source)
            validate_overlay_file(
                source,
                target_record,
                f"candidate source overlay payload {relative}",
            )
            live = committed_root / relative
            if value["base"] is None:
                if live.exists() or live.is_symlink():
                    fail(
                        "candidate-only source path is already live: "
                        f"{relative}"
                    )
            else:
                base_record = validate_overlay_file_record(
                    value["base"],
                    f"candidate source overlay file #{index} base",
                )
                validate_overlay_file(
                    live,
                    base_record,
                    f"candidate source overlay live base {relative}",
                )
            records.append((relative, target_record))
        actual_sources = {
            path
            for path in source_root.rglob("*")
            if path.is_file() or path.is_symlink()
        }
        if actual_sources != expected_sources:
            fail("candidate source overlay contains unsealed files")
        # WHY: the source commit stores both the last live tap and a sealed
        # all-at-once target. Read both authorities from that immutable commit;
        # a mutable checkout is only an object database, never source bytes.
        snapshot = git_snapshot(
            root,
            base_commit,
            destination,
            "candidate source overlay base",
        )
        for relative, record in records:
            source = source_root / relative
            output = snapshot / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, output, follow_symlinks=False)
            output.chmod(
                0o755 if record["mode"] == "100755" else 0o644
            )
        if (
            filesystem_git_tree_oid(
                snapshot, "materialized candidate source tap snapshot"
            )
            != target_tree
        ):
            fail(
                "materialized candidate source tree differs from its authority"
            )
        return snapshot, {
            "authority": {
                "path": SOURCE_AUTHORITY_PATH,
                "sha256": sha256_bytes(authority_bytes),
            },
            "kind": "sealed-target-overlay-v1",
            "manifest": {
                "path": SOURCE_MANIFEST_PATH,
                "sha256": manifest_sha,
            },
            "materializer": {
                "path": SOURCE_MATERIALIZER_PATH,
                "sha256": sha256_file(materializer_path),
            },
            "source_root": target["source_root"],
            "source_tree_git_oid": source_tree,
            "target_tree_git_oid": target_tree,
        }


def path_is_within(path: pathlib.Path, root: pathlib.Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_external_output(
    output: pathlib.Path,
    *input_roots: pathlib.Path,
) -> pathlib.Path:
    if output.exists() or output.is_symlink():
        fail(f"output already exists; refusing replacement: {output}")
    parent = real_directory(output.parent, "output parent")
    resolved = parent / output.name
    if any(
        path_is_within(resolved, root.resolve())
        for root in input_roots
    ):
        fail("campaign output must be outside all clean input worktrees")
    return resolved


def write_new_file(path: pathlib.Path, payload: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    descriptor = -1
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        # WHY: link(2) fails when the destination already exists, so another
        # campaign process can never be silently replaced after derivation.
        os.link(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def derive_current_abi(kandelo_root: pathlib.Path) -> int:
    path = regular_file(kandelo_root / ABI_PATH, "Kandelo ABI source", 1024 * 1024)
    source = path.read_text(encoding="utf-8")
    matches = re.findall(r"^pub const ABI_VERSION: u32 = ([1-9][0-9]*);$", source, re.M)
    if len(matches) != 1:
        fail("Kandelo ABI source must define exactly one canonical ABI_VERSION")
    value = int(matches[0], 10)
    if value > 0xFFFFFFFF:
        fail("Kandelo ABI_VERSION exceeds u32")
    return value


def validate_abi_snapshot(
    kandelo_root: pathlib.Path, current_abi: int
) -> tuple[dict[str, Any], str]:
    path = regular_file(
        kandelo_root / ABI_SNAPSHOT_PATH,
        "Kandelo ABI snapshot",
        MAX_JSON_BYTES,
    )
    document, payload = load_json_with_bytes(path, "Kandelo ABI snapshot")
    if not isinstance(document, dict):
        fail("Kandelo ABI snapshot must be an object")
    if require_int(
        document.get("abi_version"), "Kandelo ABI snapshot abi_version", 1
    ) != current_abi:
        fail("Kandelo ABI snapshot version differs from ABI_VERSION")
    return document, sha256_bytes(payload)


def canonical_top_reference(
    helper: Callable[[str, int], str],
    version: str,
    rebuild: int,
    label: str,
) -> str:
    try:
        return helper(version, rebuild)
    except RuntimeError as error:
        fail(f"{label} has no valid canonical Homebrew OCI reference: {error}")


def validate_layout(document: Any) -> dict[str, Any]:
    layout = exact_keys(document, LAYOUT_KEYS, "guest layout")
    if layout["schema"] != 1 or layout["kind"] != "kandelo-homebrew-guest-layout":
        fail("guest layout has an unsupported contract")
    prefix = require_string(layout["prefix"], "guest layout prefix")
    cellar = require_string(layout["cellar"], "guest layout cellar")
    if (
        prefix != "/opt/kandelo/homebrew"
        or cellar != f"{prefix}/Cellar"
        or layout["repository"] != prefix
        or layout["stable_entrypoint"] != "/usr/bin/brew"
    ):
        fail("guest layout does not describe the canonical Kandelo Homebrew paths")
    retired = layout["retired_prefixes"]
    if (
        not isinstance(retired, list)
        or not retired
        or any(not isinstance(value, str) or not value.startswith("/") for value in retired)
        or retired != sorted(set(retired))
        or prefix in retired
    ):
        fail("guest layout retired_prefixes are invalid or noncanonical")
    return layout


def formula_identity(
    kandelo_root: pathlib.Path, formula_path: pathlib.Path
) -> tuple[str, str, dict[str, Any] | None]:
    source = regular_file(formula_path, "tap Formula source", 1024 * 1024).read_bytes()
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"tap Formula source is not UTF-8: {error}")
    identity = run_command(
        [
            "ruby",
            str(kandelo_root / FORMULA_DIGEST_PATH),
            "--identity-excluding-bottle",
            str(formula_path),
        ],
        cwd=kandelo_root,
        label=f"Formula structure validation for {formula_path.name}",
        timeout=30,
    ).decode("ascii", errors="strict").strip()
    require_sha256(identity, f"{formula_path.name} source identity")

    lines = text.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if line == "  bottle do\n"]
    if not starts:
        return sha256_bytes(source), identity, None
    if len(starts) != 1:
        fail(f"{formula_path.name} has multiple bottle blocks")
    start = starts[0]
    try:
        end = next(
            index for index in range(start + 1, len(lines)) if lines[index] == "  end\n"
        )
    except StopIteration:
        fail(f"{formula_path.name} has an unterminated bottle block")
    root_url: str | None = None
    rebuild = 0
    tags: dict[str, str] = {}
    for line in lines[start + 1 : end]:
        root_match = re.fullmatch(r'    root_url "(https://ghcr\.io/v2/[a-z0-9._/-]+)"\n', line)
        rebuild_match = re.fullmatch(r"    rebuild ([1-9][0-9]*)\n", line)
        tag_match = re.fullmatch(
            r'    sha256 cellar: (?:[:a-z_]+|"[^"]+"), '
            r'(wasm(?:32|64)_kandelo): "([0-9a-f]{64})"\n',
            line,
        )
        if root_match:
            if root_url is not None:
                fail(f"{formula_path.name} repeats bottle root_url")
            root_url = root_match.group(1)
        elif rebuild_match:
            if rebuild:
                fail(f"{formula_path.name} repeats bottle rebuild")
            rebuild = int(rebuild_match.group(1), 10)
        elif tag_match:
            if tag_match.group(1) in tags:
                fail(f"{formula_path.name} repeats bottle tag {tag_match.group(1)}")
            tags[tag_match.group(1)] = tag_match.group(2)
        else:
            fail(f"{formula_path.name} has unsupported canonical bottle data")
    if root_url is None or not tags:
        fail(f"{formula_path.name} has an incomplete bottle block")
    return sha256_bytes(source), identity, {
        "rebuild": rebuild,
        "root_url": root_url,
        "tags": tags,
    }


def validate_bottle(
    record: Any,
    *,
    label: str,
    formula: str,
    tap_repository: str,
    retired_prefixes: list[str],
) -> dict[str, Any]:
    bottle = allowed_keys(record, BOTTLE_REQUIRED_KEYS, BOTTLE_ALLOWED_KEYS, label)
    if bottle["status"] != "success":
        fail(f"{label} is not a successful selected bottle")
    if not SUCCESS_KEYS <= set(bottle):
        fail(f"{label} lacks required successful-bottle fields")
    if "built_at" not in bottle:
        fail(f"{label} lacks immutable build-time provenance")
    arch = bottle["arch"]
    if arch not in ("wasm32", "wasm64") or bottle["bottle_tag"] != f"{arch}_kandelo":
        fail(f"{label} has an invalid architecture/tag pair")
    require_int(bottle["kandelo_abi"], f"{label} ABI", 1)
    bottle_bytes = require_int(bottle["bytes"], f"{label} byte count", 1)
    if bottle_bytes > MAX_COMPRESSED_BOTTLE_BYTES:
        fail(
            f"{label} byte count exceeds compressed bottle limit "
            f"{MAX_COMPRESSED_BOTTLE_BYTES}"
        )
    prefix = require_guest_absolute(bottle["prefix"], f"{label} prefix")
    cellar = require_guest_absolute(bottle["cellar"], f"{label} cellar")
    # WHY: this is a one-time migration of the explicitly retired guest
    # layouts, not a generic mechanism for relabeling bottles from arbitrary
    # installations. Unknown prefixes cannot be proved compatible for reuse.
    if prefix not in retired_prefixes or cellar != f"{prefix}/Cellar":
        fail(f"{label} does not belong to an explicitly retired guest layout")
    built_by = require_string(bottle["built_by"], f"{label} built_by")
    if not built_by.startswith("https://"):
        fail(f"{label} built_by must be HTTPS")
    require_string(bottle["built_at"], f"{label} built_at")
    digest = require_sha256(bottle["sha256"], f"{label} SHA-256")
    if bottle["cache_key_sha"] != digest:
        fail(f"{label} cache_key_sha does not match its bottle SHA-256")
    expected_url = (
        f"https://ghcr.io/v2/{tap_repository.lower()}/{formula}/"
        f"blobs/sha256:{digest}"
    )
    if bottle["url"] != expected_url:
        fail(f"{label} URL does not match its repository/package/digest identity")
    require_tap_path(bottle["link_manifest"], f"{label} link manifest")
    built_from = exact_keys(bottle["built_from"], BUILT_FROM_KEYS, f"{label} built_from")
    for key in ("kandelo_commit", "tap_commit"):
        require_commit(built_from[key], f"{label} built_from.{key}")
    for key in ("kandelo_repository", "tap_repository"):
        require_string(built_from[key], f"{label} built_from.{key}", REPOSITORY)
    if built_from["tap_repository"].lower() != tap_repository.lower():
        fail(f"{label} built_from.tap_repository differs from the tap")
    require_sha256(
        built_from["formula_sha256"], f"{label} built_from.formula_sha256"
    )
    if not isinstance(bottle["runtime_support"], list):
        fail(f"{label} runtime_support must be an array")
    runtime_support = bottle["runtime_support"]
    if (
        any(not isinstance(value, str) for value in runtime_support)
        or len(runtime_support) != len(set(runtime_support))
        or any(value not in ("node", "browser") for value in runtime_support)
    ):
        fail(f"{label} runtime_support is invalid or duplicated")
    if not isinstance(bottle["browser_compatible"], bool):
        fail(f"{label} browser_compatible must be boolean")
    if (
        bottle["browser_compatible"]
        and "browser" not in runtime_support
    ):
        fail(f"{label} browser compatibility lacks browser runtime support")
    if bottle["fork_instrumentation"] not in (
        "disabled",
        "not-required",
        "required",
        "unknown",
    ):
        fail(f"{label} fork_instrumentation is invalid")
    return bottle


def validate_dependencies(
    value: Any, label: str, tap_name: str
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        fail(f"{label} must be an array")
    seen: set[str] = set()
    normalized: list[dict[str, str]] = []
    for index, dependency in enumerate(value):
        dependency = allowed_keys(
            dependency,
            {"name", "version"},
            {"full_name", "name", "version"},
            f"{label}[{index}]",
        )
        name = require_string(
            dependency["name"], f"{label}[{index}].name", FORMULA_NAME
        )
        version = require_string(
            dependency["version"], f"{label}[{index}].version", VERSION
        )
        full_name = f"{tap_name}/{name}"
        if "full_name" in dependency:
            full_name = require_string(
                dependency["full_name"], f"{label}[{index}].full_name"
            )
            if full_name != f"{tap_name}/{name}":
                fail(
                    f"{label}[{index}].full_name does not identify "
                    f"{tap_name}/{name}"
                )
        if full_name.lower() in seen:
            fail(f"{label} repeats dependency {name}")
        seen.add(full_name.lower())
        normalized.append({"full_name": full_name, "version": version})
    return sorted(
        normalized, key=lambda dependency: dependency["full_name"].lower()
    )


def require_safe_relative(
    value: Any,
    label: str,
    pattern: re.Pattern[str] = LINK_RELATIVE_PATH,
) -> str:
    path = require_string(value, label, pattern)
    if any(segment in (".", "..") for segment in path.split("/")):
        fail(f"{label} must not contain dot path segments")
    return path


def require_guest_absolute(value: Any, label: str) -> str:
    path = require_string(value, label)
    if (
        not path.startswith("/")
        or "\\" in path
        or any(character.isspace() for character in path)
        or any(segment in (".", "..") for segment in path.split("/"))
    ):
        fail(f"{label} must be a canonical absolute guest path")
    return path


def validate_string_array(value: Any, label: str) -> list[str]:
    if (
        not isinstance(value, list)
        or any(not isinstance(item, str) or not item for item in value)
    ):
        fail(f"{label} must be an array of non-empty strings")
    return value


def validate_outcomes(
    value: Any,
    *,
    label: str,
    runtime_support: list[str],
    browser_compatible: bool,
) -> None:
    validation = exact_keys(value, {"outcome_lists"}, label)
    outcomes = validation["outcome_lists"]
    if not isinstance(outcomes, list) or not outcomes:
        fail(f"{label}.outcome_lists must be a non-empty array")
    by_name: dict[str, dict[str, Any]] = {}
    for index, raw_outcome in enumerate(outcomes):
        outcome = allowed_keys(
            raw_outcome,
            {"failed", "name", "passed", "skipped", "status"},
            {
                "failed",
                "name",
                "passed",
                "skip_reason",
                "skipped",
                "status",
            },
            f"{label}.outcome_lists[{index}]",
        )
        name = require_string(
            outcome["name"], f"{label}.outcome_lists[{index}].name"
        )
        if name not in OUTCOME_NAMES or name in by_name:
            fail(f"{label} contains an invalid or repeated outcome {name!r}")
        status = outcome["status"]
        if status not in ("success", "failed", "skipped"):
            fail(f"{label} outcome {name} has an invalid status")
        for key in ("passed", "failed", "skipped"):
            validate_string_array(outcome[key], f"{label} outcome {name}.{key}")
        if status == "success" and (
            not outcome["passed"] or outcome["failed"]
        ):
            fail(f"{label} successful outcome {name} is internally inconsistent")
        if status == "failed" and not outcome["failed"]:
            fail(f"{label} failed outcome {name} lacks failures")
        if status == "skipped":
            require_string(
                outcome.get("skip_reason"),
                f"{label} skipped outcome {name}.skip_reason",
            )
            if not outcome["skipped"] or outcome["passed"] or outcome["failed"]:
                fail(f"{label} skipped outcome {name} is internally inconsistent")
        elif "skip_reason" in outcome:
            fail(f"{label} non-skipped outcome {name} has skip_reason")
        by_name[name] = outcome
    required = {"schema", "homebrew_audit", "bottle_build"}
    if not required <= set(by_name):
        fail(f"{label} lacks required build evidence {sorted(required)}")
    node_success = by_name.get("node_smoke", {}).get("status") == "success"
    browser_success = by_name.get("browser_smoke", {}).get("status") == "success"
    support_success = (
        by_name.get("support_data_test", {}).get("status") == "success"
    )
    if runtime_support:
        if support_success:
            fail(f"{label} executable evidence cannot use support_data_test")
        if node_success != ("node" in runtime_support):
            fail(f"{label} Node evidence differs from runtime_support")
        if browser_success != ("browser" in runtime_support):
            fail(f"{label} browser evidence differs from runtime_support")
    else:
        if not support_success or node_success or browser_success:
            fail(f"{label} support-data evidence differs from runtime_support")
    if browser_compatible != browser_success:
        fail(f"{label} browser evidence differs from browser_compatible")


def normalized_provenance_sha256(provenance: dict[str, Any]) -> str:
    normalized = json.loads(canonical_json(provenance))
    normalized["metadata"]["provenance_json"]["sha256"] = "0" * 64
    return sha256_bytes(pretty_json(normalized))


def validate_link_and_provenance(
    tap_root: pathlib.Path,
    *,
    formula: str,
    version: str,
    rebuild: int,
    bottle: dict[str, Any],
    formula_identity_sha256: str,
    formula_sidecar_path: str,
    formula_sidecar_sha256: str,
    metadata_hashes: set[str],
) -> tuple[dict[str, Any], dict[str, Any], str, str, str, str]:
    arch = bottle["arch"]
    expected_link = f"Kandelo/link/{formula}-{version}-rebuild{rebuild}-{arch}.json"
    if bottle["link_manifest"] != expected_link:
        fail(f"{formula}/{arch} link manifest is not its canonical identity")
    link_path = regular_file_within(
        tap_root, expected_link, f"{formula}/{arch} link manifest"
    )
    link = exact_keys(
        load_json(link_path, f"{formula}/{arch} link manifest"),
        LINK_KEYS,
        f"{formula}/{arch} link manifest",
    )
    if (
        link["schema"] != 1
        or link["package"] != formula
        or link["version"] != version
        or link["arch"] != arch
        or link["kandelo_abi"] != bottle["kandelo_abi"]
        or link["prefix"] != bottle["prefix"]
        or link["cellar"] != bottle["cellar"]
    ):
        fail(f"{formula}/{arch} link manifest identity differs from its bottle record")
    if require_guest_absolute(
        link["keg"], f"{formula}/{arch} link manifest keg"
    ) != f"{bottle['cellar']}/{formula}/{version}":
        fail(f"{formula}/{arch} link manifest keg is not canonical")
    link_bottle = exact_keys(
        link["bottle"],
        {"bytes", "cache_key_sha", "payload_root", "sha256", "url"},
        f"{formula}/{arch} link manifest bottle",
    )
    for key in ("bytes", "cache_key_sha", "sha256", "url"):
        if link_bottle[key] != bottle[key]:
            fail(f"{formula}/{arch} link manifest bottle.{key} differs from its record")
    if link_bottle["payload_root"] != f"{formula}/{version}":
        fail(f"{formula}/{arch} link manifest payload_root is not canonical")
    links = link["links"]
    if not isinstance(links, list):
        fail(f"{formula}/{arch} link manifest links must be an array")
    seen_links: set[bytes] = set()
    for index, raw_link in enumerate(links):
        link_entry = allowed_keys(
            raw_link,
            {"source", "target", "type"},
            {"mode", "source", "target", "type"},
            f"{formula}/{arch} link #{index}",
        )
        if link_entry["type"] not in ("symlink", "directory", "file"):
            fail(f"{formula}/{arch} link #{index} has an invalid type")
        require_safe_relative(
            link_entry["source"], f"{formula}/{arch} link #{index} source"
        )
        require_safe_relative(
            link_entry["target"], f"{formula}/{arch} link #{index} target"
        )
        if "mode" in link_entry and re.fullmatch(
            r"[0-7]{4}", require_string(
                link_entry["mode"], f"{formula}/{arch} link #{index} mode"
            )
        ) is None:
            fail(f"{formula}/{arch} link #{index} has an invalid mode")
        identity = canonical_json(link_entry)
        if identity in seen_links:
            fail(f"{formula}/{arch} link manifest repeats link #{index}")
        seen_links.add(identity)
    receipts = link["receipts"]
    if not isinstance(receipts, list) or not receipts:
        fail(f"{formula}/{arch} link manifest receipts must be non-empty")
    normalized_receipts = [
        require_safe_relative(value, f"{formula}/{arch} receipt #{index}")
        for index, value in enumerate(receipts)
    ]
    if len(normalized_receipts) != len(set(normalized_receipts)):
        fail(f"{formula}/{arch} link manifest repeats a receipt")
    for required_receipt in (f".brew/{formula}.rb", "INSTALL_RECEIPT.json"):
        if required_receipt not in normalized_receipts:
            fail(f"{formula}/{arch} link manifest lacks {required_receipt}")
    env = allowed_keys(
        link["env"],
        set(),
        {"PATH_prepend"},
        f"{formula}/{arch} link manifest env",
    )
    if "PATH_prepend" in env:
        paths = env["PATH_prepend"]
        if not isinstance(paths, list):
            fail(f"{formula}/{arch} link manifest PATH_prepend must be an array")
        normalized_paths = [
            require_safe_relative(
                value, f"{formula}/{arch} PATH_prepend #{index}"
            )
            for index, value in enumerate(paths)
        ]
        if len(normalized_paths) != len(set(normalized_paths)):
            fail(f"{formula}/{arch} link manifest repeats PATH_prepend")

    provenance_rel = (
        expected_link.replace("Kandelo/link/", "Kandelo/reports/")
        .removesuffix(".json")
        + ".provenance.json"
    )
    provenance_path = regular_file_within(
        tap_root, provenance_rel, f"{formula}/{arch} provenance"
    )
    provenance = exact_keys(
        load_json(provenance_path, f"{formula}/{arch} provenance"),
        PROVENANCE_KEYS,
        f"{formula}/{arch} provenance",
    )
    if provenance["schema"] != 1:
        fail(f"{formula}/{arch} provenance has an unsupported schema")
    subject = exact_keys(
        provenance["subject"],
        PROVENANCE_SUBJECT_KEYS,
        f"{formula}/{arch} provenance subject",
    )
    if any(
        subject[key] != expected
        for key, expected in {
            "arch": arch,
            "bottle_rebuild": rebuild,
            "kandelo_abi": bottle["kandelo_abi"],
            "package": formula,
            "version": version,
        }.items()
    ):
        fail(f"{formula}/{arch} provenance subject differs from its bottle identity")
    repositories = exact_keys(
        provenance["repositories"],
        PROVENANCE_REPOSITORY_KEYS,
        f"{formula}/{arch} provenance repositories",
    )
    for key in PROVENANCE_REPOSITORY_KEYS:
        if repositories[key] != bottle["built_from"][key]:
            fail(
                f"{formula}/{arch} provenance repositories.{key} "
                "differs from built_from"
            )
    provenance_formula = exact_keys(
        provenance["formula"],
        PROVENANCE_FORMULA_KEYS,
        f"{formula}/{arch} provenance formula",
    )
    if (
        provenance_formula["path"] != f"Formula/{formula}.rb"
        or provenance_formula["sha256"] != formula_identity_sha256
    ):
        fail(f"{formula}/{arch} provenance Formula identity is inconsistent")
    provenance_bottle = exact_keys(
        provenance["bottle"],
        PROVENANCE_BOTTLE_KEYS,
        f"{formula}/{arch} provenance bottle",
    )
    for key in PROVENANCE_BOTTLE_KEYS:
        if provenance_bottle[key] != bottle[key]:
            fail(f"{formula}/{arch} provenance bottle.{key} differs from its record")
    build = exact_keys(
        provenance["build"],
        PROVENANCE_BUILD_KEYS,
        f"{formula}/{arch} provenance build",
    )
    for key in ("brew_version", "dev_shell", "job", "runner_os"):
        require_string(build[key], f"{formula}/{arch} provenance build.{key}")
    if not require_string(
        build["github_run"], f"{formula}/{arch} provenance build.github_run"
    ).startswith("https://"):
        fail(f"{formula}/{arch} provenance github_run must be HTTPS")
    for key in ("sdk_fingerprint", "sysroot_fingerprint"):
        require_sha256(
            build[key], f"{formula}/{arch} provenance build.{key}"
        )
    validate_outcomes(
        provenance["validation"],
        label=f"{formula}/{arch} provenance validation",
        runtime_support=bottle["runtime_support"],
        browser_compatible=bottle["browser_compatible"],
    )
    metadata = exact_keys(
        provenance["metadata"],
        PROVENANCE_METADATA_KEYS,
        f"{formula}/{arch} provenance metadata",
    )
    expected_metadata_paths = {
        "metadata_json": METADATA_PATH,
        "formula_json": formula_sidecar_path,
        "link_manifest_json": expected_link,
        "provenance_json": provenance_rel,
    }
    for key, expected_path in expected_metadata_paths.items():
        record = exact_keys(
            metadata[key],
            {"path", "sha256"},
            f"{formula}/{arch} provenance metadata.{key}",
        )
        if require_tap_path(
            record["path"], f"{formula}/{arch} provenance metadata.{key}.path"
        ) != expected_path:
            fail(f"{formula}/{arch} provenance metadata.{key}.path is inconsistent")
        require_sha256(
            record["sha256"],
            f"{formula}/{arch} provenance metadata.{key}.sha256",
        )
    link_sha = sha256_file(link_path)
    if metadata["formula_json"]["sha256"] != formula_sidecar_sha256:
        fail(f"{formula}/{arch} provenance Formula sidecar hash is inconsistent")
    if metadata["link_manifest_json"]["sha256"] != link_sha:
        fail(f"{formula}/{arch} provenance link hash is inconsistent")
    if metadata["metadata_json"]["sha256"] not in metadata_hashes:
        fail(
            f"{formula}/{arch} provenance metadata hash is not reachable "
            "from the selected old tap history"
        )
    if (
        metadata["provenance_json"]["sha256"]
        != normalized_provenance_sha256(provenance)
    ):
        fail(f"{formula}/{arch} provenance normalized self-hash is inconsistent")
    return (
        link,
        provenance,
        expected_link,
        link_sha,
        provenance_rel,
        sha256_file(provenance_path),
    )


def inspect_sidecar_directory(
    directory: pathlib.Path,
    *,
    label: str,
    suffix: str,
    allowed_directories: set[str] = frozenset(),
    allowed_files: set[str] = frozenset(),
) -> list[pathlib.Path]:
    real_directory(directory, label)
    files: list[pathlib.Path] = []
    for entry in sorted(os.scandir(directory), key=lambda item: item.name):
        path = pathlib.Path(entry.path)
        if entry.is_symlink():
            fail(f"{label} contains symlink {entry.name!r}")
        if entry.is_dir(follow_symlinks=False):
            if entry.name not in allowed_directories:
                fail(f"{label} contains unexpected directory {entry.name!r}")
            real_directory(path, f"{label}/{entry.name}")
            continue
        if entry.is_file(follow_symlinks=False) and entry.name in allowed_files:
            regular_file(path, f"{label}/{entry.name}")
            continue
        if not entry.is_file(follow_symlinks=False) or not entry.name.endswith(suffix):
            fail(f"{label} contains unexpected entry {entry.name!r}")
        files.append(path)
    return files


def anonymous_environment() -> dict[str, str]:
    environment = dict(os.environ)
    # WHY: destination admission and old-bottle availability begin with a
    # credential-free observation. Removing every supported package credential
    # prevents ambient maintainer access from turning private visibility into
    # campaign proof.
    for name in (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HOMEBREW_GITHUB_API_TOKEN",
        "HOMEBREW_GITHUB_PACKAGES_TOKEN",
        "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    ):
        environment.pop(name, None)
    return environment


def default_fetch_bottle(
    url: str,
    sha256: str,
    byte_count: int,
    output: pathlib.Path,
    kandelo_root: pathlib.Path,
) -> None:
    run_command(
        [
            # WHY: exact campaign snapshots intentionally contain no
            # node_modules. Node 24 strips this verifier's erasable types
            # itself, so publication never downloads or discovers a runner.
            "node",
            "--experimental-strip-types",
            str(kandelo_root / READBACK_PATH),
            "--url",
            url,
            "--sha256",
            sha256,
            "--bytes",
            str(byte_count),
            "--out",
            str(output),
        ],
        cwd=kandelo_root,
        label=f"anonymous bottle readback {sha256}",
        timeout=600,
        environment=anonymous_environment(),
    )


def default_probe_destination(
    remote: str, reference: str, kandelo_root: pathlib.Path
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="kandelo-prefix-probe-") as temporary_name:
        temporary = pathlib.Path(temporary_name)
        config = temporary / "anonymous.json"
        result_path = temporary / "result.json"
        config.write_text('{"auths":{}}\n', encoding="utf-8")
        run_command(
            [
                "python3",
                str(kandelo_root / OCI_TOOL_PATH),
                "probe-registry",
                "--kind",
                "manifest",
                "--remote",
                remote,
                "--reference",
                reference,
                "--registry-config",
                str(config),
                "--out-result",
                str(result_path),
            ],
            cwd=kandelo_root,
            label=f"anonymous destination probe {remote}:{reference}",
            timeout=240,
            environment=anonymous_environment(),
        )
        result = load_json(
            result_path, "anonymous destination probe result"
        )
    return validate_destination_probe(
        result,
        f"anonymous destination probe {remote}:{reference}",
    )


def validate_destination_probe(
    value: Any,
    label: str,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {"digest", "kind", "schema", "status"},
        label,
    )
    status = value["status"]
    digest = value["digest"]
    if value["schema"] != 1 or value["kind"] != "manifest":
        fail(f"{label} has an unsupported contract")
    if status == "present":
        if not isinstance(digest, str) or OCI_DIGEST.fullmatch(digest) is None:
            fail(f"{label} present result has an invalid digest")
    elif status in ("missing", "auth-required"):
        if digest is not None:
            fail(f"{label} {status} result unexpectedly has a digest")
    else:
        fail(f"{label} status is invalid")
    return value


def destination_admission(
    probe: Any,
    *,
    formula_name: str,
    source_kind: str,
    variants: list[dict[str, Any]],
) -> dict[str, Any]:
    probe = validate_destination_probe(
        probe, f"{formula_name} destination probe"
    )
    status = probe["status"]
    if status == "present":
        fail(f"{formula_name} destination manifest is already present")
    if status == "missing":
        kind = "anonymous-absence"
    else:
        # WHY: GHCR deliberately gives the same anonymous response for a new
        # namespace and a private package. Only a reviewed new entrant may
        # defer that ambiguity to the authenticated first-package publisher;
        # existing or reusable packages must remain public facts here.
        eligible = (
            source_kind == "reviewed-new-entrant"
            and bool(variants)
            and all(
                variant.get("selected_by")
                == "reviewed-campaign-input"
                and isinstance(variant.get("build_input"), dict)
                and isinstance(variant.get("disposition"), dict)
                and variant["disposition"].get("kind")
                == "required-build"
                and variant["disposition"].get("reasons")
                == ["new-campaign-entrant"]
                and "old_record" not in variant
                for variant in variants
            )
        )
        if not eligible:
            fail(
                f"{formula_name} destination requires authentication but "
                "is not a reviewed source-only required-build entrant"
            )
        kind = "first-package-namespace-bootstrap-required"
    return {
        "kind": kind,
        "method": "anonymous-oras-manifest-probe",
        "probe": probe,
        "schema": 1,
    }


def default_resolve_formula_metadata(
    native_brew_root: pathlib.Path,
    source_tap_root: pathlib.Path,
    tap_name: str,
    formulae: list[str],
) -> dict[str, dict[str, Any]]:
    if not formulae or formulae != sorted(set(formulae)):
        fail("native Homebrew version query must be a non-empty canonical set")
    owner, tap = tap_name.split("/", 1)
    tap_destination = (
        native_brew_root
        / "Library"
        / "Taps"
        / owner
        / f"homebrew-{tap}"
    )
    if tap_destination.exists() or tap_destination.is_symlink():
        fail("exact native Homebrew snapshot unexpectedly already contains the tap")
    tap_destination.parent.mkdir(parents=True, exist_ok=True)
    # WHY: `brew info` rejects arbitrary Formula paths. Copying the already
    # immutable candidate snapshot into the exact native Homebrew snapshot
    # makes Homebrew itself parse the reviewed Formulae without consulting a
    # mutable checkout or the network.
    shutil.copytree(source_tap_root, tap_destination, symlinks=True)
    environment = anonymous_environment()
    environment.update(
        {
            "HOMEBREW_NO_ANALYTICS": "1",
            "HOMEBREW_NO_AUTO_UPDATE": "1",
            "HOMEBREW_NO_INSTALL_FROM_API": "1",
        }
    )
    command = [
        str(regular_file(native_brew_root / "bin/brew", "exact native brew")),
        "info",
        "--json=v2",
        "--formula",
        *(f"{tap_name}/{name}" for name in formulae),
    ]
    try:
        result = subprocess.run(
            command,
            cwd=native_brew_root,
            env=environment,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot resolve exact candidate Formula versions: {error}")
    if (
        len(result.stdout) > MAX_JSON_BYTES
        or len(result.stderr) > MAX_COMMAND_OUTPUT
    ):
        fail("native Homebrew Formula metadata output exceeds its bound")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:4096]
        fail(f"exact native Homebrew Formula metadata failed: {detail}")
    try:
        document = json.loads(
            result.stdout.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda value: fail(
                f"native Homebrew Formula metadata contains {value}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"native Homebrew Formula metadata is invalid JSON: {error}")
    if (
        not isinstance(document, dict)
        or set(document) != {"formulae", "casks"}
        or document["casks"] != []
        or not isinstance(document["formulae"], list)
    ):
        fail("native Homebrew Formula metadata has an unexpected root contract")
    metadata: dict[str, dict[str, Any]] = {}
    formula_set = set(formulae)
    for index, formula in enumerate(document["formulae"]):
        if not isinstance(formula, dict):
            fail(f"native Homebrew Formula metadata #{index} must be an object")
        name = require_string(
            formula.get("name"),
            f"native Homebrew Formula metadata #{index} name",
            FORMULA_NAME,
        )
        if formula.get("full_name") != f"{tap_name}/{name}":
            fail(f"native Homebrew metadata does not identify {tap_name}/{name}")
        version_record = formula.get("versions")
        if not isinstance(version_record, dict):
            fail(f"native Homebrew metadata for {name} lacks versions")
        stable = require_string(
            version_record.get("stable"),
            f"native Homebrew metadata for {name} stable version",
            VERSION,
        )
        revision = require_int(
            formula.get("revision"),
            f"native Homebrew metadata for {name} revision",
        )
        pkg_version = f"{stable}_{revision}" if revision else stable
        require_string(pkg_version, f"{name} resolved pkg_version", VERSION)
        dependency_names: set[str] = set()
        for field in (
            "dependencies",
            "build_dependencies",
            "test_dependencies",
            "recommended_dependencies",
        ):
            values = formula.get(field)
            if not isinstance(values, list) or any(
                not isinstance(value, str) or not value
                for value in values
            ):
                fail(
                    f"native Homebrew metadata for {name} has invalid {field}"
                )
            for value in values:
                prefix = f"{tap_name}/"
                # WHY: Build and test tools share these arrays with guest
                # dependencies. A build/test-only name is native unless it is
                # fully qualified, but silently treating an unqualified
                # runtime dependency as native would publish an incomplete
                # guest closure.
                if not value.startswith(prefix):
                    if field in (
                        "dependencies",
                        "recommended_dependencies",
                    ):
                        fail(
                            f"native Homebrew metadata for {name} {field} "
                            f"entry {value} must use exact {tap_name}/<formula> "
                            "guest identity"
                        )
                    continue
                candidate = value.removeprefix(prefix)
                if candidate not in formula_set:
                    fail(
                        f"native Homebrew metadata for {name} {field} "
                        f"names absent candidate Formula {value}"
                    )
                dependency_names.add(candidate)
        if name in metadata:
            fail(f"native Homebrew metadata repeats Formula {name}")
        metadata[name] = {
            "dependencies": sorted(dependency_names),
            "version": pkg_version,
        }
    if set(metadata) != formula_set:
        fail(
            "native Homebrew Formula inventory differs from candidate Formulae: "
            f"expected={formulae}, actual={sorted(metadata)}"
        )
    return metadata


FetchBottle = Callable[[str, str, int, pathlib.Path, pathlib.Path], None]
ProbeDestination = Callable[[str, str, pathlib.Path], dict[str, Any]]
ResolveFormulaMetadata = Callable[
    [pathlib.Path, pathlib.Path, str, list[str]],
    dict[str, dict[str, Any]],
]
LoadHistoricalFormula = Callable[
    [pathlib.Path, str, str, str], bytes
]


@dataclasses.dataclass(frozen=True)
class CampaignDependencies:
    fetch_bottle: FetchBottle = default_fetch_bottle
    probe_destination: ProbeDestination = default_probe_destination
    resolve_formula_metadata: ResolveFormulaMetadata = (
        default_resolve_formula_metadata
    )
    load_historical_formula: LoadHistoricalFormula | None = None


@dataclasses.dataclass(frozen=True)
class CampaignOptions:
    kandelo_root: pathlib.Path
    kandelo_commit: str
    old_tap_root: pathlib.Path
    old_tap_commit: str
    source_tap_root: pathlib.Path
    source_tap_commit: str
    native_brew_root: pathlib.Path
    native_brew_commit: str
    metadata_sha256: str
    guest_layout_sha256: str
    old_catalog_commit: str | None = None
    jobs: int = MAX_JOBS
    source_materialization: dict[str, Any] | None = None


@dataclasses.dataclass(frozen=True)
class VariantInput:
    formula: str
    version: str
    candidate_version: str
    rebuild: int
    source_kind: str
    bottle: dict[str, Any]
    formula_path: pathlib.Path
    formula_identity_sha256: str
    candidate_formula_identity_sha256: str
    historical_formula_commit: str
    historical_formula_sha256: str
    dependencies: list[dict[str, Any]]
    candidate_dependencies: list[dict[str, Any]]
    formula_sidecar_path: str
    formula_sidecar_sha256: str
    link_path: str
    link_sha256: str
    provenance_path: str
    provenance_sha256: str


def inspect_variant(
    variant: VariantInput,
    *,
    kandelo_root: pathlib.Path,
    layout: dict[str, Any],
    layout_sha256: str,
    dependencies: CampaignDependencies,
) -> dict[str, Any]:
    bottle = variant.bottle
    digest = bottle["sha256"]
    byte_count = bottle["bytes"]
    with tempfile.TemporaryDirectory(prefix="kandelo-prefix-bottle-") as temporary_name:
        temporary = pathlib.Path(temporary_name)
        archive = temporary / f"{digest}.bottle.tar.gz"
        result_path = temporary / "inspection.json"
        dependencies.fetch_bottle(
            bottle["url"], digest, byte_count, archive, kandelo_root
        )
        regular_file(
            archive,
            f"{variant.formula}/{bottle['arch']} anonymous readback",
            MAX_COMPRESSED_BOTTLE_BYTES,
        )
        actual_bytes = archive.stat().st_size
        actual_sha256 = sha256_file(archive)
        if actual_bytes != byte_count:
            fail(
                f"{variant.formula}/{bottle['arch']} anonymous byte count "
                f"{actual_bytes} differs from {byte_count}"
            )
        if actual_sha256 != digest:
            fail(
                f"{variant.formula}/{bottle['arch']} anonymous SHA-256 "
                f"{actual_sha256} differs from {digest}"
            )
        inspection_command = [
            "python3",
            str(kandelo_root / INSPECTOR_PATH),
            "--archive",
            str(archive),
            "--formula",
            variant.formula,
            "--version",
            variant.version,
            "--expected-abi",
            str(bottle["kandelo_abi"]),
            "--expected-arch",
            bottle["arch"],
            "--selected-formula",
            str(variant.formula_path),
            "--forbidden-root",
            EXPLICIT_BUILD_ROOT,
            # WHY: retired-prefix reporting must use the same reviewed layout
            # bytes that bind the campaign. Passing their digest prevents a
            # concurrent or accidental layout change from silently changing
            # which bottle bytes are eligible for reuse.
            "--report-retired-roots-layout-sha256",
            layout_sha256,
            "--out",
            str(result_path),
        ]
        if bottle["kandelo_abi"] != layout["_current_abi"]:
            # WHY: the current validator must reject a stale fork ABI. This
            # bottle is already an unconditional rebuild, so inspect its TAR,
            # receipt, dependencies, and retired paths without representing
            # those bytes as executable or compatible with the current ABI.
            inspection_command.append("--historical-incompatible-abi")
        run_command(
            inspection_command,
            cwd=kandelo_root,
            label=f"{variant.formula}/{bottle['arch']} canonical bottle inspection",
            timeout=300,
        )
        inspection = load_json(result_path, "canonical bottle inspection result")
    expected_keys = {
        "abi_version",
        "all_files",
        "arch",
        "fork_instrumentation",
        "formula_sha256",
        "path_exec_files",
        "payload_root",
        "reported_forbidden_roots",
        "runtime_dependencies",
        "schema",
    }
    inspection = exact_keys(
        inspection, expected_keys, "canonical bottle inspection result"
    )
    if (
        inspection["schema"] != 1
        or inspection["abi_version"] != bottle["kandelo_abi"]
        or inspection["arch"] != bottle["arch"]
        or inspection["payload_root"] != f"{variant.formula}/{variant.version}"
        or inspection["formula_sha256"]
        != bottle["built_from"]["formula_sha256"]
    ):
        fail(f"{variant.formula}/{bottle['arch']} inspection identity is inconsistent")
    incompatible_abi = bottle["kandelo_abi"] != layout["_current_abi"]
    if incompatible_abi:
        if (
            inspection["fork_instrumentation"]
            != "not-inspected-incompatible-abi"
        ):
            fail(
                f"{variant.formula}/{bottle['arch']} historical ABI was "
                "incorrectly admitted as executable"
            )
    elif inspection["fork_instrumentation"] != bottle["fork_instrumentation"]:
        fail(
            f"{variant.formula}/{bottle['arch']} inspected fork instrumentation "
            "differs from its selected record"
        )
    direct_dependencies = sorted(
        (
            {
                "full_name": dependency["full_name"],
                "version": dependency["version"],
            }
            for dependency in inspection["runtime_dependencies"]
            if dependency["declared_directly"]
        ),
        key=lambda dependency: dependency["full_name"].lower(),
    )
    if direct_dependencies != variant.dependencies:
        fail(
            f"{variant.formula}/{bottle['arch']} inspected direct dependencies "
            "differ from its Formula sidecar"
        )
    retired = inspection["reported_forbidden_roots"]
    if (
        not isinstance(retired, list)
        or retired != sorted(set(retired))
        or any(root not in layout["retired_prefixes"] for root in retired)
    ):
        fail(f"{variant.formula}/{bottle['arch']} inspection reported invalid roots")
    reasons = []
    # WHY: byte scans can prove that a retired pathname is absent, but they
    # cannot prove ABI compatibility. A clean ABI-41 archive therefore still
    # requires an ABI-42 build and can never be relabeled for convenience.
    if bottle["kandelo_abi"] != layout["_current_abi"]:
        reasons.append("abi-mismatch")
    if retired:
        reasons.append("retired-prefix")
    # WHY: an old bottle keeps the package version recorded in its archive and
    # sidecars. A newer candidate Formula version is a new Homebrew identity,
    # so those bytes must never be relabeled as a reuse candidate even if an
    # adversarial metadata resolver reports an otherwise identical Formula.
    if variant.version != variant.candidate_version:
        reasons.append("pkg-version-changed")
    # WHY: even unchanged Formula text can resolve a different dependency
    # version after a sibling Formula advances. Reusing that bottle would keep
    # the old runtime closure while publishing candidate dependency metadata.
    if variant.dependencies != variant.candidate_dependencies:
        reasons.append("dependency-closure-changed")
    if (
        variant.formula_identity_sha256
        != variant.candidate_formula_identity_sha256
    ):
        reasons.append("formula-source-changed")
    disposition = (
        "required-rebuild" if reasons else "byte-clean-reuse-candidate"
    )
    return {
        "anonymous_readback": {
            "bytes": actual_bytes,
            "sha256": actual_sha256,
            "url": bottle["url"],
        },
        "arch": bottle["arch"],
        "disposition": {"kind": disposition, "reasons": reasons},
        "inspection": {
            "file_count": len(inspection["all_files"]),
            "fork_instrumentation": inspection["fork_instrumentation"],
            "formula_sha256": inspection["formula_sha256"],
            "result_sha256": sha256_bytes(canonical_json(inspection)),
            "retired_prefixes": retired,
            "scan": "all-regular-members",
        },
        "old_record": bottle,
        "old_record_sha256": sha256_bytes(canonical_json(bottle)),
        "old_formula_source": {
            "commit": variant.historical_formula_commit,
            "identity_excluding_bottle_sha256": (
                variant.formula_identity_sha256
            ),
            "path": f"Formula/{variant.formula}.rb",
            "sha256": variant.historical_formula_sha256,
        },
        "provenance": {
            "path": variant.provenance_path,
            "sha256": variant.provenance_sha256,
        },
        "selected_by": variant.source_kind,
        "sidecars": {
            "formula": {
                "path": variant.formula_sidecar_path,
                "sha256": variant.formula_sidecar_sha256,
            },
            "link": {
                "path": variant.link_path,
                "sha256": variant.link_sha256,
            },
        },
    }


def retired_sidecars(
    files: list[pathlib.Path],
    *,
    tap_root: pathlib.Path,
    active: set[str],
    kind: str,
) -> list[dict[str, Any]]:
    out = []
    for path in files:
        relative = path.relative_to(tap_root).as_posix()
        if relative in active:
            continue
        out.append(
            {
                "bytes": path.stat().st_size,
                "disposition": "retired-unselected-sidecar",
                "kind": kind,
                "path": relative,
                "sha256": sha256_file(path),
            }
        )
    return out


def reject_retired_prefix_bytes(
    payload: bytes, retired_prefixes: list[str], label: str
) -> None:
    for prefix in retired_prefixes:
        if prefix.encode("utf-8") in payload:
            fail(f"{label} contains retired guest prefix {prefix}")


def retired_prefix_source_occurrences(
    tap_root: pathlib.Path, retired_prefixes: list[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tap_root = real_directory(tap_root, "candidate tap source snapshot")
    active: list[dict[str, Any]] = []
    permitted_evidence: list[dict[str, Any]] = []
    file_count = 0

    def append_occurrence(relative: str, payload: bytes) -> None:
        matched = [
            prefix
            for prefix in retired_prefixes
            if prefix.encode("utf-8") in payload
        ]
        if not matched:
            return
        record = {
            "bytes": len(payload),
            "path": relative,
            "retired_prefixes": matched,
            "sha256": sha256_bytes(payload),
        }
        if (
            relative in RETIRED_PREFIX_NEGATIVE_TEST_PATHS
            or relative.startswith(RETIRED_PREFIX_HISTORICAL_DIRECTORIES)
        ):
            permitted_evidence.append(
                {
                    **record,
                    "disposition": (
                        "permitted-historical-or-negative-evidence"
                    ),
                }
            )
        else:
            active.append(
                {
                    **record,
                    "disposition": "must-be-absent-from-final-candidate",
                }
            )

    for directory, directories, filenames in os.walk(tap_root):
        directories.sort()
        filenames.sort()
        directory_path = pathlib.Path(directory)
        for name in directories:
            path = directory_path / name
            if path.is_symlink():
                append_occurrence(
                    path.relative_to(tap_root).as_posix(),
                    os.readlink(path).encode("utf-8"),
                )
        directories[:] = [
            name
            for name in directories
            if not (directory_path / name).is_symlink()
        ]
        for filename in filenames:
            path = directory_path / filename
            relative = path.relative_to(tap_root).as_posix()
            if path.is_symlink():
                payload = os.readlink(path).encode("utf-8")
            else:
                path = regular_file(
                    path, f"candidate tap source {relative}", MAX_JSON_BYTES
                )
                payload = path.read_bytes()
            file_count += 1
            if file_count > 100_000:
                fail("candidate tap source file count exceeds 100000")
            append_occurrence(relative, payload)
    return active, permitted_evidence


def validate_final_candidate_prefixes(
    tap_root: pathlib.Path, retired_prefixes: list[str]
) -> list[dict[str, Any]]:
    active, permitted = retired_prefix_source_occurrences(
        tap_root, retired_prefixes
    )
    if active:
        paths = [record["path"] for record in active[:20]]
        suffix = "" if len(active) <= 20 else f" (+{len(active) - 20} more)"
        fail(
            "final candidate tap still contains retired guest prefixes: "
            f"{paths}{suffix}"
        )
    return permitted


def validate_required_entrant_recipe(
    source_tap_root: pathlib.Path,
    *,
    name: str,
    recipe_rel: str,
    formula_path: pathlib.Path,
    retired_prefixes: list[str],
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    lock_path = regular_file_within(
        source_tap_root, recipe_rel, f"{name} recipe lock"
    )
    lock, lock_bytes = load_json_with_bytes(lock_path, f"{name} recipe lock")
    recipe_root = real_directory(lock_path.parent, f"{name} recipe root")
    if not path_is_within(recipe_root, source_tap_root):
        fail(f"{name} recipe root escapes the candidate tap snapshot")
    manifest_path = regular_file(
        recipe_root / RECIPE_MANIFEST_NAME, f"{name} recipe manifest"
    )
    manifest, manifest_bytes = load_json_with_bytes(
        manifest_path, f"{name} recipe manifest"
    )
    manifest = exact_keys(
        manifest,
        {"dependencies", "entrypoint", "files", "schema"},
        f"{name} recipe manifest",
    )
    if manifest["schema"] != 1 or manifest["dependencies"] != []:
        fail(f"{name} recipe manifest has an unsupported contract")
    entrypoint = require_safe_relative(
        manifest["entrypoint"], f"{name} recipe entrypoint", TAP_PATH
    )
    files = manifest["files"]
    if not isinstance(files, list) or not files:
        fail(f"{name} recipe manifest files must be non-empty")
    expected_files: dict[str, dict[str, Any]] = {}
    for index, raw_file in enumerate(files):
        file_record = exact_keys(
            raw_file,
            {"bytes", "mode", "path", "sha256"},
            f"{name} recipe file #{index}",
        )
        relative = require_safe_relative(
            file_record["path"], f"{name} recipe file #{index} path", TAP_PATH
        )
        require_int(file_record["bytes"], f"{name} recipe file {relative} bytes")
        mode = require_string(
            file_record["mode"], f"{name} recipe file {relative} mode"
        )
        if re.fullmatch(r"0[0-7]{3}", mode) is None:
            fail(f"{name} recipe file {relative} has an invalid mode")
        require_sha256(
            file_record["sha256"], f"{name} recipe file {relative} SHA-256"
        )
        if relative in expected_files:
            fail(f"{name} recipe manifest repeats {relative}")
        expected_files[relative] = file_record
    if list(expected_files) != sorted(expected_files):
        fail(f"{name} recipe manifest files are not canonically ordered")
    if entrypoint not in expected_files:
        fail(f"{name} recipe manifest does not contain its entrypoint")

    actual_files: dict[str, pathlib.Path] = {}
    for directory, directories, filenames in os.walk(recipe_root):
        directories.sort()
        filenames.sort()
        directory_path = pathlib.Path(directory)
        for child in (*directories, *filenames):
            child_path = directory_path / child
            if child_path.is_symlink():
                fail(f"{name} recipe tree contains symlink {child_path}")
        for filename in filenames:
            path = directory_path / filename
            relative = path.relative_to(recipe_root).as_posix()
            if relative == RECIPE_MANIFEST_NAME:
                continue
            require_safe_relative(relative, f"{name} recipe tree path", TAP_PATH)
            actual_files[relative] = regular_file(
                path, f"{name} recipe file {relative}"
            )
    if set(actual_files) != set(expected_files):
        fail(
            f"{name} recipe tree differs from recipe.json: "
            f"actual={sorted(actual_files)}, expected={sorted(expected_files)}"
        )
    reject_retired_prefix_bytes(
        manifest_bytes, retired_prefixes, f"{name} recipe manifest"
    )
    for relative, path in actual_files.items():
        payload = path.read_bytes()
        record = expected_files[relative]
        if (
            len(payload) != record["bytes"]
            or sha256_bytes(payload) != record["sha256"]
            or f"{stat.S_IMODE(path.stat().st_mode):04o}" != record["mode"]
        ):
            fail(f"{name} recipe file {relative} differs from recipe.json")
        reject_retired_prefix_bytes(
            payload, retired_prefixes, f"{name} recipe file {relative}"
        )

    lock = exact_keys(
        lock,
        {
            "kind",
            "license",
            "outputs",
            "package",
            "patch",
            "prepared",
            "schema",
            "source",
        },
        f"{name} recipe lock",
    )
    if (
        lock["schema"] != 1
        or lock["kind"] != "kandelo-homebrew-bootstrap-tap-recipe-lock"
    ):
        fail(f"{name} recipe lock has an unsupported contract")
    package = exact_keys(
        lock["package"], {"arch", "name", "version"}, f"{name} lock package"
    )
    if package["name"] != name or package["arch"] not in ("wasm32", "wasm64"):
        fail(f"{name} recipe lock package identity is inconsistent")
    version = require_string(
        package["version"], f"{name} lock package version", VERSION
    )
    source = exact_keys(
        lock["source"],
        {
            "archive_sha256",
            "archive_url",
            "commit_timestamp",
            "repository",
            "revision",
            "tree_git_oid",
        },
        f"{name} lock source",
    )
    if source["repository"] != "https://github.com/Homebrew/brew.git":
        fail(f"{name} lock source repository is not upstream Homebrew")
    revision = require_commit(source["revision"], f"{name} lock source revision")
    if (
        source["archive_url"]
        != f"https://github.com/Homebrew/brew/archive/{revision}.tar.gz"
    ):
        fail(f"{name} lock source URL differs from its revision")
    require_sha256(source["archive_sha256"], f"{name} lock source archive SHA-256")
    require_commit(source["tree_git_oid"], f"{name} lock source tree Git OID")
    require_int(source["commit_timestamp"], f"{name} lock source timestamp", 1)
    version_revision = re.search(r"-g([0-9a-f]{7,40})$", version)
    if version_revision is None or not revision.startswith(version_revision.group(1)):
        fail(f"{name} lock version does not identify its source revision")
    patch = exact_keys(
        lock["patch"], {"path", "sha256"}, f"{name} lock patch"
    )
    patch_rel = require_safe_relative(
        patch["path"], f"{name} lock patch path", TAP_PATH
    )
    require_sha256(patch["sha256"], f"{name} lock patch SHA-256")
    if (
        patch_rel not in expected_files
        or expected_files[patch_rel]["sha256"] != patch["sha256"]
    ):
        fail(f"{name} lock patch differs from recipe.json")
    prepared = exact_keys(
        lock["prepared"],
        {
            "archive_format",
            "patched_tree_git_oid",
            "patched_tree_sha256",
            "portable_ruby_version",
        },
        f"{name} lock prepared",
    )
    require_commit(
        prepared["patched_tree_git_oid"], f"{name} patched tree Git OID"
    )
    require_sha256(
        prepared["patched_tree_sha256"], f"{name} patched tree SHA-256"
    )
    require_string(
        prepared["portable_ruby_version"], f"{name} portable Ruby version"
    )
    if prepared["archive_format"] != "kandelo-deterministic-zip-v1":
        fail(f"{name} lock archive format is unsupported")
    outputs = exact_keys(
        lock["outputs"], {"archive", "environment"}, f"{name} lock outputs"
    )
    for output_name, expected_path in (
        ("archive", "homebrew-bootstrap.zip"),
        ("environment", "homebrew-brew.env"),
    ):
        output = exact_keys(
            outputs[output_name],
            {"bytes", "path", "sha256"},
            f"{name} lock output {output_name}",
        )
        if output["path"] != expected_path:
            fail(f"{name} lock output {output_name} has a noncanonical path")
        require_int(output["bytes"], f"{name} lock output {output_name} bytes", 1)
        require_sha256(
            output["sha256"], f"{name} lock output {output_name} SHA-256"
        )
    # The license object is consumed by the exact lock verifier at build time.
    # Bind it structurally here so the campaign cannot omit it while avoiding a
    # second, drifting reimplementation of SPDX policy.
    if not isinstance(lock["license"], dict) or not lock["license"]:
        fail(f"{name} lock license evidence must be a non-empty object")

    formula_source = regular_file(
        formula_path, f"{name} candidate Formula source", 1024 * 1024
    ).read_bytes()
    formula_text = formula_source.decode("utf-8")
    manifest_matches = re.findall(
        r'manifest_sha256:\s+"([0-9a-f]{64})"', formula_text
    )
    if manifest_matches != [sha256_bytes(manifest_bytes)]:
        fail(f"{name} Formula does not bind the exact recipe.json")
    for expected in (
        f'url "{source["archive_url"]}"',
        f'version "{version}"',
        f'sha256 "{source["archive_sha256"]}"',
    ):
        if formula_text.count(expected) != 1:
            fail(f"{name} Formula source differs from its exact source lock")
    return (
        lock,
        lock_bytes,
        {
            "manifest_sha256": sha256_bytes(manifest_bytes),
            "outputs": outputs,
            "patch_sha256": patch["sha256"],
            "prepared": prepared,
            "source_revision": revision,
            "source_tree_git_oid": source["tree_git_oid"],
        },
    )


def _derive_campaign_from_snapshots(
    options: CampaignOptions,
    dependencies: CampaignDependencies,
    metadata_hashes: set[str],
    historical_formula_root: pathlib.Path,
) -> dict[str, Any]:
    if not 1 <= options.jobs <= MAX_JOBS:
        fail(f"jobs must be between 1 and {MAX_JOBS}")
    kandelo_root = real_directory(options.kandelo_root, "Kandelo snapshot")
    old_tap_root = real_directory(options.old_tap_root, "old selected tap snapshot")
    source_tap_root = real_directory(
        options.source_tap_root, "candidate source tap snapshot"
    )
    native_brew_root = real_directory(
        options.native_brew_root, "native Homebrew snapshot"
    )
    historical_formula_root = real_directory(
        historical_formula_root,
        "private historical Formula staging root",
    )
    current_abi = derive_current_abi(kandelo_root)
    _abi_snapshot, abi_snapshot_sha256 = validate_abi_snapshot(
        kandelo_root, current_abi
    )

    layout_path = regular_file(kandelo_root / LAYOUT_PATH, "guest layout")
    layout_document, layout_bytes = load_json_with_bytes(layout_path, "guest layout")
    layout_sha256 = sha256_bytes(layout_bytes)
    if layout_sha256 != require_sha256(
        options.guest_layout_sha256, "expected guest layout SHA-256"
    ):
        fail(
            f"guest layout SHA-256 {layout_sha256} does not match "
            f"{options.guest_layout_sha256}"
        )
    layout = validate_layout(layout_document)
    # Internal-only derivation context; removed before the contract is emitted.
    layout_with_abi = dict(layout)
    layout_with_abi["_current_abi"] = current_abi
    (
        candidate_retired_prefix_replacements,
        permitted_retired_prefix_evidence,
    ) = retired_prefix_source_occurrences(
        source_tap_root, layout["retired_prefixes"]
    )

    metadata_path = regular_file(old_tap_root / METADATA_PATH, "old tap metadata")
    metadata, metadata_bytes = load_json_with_bytes(metadata_path, "old tap metadata")
    metadata_sha256 = sha256_bytes(metadata_bytes)
    if metadata_sha256 != require_sha256(
        options.metadata_sha256, "expected old metadata SHA-256"
    ):
        fail(
            f"old metadata SHA-256 {metadata_sha256} does not match "
            f"{options.metadata_sha256}"
        )
    metadata = exact_keys(metadata, METADATA_KEYS, "old tap metadata")
    if metadata["schema"] != 1:
        fail("old tap metadata has an unsupported schema")
    require_timestamp(metadata["generated_at"], "old tap metadata generated_at")
    require_string(metadata["generator"], "old tap metadata generator")
    metadata_abi = require_int(metadata["kandelo_abi"], "old tap metadata ABI", 1)
    # WHY: an ABI bump starts with a catalog published for the preceding ABI.
    # That catalog is still the collision and provenance authority for its
    # immutable bottles.  The variant planner below marks every bottle whose
    # ABI differs from current_abi as a required rebuild.  Rejecting the old
    # catalog here would make it impossible to plan the first honest campaign
    # for a new ABI; accepting a catalog from a newer ABI would instead plan a
    # downlevel candidate from evidence this kernel cannot consume.
    if metadata_abi > current_abi:
        fail("old tap metadata ABI is newer than the exact Kandelo ABI")
    if metadata["release_tag"] != f"bottles-abi-v{metadata_abi}":
        fail("old tap metadata release tag does not match its ABI")
    require_commit(
        metadata["kandelo_commit"], "old tap metadata kandelo_commit"
    )
    metadata_tap_commit = require_commit(
        metadata["tap_commit"], "old tap metadata tap_commit"
    )
    old_catalog_commit = require_commit(
        options.old_catalog_commit, "old selected catalog commit"
    )
    require_string(
        metadata["kandelo_repository"],
        "old tap Kandelo repository",
        REPOSITORY,
    )
    tap_repository = require_string(
        metadata["tap_repository"], "old tap repository", REPOSITORY
    ).lower()
    tap_name = require_string(metadata["tap_name"], "old tap name", REPOSITORY).lower()
    if tap_name != tap_repository.replace("/homebrew-", "/", 1):
        fail("old tap name does not match its repository")
    if not isinstance(metadata["packages"], list) or not metadata["packages"]:
        fail("old tap metadata packages must be a non-empty array")

    formula_sidecar_files = inspect_sidecar_directory(
        old_tap_root / "Kandelo/formula",
        label="tap Formula sidecar directory",
        suffix=".json",
    )
    link_files = inspect_sidecar_directory(
        old_tap_root / "Kandelo/link",
        label="tap link sidecar directory",
        suffix=".json",
    )
    provenance_files = inspect_sidecar_directory(
        old_tap_root / "Kandelo/reports",
        label="tap provenance directory",
        suffix=".provenance.json",
        allowed_directories={"failures", "rollbacks"},
    )
    sidecars_by_name: dict[str, tuple[pathlib.Path, dict[str, Any], bytes]] = {}
    for path in formula_sidecar_files:
        name = path.name.removesuffix(".json")
        if FORMULA_NAME.fullmatch(name) is None:
            fail(f"Formula sidecar has a noncanonical filename: {path.name}")
        document, payload = load_json_with_bytes(path, f"{name} Formula sidecar")
        sidecars_by_name[name] = (
            path,
            exact_keys(document, FORMULA_SIDECAR_KEYS, f"{name} Formula sidecar"),
            payload,
        )

    selected_by_name: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(metadata["packages"]):
        package = exact_keys(value, PACKAGE_KEYS, f"metadata package #{index}")
        name = require_string(package["name"], f"metadata package #{index} name", FORMULA_NAME)
        if name in selected_by_name:
            fail(f"old tap metadata repeats package {name!r}")
        if package["formula_metadata"] != f"Kandelo/formula/{name}.json":
            fail(f"metadata package {name} names a noncanonical Formula sidecar")
        if name not in sidecars_by_name:
            fail(f"metadata package {name} lacks its Formula sidecar")
        sidecar = sidecars_by_name[name][1]
        for key in (
            "bottle_rebuild",
            "bottles",
            "dependencies",
            "formula_path",
            "formula_revision",
            "full_name",
            "name",
            "version",
        ):
            if package[key] != sidecar[key]:
                fail(f"metadata package {name} differs from its Formula sidecar at {key}")
        selected_by_name[name] = package

    old_formula_files = {
        path.name.removesuffix(".rb"): path
        for path in inspect_sidecar_directory(
            old_tap_root / "Formula",
            label="old tap Formula directory",
            suffix=".rb",
            allowed_files={"README.md"},
        )
    }
    source_formula_files = {
        path.name.removesuffix(".rb"): path
        for path in inspect_sidecar_directory(
            source_tap_root / "Formula",
            label="candidate source tap Formula directory",
            suffix=".rb",
            allowed_files={"README.md"},
        )
    }
    if any(
        FORMULA_NAME.fullmatch(name) is None
        for name in (*old_formula_files, *source_formula_files)
    ):
        fail("a tap Formula directory has a noncanonical Formula filename")
    missing_old_formula = sorted(set(sidecars_by_name) - set(old_formula_files))
    if missing_old_formula:
        fail(f"Formula sidecars lack old source Formulae: {missing_old_formula}")
    missing_source_formula = sorted(set(sidecars_by_name) - set(source_formula_files))
    if missing_source_formula:
        fail(
            "Formula sidecars lack candidate source Formulae: "
            f"{missing_source_formula}"
        )
    old_only_formulae = sorted(set(old_formula_files) - set(source_formula_files))
    if old_only_formulae:
        fail(
            "old tap Formulae disappeared without an explicit campaign "
            f"classification: {old_only_formulae}"
        )

    inputs_path = regular_file(kandelo_root / INPUTS_PATH, "campaign input contract")
    inputs, inputs_bytes = load_json_with_bytes(inputs_path, "campaign input contract")
    inputs = exact_keys(
        inputs,
        {"kind", "schema", "source_only_formulae"},
        "campaign input contract",
    )
    if (
        inputs["schema"] != 1
        or inputs["kind"] != "kandelo-homebrew-guest-prefix-campaign-inputs"
        or not isinstance(inputs["source_only_formulae"], list)
    ):
        fail("campaign input contract has an unsupported contract")
    source_only_actual = set(source_formula_files) - set(sidecars_by_name)
    source_only_contract: dict[str, dict[str, Any]] = {}
    for index, entry in enumerate(inputs["source_only_formulae"]):
        if not isinstance(entry, dict):
            fail(f"campaign source-only entry #{index} must be an object")
        disposition = entry.get("disposition")
        expected_keys = (
            {"arches", "build_input", "disposition", "formula_path", "name"}
            if disposition == "required-build"
            else {"disposition", "formula_path", "name", "reason"}
        )
        entry = exact_keys(
            entry, expected_keys, f"campaign source-only entry #{index}"
        )
        name = require_string(
            entry["name"],
            f"campaign source-only entry #{index} name",
            FORMULA_NAME,
        )
        if name in source_only_contract:
            fail(f"campaign input contract repeats source-only Formula {name}")
        if entry["formula_path"] != f"Formula/{name}.rb":
            fail(f"campaign source-only Formula {name} has a noncanonical path")
        if disposition not in ("required-build", "deferred"):
            fail(f"campaign source-only Formula {name} has an invalid disposition")
        if disposition == "required-build":
            build_input = entry["build_input"]
            if not isinstance(build_input, dict):
                fail(f"{name} entrant build input must be an object")
            build_kind = build_input.get("kind")
            build_input_keys = (
                {"kind"}
                if build_kind == "formula-source"
                else {"kind", "path"}
                if build_kind == "homebrew-bootstrap-recipe-lock"
                else set()
            )
            if not build_input_keys:
                fail(f"{name} entrant build input kind is unsupported")
            exact_keys(
                build_input,
                build_input_keys,
                f"{name} entrant build input",
            )
            # WHY: the bootstrap Formula has a larger source contract than an
            # ordinary Homebrew Formula. It must never downgrade to the plain
            # Formula-only shape and thereby bypass its archive, patch,
            # prepared-tree, license, and output validation.
            if (name == "homebrew-bootstrap") != (
                build_kind == "homebrew-bootstrap-recipe-lock"
            ):
                fail(
                    "the homebrew-bootstrap recipe-lock build input may be "
                    "used only by homebrew-bootstrap, and homebrew-bootstrap "
                    "must use it"
                )
        source_only_contract[name] = entry
    # WHY: a source-only Formula has no old sidecar from which disposition can
    # be derived. Exact closure forces every new or deferred Formula through a
    # reviewed machine contract instead of a hidden filename exception.
    if set(source_only_contract) != source_only_actual:
        fail(
            "source-only Formula inventory differs from the reviewed campaign "
            f"contract: actual={sorted(source_only_actual)}, "
            f"contract={sorted(source_only_contract)}"
        )
    resolved_metadata = dependencies.resolve_formula_metadata(
        native_brew_root,
        source_tap_root,
        tap_name,
        sorted(source_formula_files),
    )
    if set(resolved_metadata) != set(source_formula_files):
        fail("exact native Homebrew metadata resolution returned an incomplete set")
    resolved_versions: dict[str, str] = {}
    for name, raw_metadata in resolved_metadata.items():
        formula_metadata = exact_keys(
            raw_metadata,
            {"dependencies", "version"},
            f"{name} resolved Formula metadata",
        )
        resolved_versions[name] = require_string(
            formula_metadata["version"],
            f"{name} resolved pkg_version",
            VERSION,
        )
    resolved_dependencies: dict[str, list[dict[str, str]]] = {}
    for name, raw_metadata in resolved_metadata.items():
        formula_metadata = exact_keys(
            raw_metadata,
            {"dependencies", "version"},
            f"{name} resolved Formula metadata",
        )
        dependency_names = formula_metadata["dependencies"]
        if (
            not isinstance(dependency_names, list)
            or dependency_names != sorted(set(dependency_names))
            or any(
                not isinstance(value, str)
                or FORMULA_NAME.fullmatch(value) is None
                for value in dependency_names
            )
        ):
            fail(f"{name} resolved dependencies are not a canonical name set")
        if name in dependency_names:
            fail(f"{name} resolved dependencies include itself")
        resolved_dependencies[name] = [
            {
                "full_name": f"{tap_name}/{dependency_name}",
                "version": require_string(
                    resolved_versions.get(dependency_name),
                    f"{name} dependency {dependency_name} resolved version",
                    VERSION,
                ),
            }
            for dependency_name in dependency_names
        ]
    scheduled_formulae = set(sidecars_by_name) | {
        name
        for name, entry in source_only_contract.items()
        if entry["disposition"] == "required-build"
    }
    for name in sorted(scheduled_formulae):
        unavailable = [
            dependency["full_name"].removeprefix(f"{tap_name}/")
            for dependency in resolved_dependencies[name]
            if dependency["full_name"].removeprefix(f"{tap_name}/")
            not in scheduled_formulae
        ]
        if unavailable:
            fail(
                f"{name} depends on deferred campaign Formulae "
                f"{sorted(unavailable)}"
            )
    reached: set[str] = set()
    visiting: set[str] = set()

    def visit_formula(name: str) -> None:
        if name in visiting:
            fail(f"candidate Formula dependency graph cycles at {name}")
        if name in reached:
            return
        visiting.add(name)
        for dependency in resolved_dependencies[name]:
            visit_formula(
                dependency["full_name"].removeprefix(f"{tap_name}/")
            )
        visiting.remove(name)
        reached.add(name)

    for name in sorted(scheduled_formulae):
        visit_formula(name)
    if dependencies.load_historical_formula is None:
        fail("exact historical Formula loader is unavailable")

    top_reference = runpy.run_path(str(kandelo_root / OCI_TOOL_PATH))["top_reference"]
    formula_records: list[dict[str, Any]] = []
    variant_inputs: list[VariantInput] = []
    active_links: set[str] = set()
    active_provenance: set[str] = set()
    formula_context: dict[str, dict[str, Any]] = {}

    def stage_historical_formula(
        name: str, commit: str, label: str
    ) -> pathlib.Path:
        payload = dependencies.load_historical_formula(
            old_tap_root,
            name,
            commit,
            f"Formula/{name}.rb",
        )
        if (
            not isinstance(payload, bytes)
            or not payload
            or len(payload) > 1024 * 1024
        ):
            fail(f"{name} {label} Formula source is invalid")
        digest = sha256_bytes(payload)
        # WHY: the tap snapshot is repository-controlled input. Staging under
        # it would let a tracked directory or leaf symlink redirect generated
        # writes into repository-selected paths. This root is created by the
        # tool beside its private input snapshots, so repository contents
        # cannot choose the destination.
        path = historical_formula_root / f"{digest}.rb"
        if path.exists():
            if (
                regular_file(
                    path,
                    f"{name} historical Formula staging",
                    1024 * 1024,
                ).read_bytes()
                != payload
            ):
                fail(f"{name} historical Formula staging collided")
        else:
            write_new_file(path, payload)
        return path

    for name in sorted(sidecars_by_name):
        sidecar_path, sidecar, sidecar_bytes = sidecars_by_name[name]
        sidecar_name = require_string(
            sidecar["name"], f"{name} Formula sidecar name", FORMULA_NAME
        )
        sidecar_repository = require_string(
            sidecar["tap_repository"],
            f"{name} Formula sidecar tap_repository",
            REPOSITORY,
        ).lower()
        sidecar_tap_name = require_string(
            sidecar["tap_name"],
            f"{name} Formula sidecar tap_name",
            REPOSITORY,
        ).lower()
        if (
            sidecar["schema"] != 1
            or sidecar_name != name
            or sidecar_repository != tap_repository
            or sidecar_tap_name != tap_name
            or sidecar["source_metadata"] != METADATA_PATH
            or sidecar["formula_path"] != f"Formula/{name}.rb"
        ):
            fail(f"{name} Formula sidecar has inconsistent top-level identity")
        old_version = require_string(
            sidecar["version"], f"{name} old selected version", VERSION
        )
        candidate_version = resolved_versions[name]
        rebuild = require_int(sidecar["bottle_rebuild"], f"{name} bottle rebuild")
        require_int(sidecar["formula_revision"], f"{name} Formula revision")
        if sidecar["full_name"] != f"{tap_name}/{name}":
            fail(f"{name} Formula sidecar full_name is inconsistent")
        normalized_dependencies = validate_dependencies(
            sidecar["dependencies"], f"{name} dependencies", tap_name
        )
        sidecar_abi = require_int(
            sidecar["kandelo_abi"], f"{name} sidecar ABI", 1
        )
        sidecar_tap_commit = require_commit(
            sidecar["tap_commit"], f"{name} sidecar tap commit"
        )
        if name in selected_by_name and (
            sidecar_abi != metadata_abi
            or sidecar_tap_commit != metadata_tap_commit
        ):
            fail(
                f"metadata-selected Formula {name} sidecar ABI/tap_commit "
                "differs from selected metadata"
            )
        # WHY: the old archive was built from the old Formula. Candidate
        # new-prefix source is a separate authority and must never be
        # substituted into immutable built_from provenance.
        # WHY: built_from and metadata.tap_commit own publisher inputs. The
        # later commit containing this exact metadata blob owns the finalized
        # bottle block. Live source may already be ahead, while a stale extra
        # sidecar can predate it. Neither is the collision/rebuild authority.
        old_formula_path = stage_historical_formula(
            name, old_catalog_commit, "old catalog"
        )
        selected_old_source_sha, selected_old_source_identity, old_bottle_block = formula_identity(
            kandelo_root, old_formula_path
        )
        source_formula_path = source_formula_files[name]
        source_sha, source_identity, source_bottle_block = formula_identity(
            kandelo_root, source_formula_path
        )
        if old_bottle_block is None:
            fail(f"{name} has bottle sidecars but no old Formula bottle block")
        expected_root = f"https://ghcr.io/v2/{tap_repository}"
        if old_bottle_block["root_url"] != expected_root:
            fail(f"{name} old Formula bottle identity differs from its sidecar")
        if (
            sidecar_abi == current_abi
            and old_bottle_block["rebuild"] != rebuild
        ):
            fail(
                f"{name} current-ABI old Formula rebuild differs from its "
                "sidecar"
            )
        # WHY: a new pkg_version has its own Homebrew bottle namespace and
        # starts at rebuild zero. Its sealed candidate Formula must therefore
        # be bottleless. For an unchanged pkg_version, the selected block is
        # still the collision authority and must match the old sidecars.
        version_changed = candidate_version != old_version
        if version_changed:
            if source_bottle_block is not None:
                fail(
                    f"{name} candidate pkg_version changed from {old_version} "
                    f"to {candidate_version}, but its Formula still has a "
                    "bottle block"
                )
        elif source_bottle_block is None:
            fail(
                f"{name} has bottle sidecars but no candidate Formula bottle "
                "block for the unchanged pkg_version"
            )
        else:
            if source_bottle_block["root_url"] != expected_root:
                fail(
                    f"{name} candidate Formula bottle identity differs from "
                    "its sidecar"
                )
            if (
                sidecar_abi == current_abi
                and source_bottle_block["rebuild"] != rebuild
            ):
                fail(
                    f"{name} current-ABI candidate Formula rebuild differs "
                    "from its sidecar"
                )
        bottles = sidecar["bottles"]
        if not isinstance(bottles, list) or not bottles:
            fail(f"{name} Formula sidecar bottles must be non-empty")
        seen_arches: set[str] = set()
        expected_tags: dict[str, str] = {}
        source_kind = (
            "metadata-selected" if name in selected_by_name else "formula-sidecar-extra"
        )
        historical_formula_sources: set[tuple[str, str]] = set()
        for index, raw_bottle in enumerate(bottles):
            if not isinstance(raw_bottle, dict) or not isinstance(
                raw_bottle.get("built_from"), dict
            ):
                fail(f"{name} bottle #{index} lacks built_from provenance")
            built_from_tap_commit = require_commit(
                raw_bottle["built_from"].get("tap_commit"),
                f"{name} bottle #{index} built_from.tap_commit",
            )
            historical_formula_path = stage_historical_formula(
                name, built_from_tap_commit, "built-from"
            )
            (
                historical_source_sha,
                historical_source_identity,
                _historical_bottle_block,
            ) = formula_identity(kandelo_root, historical_formula_path)
            claimed_formula_sha256 = require_sha256(
                raw_bottle["built_from"].get("formula_sha256"),
                f"{name} bottle #{index} built_from.formula_sha256",
            )
            historical_formula_sources.add(
                (historical_source_sha, historical_source_identity)
            )
            bottle = validate_bottle(
                raw_bottle,
                label=f"{name} bottle #{index}",
                formula=name,
                tap_repository=tap_repository,
                retired_prefixes=layout["retired_prefixes"],
            )
            if bottle["kandelo_abi"] != sidecar["kandelo_abi"]:
                fail(f"{name}/{bottle['arch']} ABI differs from its Formula sidecar")
            if bottle["arch"] in seen_arches:
                fail(f"{name} repeats architecture {bottle['arch']}")
            seen_arches.add(bottle["arch"])
            expected_tags[bottle["bottle_tag"]] = bottle["sha256"]
            (
                _link,
                _provenance,
                link_rel,
                link_sha,
                provenance_rel,
                provenance_sha,
            ) = validate_link_and_provenance(
                old_tap_root,
                formula=name,
                version=old_version,
                rebuild=rebuild,
                bottle=bottle,
                formula_identity_sha256=claimed_formula_sha256,
                formula_sidecar_path=(
                    sidecar_path.relative_to(old_tap_root).as_posix()
                ),
                formula_sidecar_sha256=sha256_bytes(sidecar_bytes),
                metadata_hashes=metadata_hashes,
            )
            if link_rel in active_links or provenance_rel in active_provenance:
                fail(f"{name}/{bottle['arch']} repeats a live sidecar path")
            active_links.add(link_rel)
            active_provenance.add(provenance_rel)
            variant_inputs.append(
                VariantInput(
                    formula=name,
                    version=old_version,
                    candidate_version=candidate_version,
                    rebuild=rebuild,
                    source_kind=source_kind,
                    bottle=bottle,
                    formula_path=historical_formula_path,
                    formula_identity_sha256=historical_source_identity,
                    candidate_formula_identity_sha256=source_identity,
                    historical_formula_commit=built_from_tap_commit,
                    historical_formula_sha256=historical_source_sha,
                    dependencies=normalized_dependencies,
                    candidate_dependencies=resolved_dependencies[name],
                    formula_sidecar_path=sidecar_path.relative_to(old_tap_root).as_posix(),
                    formula_sidecar_sha256=sha256_bytes(sidecar_bytes),
                    link_path=link_rel,
                    link_sha256=link_sha,
                    provenance_path=provenance_rel,
                    provenance_sha256=provenance_sha,
                )
            )
        if (
            sidecar_abi == current_abi
            and old_bottle_block["tags"] != expected_tags
        ):
            fail(f"{name} old Formula bottle tags differ from its sidecar bottles")
        if (
            not version_changed
            and sidecar_abi == current_abi
            and source_bottle_block is not None
            and source_bottle_block["tags"] != expected_tags
        ):
            fail(
                f"{name} candidate Formula bottle tags differ from its "
                "old selected bottles"
            )
        # Historical extra sidecars can predate the Formula's currently
        # selected rebuild even when they preserve useful immutable evidence.
        # An unchanged version reserves above all of them. A changed version
        # owns a separate namespace and truthfully begins at rebuild zero.
        next_rebuild = (
            0
            if version_changed
            else max(
                rebuild,
                old_bottle_block["rebuild"],
                source_bottle_block["rebuild"],
            )
            + 1
        )
        reference = canonical_top_reference(
            top_reference, candidate_version, next_rebuild, name
        )
        formula_context[name] = {
            "dependencies": resolved_dependencies[name],
            "destination": {
                "bottle_rebuild": next_rebuild,
                "reference": reference,
                "remote": f"ghcr.io/{tap_repository}/{name}",
            },
            "formula_source": {
                "identity_excluding_bottle_sha256": source_identity,
                "path": f"Formula/{name}.rb",
                "sha256": source_sha,
            },
            "old_formula_sources": [
                {
                    "built_from_formula_sha256_kind": "archived-receipt-sha256",
                    "identity_excluding_bottle_sha256": identity,
                    "path": f"Formula/{name}.rb",
                    "sha256": source_sha,
                }
                for source_sha, identity in sorted(historical_formula_sources)
            ],
            "old_selected_formula_source": {
                "identity_excluding_bottle_sha256": selected_old_source_identity,
                "path": f"Formula/{name}.rb",
                "sha256": selected_old_source_sha,
            },
            "formula_sidecar": {
                "path": sidecar_path.relative_to(old_tap_root).as_posix(),
                "sha256": sha256_bytes(sidecar_bytes),
            },
            "name": name,
            "source_kind": source_kind,
            "version": candidate_version,
        }

    deferred_formulae: list[dict[str, Any]] = []
    entrant_variants: dict[str, list[dict[str, Any]]] = {}
    for name in sorted(source_only_contract):
        entry = source_only_contract[name]
        source_sha, source_identity, bottle_block = formula_identity(
            kandelo_root, source_formula_files[name]
        )
        if bottle_block is not None:
            fail(f"source-only Formula {name} unexpectedly has a bottle block")
        if entry["disposition"] == "deferred":
            deferred_formulae.append(
                {
                    "disposition": "deferred",
                    "formula_source": {
                        "identity_excluding_bottle_sha256": source_identity,
                        "path": entry["formula_path"],
                        "sha256": source_sha,
                    },
                    "name": name,
                    "reason": require_string(entry["reason"], f"{name} deferral reason"),
                    "version": resolved_versions[name],
                }
            )
            continue
        arches = entry["arches"]
        if (
            not isinstance(arches, list)
            or not arches
            or arches != sorted(set(arches))
            or any(arch not in ("wasm32", "wasm64") for arch in arches)
        ):
            fail(f"{name} entrant arches are invalid or noncanonical")
        build_input = entry["build_input"]
        build_kind = build_input["kind"]
        version = resolved_versions[name]
        campaign_build_input: dict[str, Any]
        recipe_context: dict[str, Any] = {}
        if build_kind == "formula-source":
            # Formula source, exact Homebrew metadata, target architecture,
            # dependency edges, and destination admission are already sealed
            # by the ordinary campaign record. No synthetic recipe lock exists
            # for a conventional Formula such as libyaml.
            campaign_build_input = {"kind": "formula-source"}
        else:
            recipe_rel = require_tap_path(
                build_input["path"], f"{name} recipe lock"
            )
            recipe, recipe_bytes, recipe_evidence = (
                validate_required_entrant_recipe(
                    source_tap_root,
                    name=name,
                    recipe_rel=recipe_rel,
                    formula_path=source_formula_files[name],
                    retired_prefixes=layout["retired_prefixes"],
                )
            )
            package = recipe["package"]
            if arches != [package["arch"]]:
                fail(
                    f"{name} entrant arches must exactly equal its "
                    "recipe-lock arch"
                )
            recipe_version = require_string(
                package["version"],
                f"{name} recipe version",
                VERSION,
            )
            if version != recipe_version:
                fail(
                    f"{name} native Homebrew pkg_version {version} differs "
                    f"from its exact recipe lock {recipe_version}"
                )
            recipe_lock = {
                "path": recipe_rel,
                "sha256": sha256_bytes(recipe_bytes),
            }
            campaign_build_input = {
                "kind": "homebrew-bootstrap-recipe-lock",
                "recipe_lock": recipe_lock,
            }
            recipe_context = {
                "recipe_lock": {
                    **recipe_lock,
                    **recipe_evidence,
                }
            }
        reference = canonical_top_reference(top_reference, version, 0, name)
        formula_context[name] = {
            "dependencies": resolved_dependencies[name],
            "destination": {
                "bottle_rebuild": 0,
                "reference": reference,
                "remote": f"ghcr.io/{tap_repository}/{name}",
            },
            "formula_source": {
                "identity_excluding_bottle_sha256": source_identity,
                "path": entry["formula_path"],
                "sha256": source_sha,
            },
            "name": name,
            **recipe_context,
            "source_kind": "reviewed-new-entrant",
            "version": version,
        }
        entrant_variants[name] = [
            {
                "arch": arch,
                "build_input": campaign_build_input,
                "disposition": {
                    "kind": "required-build",
                    "reasons": ["new-campaign-entrant"],
                },
                "selected_by": "reviewed-campaign-input",
            }
            for arch in arches
        ]

    variant_results: dict[tuple[str, str], dict[str, Any]] = {}
    probe_results: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=options.jobs) as executor:
        variant_futures = {
            executor.submit(
                inspect_variant,
                variant,
                kandelo_root=kandelo_root,
                layout=layout_with_abi,
                layout_sha256=layout_sha256,
                dependencies=dependencies,
            ): (variant.formula, variant.bottle["arch"])
            for variant in variant_inputs
        }
        probe_futures = {
            executor.submit(
                dependencies.probe_destination,
                context["destination"]["remote"],
                context["destination"]["reference"],
                kandelo_root,
            ): name
            for name, context in formula_context.items()
        }
        for future in concurrent.futures.as_completed(
            [*variant_futures, *probe_futures]
        ):
            if future in variant_futures:
                key = variant_futures[future]
                variant_results[key] = future.result()
            else:
                name = probe_futures[future]
                probe_results[name] = validate_destination_probe(
                    future.result(),
                    f"{name} destination probe",
                )

    variants_by_formula: dict[str, list[dict[str, Any]]] = {}
    for key, result in variant_results.items():
        variants_by_formula.setdefault(key[0], []).append(result)
    for name in sorted(formula_context):
        context = formula_context[name]
        destination = dict(context["destination"])
        variants = entrant_variants.get(name, variants_by_formula.get(name, []))
        destination["admission"] = destination_admission(
            probe_results[name],
            formula_name=name,
            source_kind=context["source_kind"],
            variants=variants,
        )
        record = {**context, "destination": destination}
        record["variants"] = sorted(variants, key=lambda value: value["arch"])
        formula_records.append(record)

    retirements = [
        *retired_sidecars(
            link_files,
            tap_root=old_tap_root,
            active=active_links,
            kind="link-manifest",
        ),
        *retired_sidecars(
            provenance_files,
            tap_root=old_tap_root,
            active=active_provenance,
            kind="provenance-report",
        ),
    ]
    retirements.sort(key=lambda value: value["path"])
    all_variants = [
        variant for formula in formula_records for variant in formula["variants"]
    ]
    old_variants = [variant for variant in all_variants if "old_record" in variant]
    reuse = sum(
        variant["disposition"]["kind"] == "byte-clean-reuse-candidate"
        for variant in old_variants
    )
    required = sum(
        variant["disposition"]["kind"] in ("required-rebuild", "required-build")
        for variant in all_variants
    )
    return {
        "authority": {
            "abi_snapshot": {
                "path": ABI_SNAPSHOT_PATH,
                "sha256": abi_snapshot_sha256,
            },
            "campaign_inputs": {
                "path": INPUTS_PATH,
                "sha256": sha256_bytes(inputs_bytes),
            },
            "current_kandelo_abi": current_abi,
            "guest_layout": {
                "path": LAYOUT_PATH,
                "sha256": layout_sha256,
            },
            "kandelo_commit": options.kandelo_commit,
            "native_homebrew_commit": options.native_brew_commit,
            "old_metadata": {
                "path": METADATA_PATH,
                "sha256": metadata_sha256,
            },
            "old_catalog_commit": old_catalog_commit,
            "old_tap_commit": options.old_tap_commit,
            "source_materialization": (
                options.source_materialization
                if options.source_materialization is not None
                else {"kind": "unrecorded-snapshot"}
            ),
            "source_tap_commit": options.source_tap_commit,
            "tap_name": tap_name,
            "tap_repository": tap_repository,
            "tools": {
                path: sha256_file(regular_file(kandelo_root / path, path))
                for path in (
                    CAMPAIGN_TOOL_PATH,
                    FORMULA_DIGEST_PATH,
                    INSPECTOR_PATH,
                    OCI_TOOL_PATH,
                    PUBLICATION_LIMITS_PATH,
                    READBACK_PATH,
                    READBACK_FETCH_PATH,
                    WASM_VALIDATOR_PATH,
                )
            },
        },
        "deferred_source_formulae": deferred_formulae,
        "candidate_retired_prefix_replacements": (
            candidate_retired_prefix_replacements
        ),
        "formulae": formula_records,
        "kind": "kandelo-homebrew-guest-prefix-campaign",
        "retirements": retirements,
        "permitted_retired_prefix_evidence": permitted_retired_prefix_evidence,
        "schema": 2,
        "summary": {
            "byte_clean_reuse_candidates": reuse,
            "deferred_source_formulae": len(deferred_formulae),
            "formulae": len(formula_records),
            "candidate_retired_prefix_replacements": len(
                candidate_retired_prefix_replacements
            ),
            "metadata_selected_variants": sum(
                variant["selected_by"] == "metadata-selected"
                for variant in old_variants
            ),
            "required_builds": required,
            "retired_sidecars": len(retirements),
            "sidecar_extra_variants": sum(
                variant["selected_by"] == "formula-sidecar-extra"
                for variant in old_variants
            ),
            "variants": len(all_variants),
        },
    }


def derive_campaign(
    options: CampaignOptions,
    dependencies: CampaignDependencies = CampaignDependencies(),
) -> dict[str, Any]:
    authorities = (
        (
            options.kandelo_root,
            options.kandelo_commit,
            "Kandelo input",
        ),
        (
            options.old_tap_root,
            options.old_tap_commit,
            "old selected tap input",
        ),
        (
            options.source_tap_root,
            options.source_tap_commit,
            "candidate source tap input",
        ),
        (
            options.native_brew_root,
            options.native_brew_commit,
            "native Homebrew input",
        ),
    )
    exact_roots = tuple(
        git_authority(root, commit, label)
        for root, commit, label in authorities
    )
    metadata_history = historical_metadata_history(
        exact_roots[1], options.old_tap_commit
    )
    metadata_hashes = {digest for _revision, digest in metadata_history}
    selected_catalog_commits = [
        revision
        for revision, digest in metadata_history
        if digest == options.metadata_sha256
    ]
    if not selected_catalog_commits:
        fail(
            "exact old metadata SHA-256 is not reachable from the old tap "
            "history"
        )
    # WHY: source and Formula files can advance without regenerating the
    # catalog. The newest commit that wrote these exact metadata bytes is the
    # immutable tree containing the bottle blocks selected by that catalog.
    old_catalog_commit = selected_catalog_commits[0]
    if dependencies.load_historical_formula is None:
        def load_historical_formula(
            _snapshot_root: pathlib.Path,
            name: str,
            commit: str,
            formula_path: str,
        ) -> bytes:
            return git_blob(
                exact_roots[1],
                commit,
                formula_path,
                f"{name} historical Formula at {commit}",
            )

        dependencies = dataclasses.replace(
            dependencies,
            load_historical_formula=load_historical_formula,
        )

    def rebind() -> None:
        for (_, commit, label), root in zip(authorities, exact_roots, strict=True):
            git_authority(root, commit, f"{label} final rebind")

    try:
        # Homebrew refuses to run from an operating-system temporary prefix.
        # A private directory directly under the invoking user's home keeps
        # native metadata evaluation valid while remaining ephemeral.
        with tempfile.TemporaryDirectory(
            prefix=".kandelo-prefix-campaign-", dir=pathlib.Path.home()
        ) as temporary_name:
            temporary = pathlib.Path(temporary_name)
            kandelo_snapshot = git_snapshot(
                exact_roots[0],
                options.kandelo_commit,
                temporary / "input-0",
                "Kandelo input",
            )
            old_tap_snapshot = git_snapshot(
                exact_roots[1],
                options.old_tap_commit,
                temporary / "input-1",
                "old selected tap input",
            )
            source_snapshot, source_materialization = (
                candidate_source_snapshot(
                    exact_roots[2],
                    options.source_tap_commit,
                    temporary / "input-2",
                )
            )
            native_brew_snapshot = git_snapshot(
                exact_roots[3],
                options.native_brew_commit,
                temporary / "input-3",
                "native Homebrew input",
            )
            historical_formula_root = temporary / "historical-formula"
            historical_formula_root.mkdir(mode=0o700)
            snapshot_options = dataclasses.replace(
                options,
                kandelo_root=kandelo_snapshot,
                old_tap_root=old_tap_snapshot,
                source_tap_root=source_snapshot,
                native_brew_root=native_brew_snapshot,
                old_catalog_commit=old_catalog_commit,
                source_materialization=source_materialization,
            )
            result = _derive_campaign_from_snapshots(
                snapshot_options,
                dependencies,
                metadata_hashes,
                historical_formula_root,
            )
    except BaseException as primary:
        try:
            rebind()
        except (CampaignError, OSError, UnicodeError) as final_error:
            raise CampaignError(
                f"campaign failed ({primary}); exact-source final rebind "
                f"also failed ({final_error})"
            ) from primary
        raise
    rebind()
    return result


def check_final_prefix_candidate(
    *,
    kandelo_root: pathlib.Path,
    kandelo_commit: str,
    source_tap_root: pathlib.Path,
    source_tap_commit: str,
    guest_layout_sha256: str,
) -> list[dict[str, Any]]:
    authorities = (
        (kandelo_root, kandelo_commit, "Kandelo input"),
        (source_tap_root, source_tap_commit, "final candidate tap input"),
    )
    exact_roots = tuple(
        git_authority(root, commit, label)
        for root, commit, label in authorities
    )

    def rebind() -> None:
        for (_, commit, label), root in zip(authorities, exact_roots, strict=True):
            git_authority(root, commit, f"{label} final rebind")

    try:
        with tempfile.TemporaryDirectory(
            prefix=".kandelo-final-prefix-check-", dir=pathlib.Path.home()
        ) as temporary_name:
            temporary = pathlib.Path(temporary_name)
            snapshots = tuple(
                git_snapshot(
                    root,
                    commit,
                    temporary / f"input-{index}",
                    label,
                )
                for index, ((_, commit, label), root) in enumerate(
                    zip(authorities, exact_roots, strict=True)
                )
            )
            layout, payload = load_json_with_bytes(
                snapshots[0] / LAYOUT_PATH, "guest layout"
            )
            expected = require_sha256(
                guest_layout_sha256, "expected guest layout SHA-256"
            )
            if sha256_bytes(payload) != expected:
                fail("guest layout SHA-256 differs from final-prefix authority")
            layout = validate_layout(layout)
            permitted = validate_final_candidate_prefixes(
                snapshots[1], layout["retired_prefixes"]
            )
    except BaseException as primary:
        try:
            rebind()
        except (CampaignError, OSError, UnicodeError) as final_error:
            raise CampaignError(
                f"final-prefix check failed ({primary}); exact-source final "
                f"rebind also failed ({final_error})"
            ) from primary
        raise
    rebind()
    return permitted


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("derive", "check"):
        command = commands.add_parser(name)
        command.add_argument("--kandelo-root", required=True)
        command.add_argument("--kandelo-commit", required=True)
        command.add_argument("--old-tap-root", required=True)
        command.add_argument("--old-tap-commit", required=True)
        command.add_argument("--source-tap-root", required=True)
        command.add_argument("--source-tap-commit", required=True)
        command.add_argument("--native-brew-root", required=True)
        command.add_argument("--native-brew-commit", required=True)
        command.add_argument("--metadata-sha256", required=True)
        command.add_argument("--guest-layout-sha256", required=True)
        command.add_argument("--jobs", type=int, default=MAX_JOBS)
        if name == "derive":
            command.add_argument("--out", required=True)
        else:
            command.add_argument("--manifest", required=True)
    final = commands.add_parser("check-final-prefix")
    final.add_argument("--kandelo-root", required=True)
    final.add_argument("--kandelo-commit", required=True)
    final.add_argument("--source-tap-root", required=True)
    final.add_argument("--source-tap-commit", required=True)
    final.add_argument("--guest-layout-sha256", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.command == "check-final-prefix":
            permitted = check_final_prefix_candidate(
                kandelo_root=pathlib.Path(args.kandelo_root),
                kandelo_commit=args.kandelo_commit,
                source_tap_root=pathlib.Path(args.source_tap_root),
                source_tap_commit=args.source_tap_commit,
                guest_layout_sha256=args.guest_layout_sha256,
            )
            print(
                "Verified final tap has no active retired guest-prefix "
                f"occurrences ({len(permitted)} permitted evidence files)"
            )
            return 0
        options = CampaignOptions(
            kandelo_root=pathlib.Path(args.kandelo_root),
            kandelo_commit=args.kandelo_commit,
            old_tap_root=pathlib.Path(args.old_tap_root),
            old_tap_commit=args.old_tap_commit,
            source_tap_root=pathlib.Path(args.source_tap_root),
            source_tap_commit=args.source_tap_commit,
            native_brew_root=pathlib.Path(args.native_brew_root),
            native_brew_commit=args.native_brew_commit,
            metadata_sha256=args.metadata_sha256,
            guest_layout_sha256=args.guest_layout_sha256,
            jobs=args.jobs,
        )
        kandelo_root = real_directory(options.kandelo_root, "Kandelo input")
        old_tap_root = real_directory(options.old_tap_root, "old selected tap input")
        source_tap_root = real_directory(
            options.source_tap_root, "candidate source tap input"
        )
        native_brew_root = real_directory(
            options.native_brew_root, "native Homebrew input"
        )
        if args.command == "derive":
            output = validate_external_output(
                pathlib.Path(args.out),
                kandelo_root,
                old_tap_root,
                source_tap_root,
                native_brew_root,
            )
            document = derive_campaign(options)
            write_new_file(output, pretty_json(document))
            print(f"Wrote deterministic guest-prefix campaign manifest: {output}")
        else:
            manifest_path = regular_file(
                pathlib.Path(args.manifest), "campaign manifest"
            )
            if any(
                path_is_within(manifest_path.resolve(), root)
                for root in (
                    kandelo_root,
                    old_tap_root,
                    source_tap_root,
                    native_brew_root,
                )
            ):
                fail("campaign manifest must be outside all clean input worktrees")
            recorded, payload = load_json_with_bytes(
                manifest_path, "campaign manifest"
            )
            if payload != pretty_json(recorded):
                fail("campaign manifest is not canonical deterministic JSON")
            derived = derive_campaign(options)
            if recorded != derived:
                fail(
                    "campaign manifest differs from fresh exact-source, public-readback, "
                    "inspection, or destination-admission derivation"
                )
            print("Verified exact guest-prefix campaign manifest")
    except (CampaignError, OSError, UnicodeError) as error:
        print(f"homebrew-prefix-campaign.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
