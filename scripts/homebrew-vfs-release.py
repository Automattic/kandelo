#!/usr/bin/env python3
"""Prepare and validate an inert, browser-proven Homebrew VFS release bundle."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import zipfile
import zlib
from typing import Any
from urllib.parse import urlsplit


MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_VFS_BYTES = 2 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
FORMULA_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
RUNTIME_LAYER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAP_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
GUEST_PATH_RE = re.compile(
    r"^/(?:[A-Za-z0-9._@%+=:-]+/)*[A-Za-z0-9._@%+=:-]+$"
)
HOMEBREW_COMMAND_RE = re.compile(
    r"^/home/linuxbrew/\.linuxbrew/(?:bin|sbin)/[A-Za-z0-9._@%+=:-]+$"
)

IMAGE_ASSET = "kandelo-homebrew.vfs.zst"
REPORT_ASSET = "kandelo-homebrew-vfs-report.json"
NODE_ASSET = "kandelo-homebrew-node-evidence.json"
BROWSER_ASSET = "kandelo-homebrew-browser-evidence.json"
DESCRIPTOR_ASSET = "kandelo-homebrew-vfs.json"
MAX_LAZY_LAYER_ENTRIES = 100_000
MAX_LAZY_LAYER_PATH_BYTES = 4096
MAX_LAZY_LAYER_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_LAZY_LAYER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew"
TAR_BLOCK_BYTES = 512
TAR_MAX_SAFE_INTEGER = (1 << 53) - 1
TAR_ZERO_BLOCK = bytes(TAR_BLOCK_BYTES)
S_IFMT = 0o170000
S_IFREG = 0o100000
S_IFDIR = 0o040000
S_IFLNK = 0o120000


class ValidationError(Exception):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def resolve_lazy_layer_hardlinks(
    entries: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Resolve the closed hardlink graph once, with path compression."""
    by_path = {entry["path"]: entry for entry in entries}
    canonical_groups: dict[str, dict[str, Any]] = {}
    for entry in entries:
        if entry["type"] != "file":
            continue
        inode_group = entry["inode_group"]
        if inode_group in canonical_groups:
            fail("Homebrew deferred tree has duplicate canonical inode groups")
        canonical_groups[inode_group] = entry

    visiting: set[str] = set()
    resolved: dict[str, dict[str, Any]] = {}
    for start in entries:
        if start["type"] != "hardlink" or start["path"] in resolved:
            continue
        chain: list[dict[str, Any]] = []
        cursor = start
        canonical: dict[str, Any] | None = None
        while cursor["type"] == "hardlink":
            path = cursor["path"]
            if path in resolved:
                canonical = resolved[path]
                break
            if path in visiting:
                fail(f"Homebrew deferred tree hardlink cycle reaches {path}")
            visiting.add(path)
            chain.append(cursor)
            target = by_path.get(cursor["target"])
            if target is None:
                fail(
                    f"Homebrew deferred tree hardlink {path} target "
                    f"{cursor['target']} is missing"
                )
            if (
                target["type"] not in ("file", "hardlink")
                or target.get("inode_group") != cursor["inode_group"]
                or target.get("size") != cursor["size"]
                or target.get("mode") != cursor["mode"]
            ):
                fail(f"Homebrew deferred tree hardlink {path} has an invalid target")
            cursor = target

        if canonical is None and cursor["type"] == "file":
            canonical = cursor
        expected = canonical_groups.get(start["inode_group"])
        if canonical is None or canonical is not expected:
            fail(
                f"Homebrew deferred tree hardlink {start['path']} "
                "resolves to a different inode group"
            )
        for link in reversed(chain):
            if canonical_groups.get(link["inode_group"]) is not canonical:
                fail(
                    f"Homebrew deferred tree hardlink {link['path']} "
                    "resolves to a different inode group"
                )
            visiting.remove(link["path"])
            resolved[link["path"]] = canonical
    return canonical_groups


def lazy_layer_asset_names(runtime_id: str) -> tuple[str, str]:
    if not RUNTIME_LAYER_ID_RE.fullmatch(runtime_id):
        fail("Homebrew lazy layer runtime id is invalid")
    prefix = f"kandelo-homebrew-{runtime_id}-layer"
    return f"{prefix}.bin", f"{prefix}.json"


def expected_assets(runtime_id: str) -> set[str]:
    archive, descriptor = lazy_layer_asset_names(runtime_id)
    return {
        IMAGE_ASSET,
        REPORT_ASSET,
        NODE_ASSET,
        BROWSER_ASSET,
        DESCRIPTOR_ASSET,
        archive,
        descriptor,
    }


def regular_file(path: Path, label: str, max_bytes: int) -> os.stat_result:
    try:
        value = path.lstat()
    except OSError as error:
        fail(f"{label} cannot be inspected: {error}")
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
        fail(f"{label} must be a regular non-symlink file")
    if value.st_size <= 0 or value.st_size > max_bytes:
        fail(f"{label} must contain 1 to {max_bytes} bytes")
    return value


def read_bytes(path: Path, label: str, max_bytes: int) -> bytes:
    expected = regular_file(path, label, max_bytes).st_size
    try:
        value = path.read_bytes()
    except OSError as error:
        fail(f"{label} cannot be read: {error}")
    if len(value) != expected:
        fail(f"{label} changed while it was read")
    return value


def read_json(path: Path, label: str) -> tuple[Any, bytes]:
    value = read_bytes(path, label, MAX_JSON_BYTES)
    try:
        text = value.decode("utf-8")
        parsed = json.loads(text, object_pairs_hook=reject_duplicate_json_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid UTF-8 JSON: {error}")
    return parsed, value


def reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON object contains duplicate key {key!r}")
        result[key] = value
    return result


def record(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        fail(f"{label} must be a JSON array")
    return value


def string(value: Any, label: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum:
        fail(f"{label} must be a non-empty string no larger than {maximum} bytes")
    if "\0" in value:
        fail(f"{label} must not contain NUL")
    return value


def integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} must be an integer greater than or equal to {minimum}")
    return value


def exact(value: Any, expected: Any, label: str) -> None:
    if value != expected:
        fail(f"{label} is {value!r}, expected {expected!r}")


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_file(path: Path, label: str, max_bytes: int) -> tuple[str, int]:
    value = read_bytes(path, label, max_bytes)
    return digest_bytes(value), len(value)


def sha(value: Any, label: str) -> str:
    result = string(value, label, maximum=64)
    if not SHA256_RE.fullmatch(result):
        fail(f"{label} must be a lowercase SHA-256 digest")
    return result


def commit(value: str, label: str) -> str:
    if not COMMIT_RE.fullmatch(value):
        fail(f"{label} must be an exact lowercase 40-character commit SHA")
    return value


def git(tap_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(tap_root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"cannot inspect exact tap checkout: {result.stderr.strip()}")
    return result.stdout.rstrip("\n")


def tap_file(tap_root: Path, relative: Any, label: str, max_bytes: int) -> Path:
    value = string(relative, f"{label} path", maximum=255)
    if value.startswith("/") or "\\" in value:
        fail(f"{label} path must be relative to the tap")
    components = value.split("/")
    if any(component in ("", ".", "..") for component in components):
        fail(f"{label} path contains an unsafe component")
    candidate = tap_root.joinpath(*components)
    regular_file(candidate, label, max_bytes)
    try:
        candidate.resolve(strict=True).relative_to(tap_root.resolve(strict=True))
    except (OSError, ValueError):
        fail(f"{label} resolves outside the exact tap checkout")
    return candidate


def parse_brewfile(path: Path, tap_name: str) -> dict[str, Any]:
    parser = Path(__file__).with_name("homebrew-brewfile-selection.rb")
    result = subprocess.run(
        ["ruby", str(parser), str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        fail(f"static Brewfile parser rejected the reviewed file: {result.stderr.strip()}")
    try:
        parsed = record(
            json.loads(result.stdout, object_pairs_hook=reject_duplicate_json_keys),
            "static Brewfile selection",
        )
    except json.JSONDecodeError as error:
        fail(f"static Brewfile parser returned invalid JSON: {error}")
    exact(parsed.get("schema"), 1, "static Brewfile selection schema")
    exact(parsed.get("kind"), "kandelo-static-brewfile-v1", "static Brewfile selection kind")
    exact(parsed.get("tap_name"), tap_name.lower(), "static Brewfile tap name")
    packages = array(parsed.get("packages"), "static Brewfile packages")
    if not packages or any(
        not isinstance(package, str) or not FORMULA_RE.fullmatch(package)
        for package in packages
    ):
        fail("static Brewfile packages are invalid")
    brewfile_sha = sha(parsed.get("sha256"), "static Brewfile digest")
    brewfile_bytes = integer(parsed.get("bytes"), "static Brewfile size", minimum=1)
    actual_sha, actual_bytes = digest_file(path, "reviewed acceptance Brewfile", 64 * 1024)
    exact(brewfile_sha, actual_sha, "static Brewfile digest")
    exact(brewfile_bytes, actual_bytes, "static Brewfile size")
    return {"packages": packages, "sha256": brewfile_sha, "bytes": brewfile_bytes}


def validate_tap(
    tap_root: Path,
    tap_repository: str,
    tap_name: str,
    tap_commit: str,
    formula: str,
) -> dict[str, Any]:
    if not tap_root.is_dir() or tap_root.is_symlink():
        fail("tap root must be a real directory")
    if not REPOSITORY_RE.fullmatch(tap_repository):
        fail("tap repository must be owner/repository")
    if not TAP_NAME_RE.fullmatch(tap_name):
        fail("tap name must be owner/name")
    commit(tap_commit, "tap commit")
    if not FORMULA_RE.fullmatch(formula):
        fail("formula has an invalid package name")
    exact(git(tap_root, "rev-parse", "HEAD"), tap_commit, "tap checkout HEAD")
    if git(tap_root, "status", "--short", "--untracked-files=all"):
        fail("exact tap checkout is not clean")

    if (tap_root / "Formula").is_symlink() or not (tap_root / "Formula").is_dir():
        fail("tap Formula path must be a real directory")
    if (tap_root / "Kandelo").is_symlink() or not (tap_root / "Kandelo").is_dir():
        fail("tap Kandelo policy path must be a real directory")
    regular_file(tap_root / "Formula" / f"{formula}.rb", "selected tap Formula", 1024 * 1024)
    config_value, _ = read_json(
        tap_root / "Kandelo" / "vfs-acceptance.json", "tap VFS acceptance config"
    )
    config = record(config_value, "tap VFS acceptance config")
    if config.get("schema") not in (1, 2):
        fail("tap VFS acceptance config has an unsupported schema")
    expected_config_keys = {
        "schema", "formula", "brewfile", "executable", "argv", "expected_stdout"
    }
    if config["schema"] == 2:
        expected_config_keys.add("shell_config")
    if set(config) != expected_config_keys:
        fail("tap VFS acceptance config has unexpected fields")
    exact(config.get("formula"), formula, "tap VFS acceptance formula")
    executable = string(config.get("executable"), "tap VFS acceptance executable")
    if not GUEST_PATH_RE.fullmatch(executable):
        fail("tap VFS acceptance executable is not an absolute guest path")
    argv = array(config.get("argv"), "tap VFS acceptance argv")
    if not argv or len(argv) > 64:
        fail("tap VFS acceptance argv must contain 1 to 64 entries")
    argv = [string(entry, "tap VFS acceptance argv entry") for entry in argv]
    expected_stdout = string(
        config.get("expected_stdout"), "tap VFS acceptance expected stdout"
    )
    if "\n" in expected_stdout or "\r" in expected_stdout:
        fail("tap VFS acceptance expected stdout must be one line")
    brewfile_path = tap_file(
        tap_root, config.get("brewfile"), "tap VFS acceptance Brewfile", 64 * 1024
    )
    brewfile = parse_brewfile(brewfile_path, tap_name)
    if formula not in brewfile["packages"]:
        fail("selected formula is not a root in the reviewed acceptance Brewfile")

    shell: dict[str, Any] | None = None
    if config["schema"] == 2:
        shell_path = tap_file(
            tap_root, config.get("shell_config"), "tap default-shell config", 64 * 1024
        )
        shell_value, shell_bytes = read_json(shell_path, "tap default-shell config")
        shell_config = record(shell_value, "tap default-shell config")
        if set(shell_config) != {"version", "path", "argv"}:
            fail("tap default-shell config has unexpected fields")
        exact(shell_config.get("version"), 1, "tap default-shell version")
        path = string(shell_config.get("path"), "tap default-shell path")
        if not HOMEBREW_COMMAND_RE.fullmatch(path):
            fail("tap default-shell path is not a canonical Homebrew command path")
        shell_argv = array(shell_config.get("argv"), "tap default-shell argv")
        if not shell_argv or len(shell_argv) > 64:
            fail("tap default-shell argv must contain 1 to 64 entries")
        shell_argv = [string(entry, "tap default-shell argv entry") for entry in shell_argv]
        shell = {
            "path": path,
            "argv": shell_argv,
            "config_sha256": digest_bytes(shell_bytes),
            "config_bytes": len(shell_bytes),
        }
    return {
        "schema": config["schema"],
        "executable": executable,
        "argv": argv,
        "expected_stdout": expected_stdout,
        "brewfile": brewfile,
        "default_shell": shell,
    }


def validate_evidence(
    *,
    image_path: Path,
    report_path: Path,
    node_path: Path,
    browser_path: Path,
    tap_root: Path,
    tap_repository: str,
    tap_name: str,
    tap_commit: str,
    formula: str,
    kandelo_commit: str,
    expected_abi: int,
    bottle_release_tag: str,
) -> dict[str, Any]:
    commit(kandelo_commit, "Kandelo commit")
    expected_abi = integer(expected_abi, "expected Kandelo ABI", minimum=1)
    expected_release_tag = f"bottles-abi-v{expected_abi}"
    exact(bottle_release_tag, expected_release_tag, "expected bottle release tag")
    config = validate_tap(tap_root, tap_repository, tap_name, tap_commit, formula)
    image_sha, image_bytes = digest_file(image_path, "VFS image", MAX_VFS_BYTES)
    report_value, report_bytes = read_json(report_path, "VFS report")
    node_value, node_bytes = read_json(node_path, "Node evidence")
    browser_value, browser_bytes = read_json(browser_path, "browser evidence")
    report = record(report_value, "VFS report")
    node = record(node_value, "Node evidence")
    browser = record(browser_value, "browser evidence")

    exact(report.get("schema"), 1, "VFS report schema")
    metadata = record(report.get("metadata"), "VFS report metadata")
    exact(metadata.get("tap_repository"), tap_repository, "VFS report tap repository")
    exact(metadata.get("tap_name"), tap_name, "VFS report tap name")
    exact(metadata.get("tap_commit"), tap_commit, "VFS report tap commit")
    exact(metadata.get("kandelo_repository"), "Automattic/kandelo", "VFS report Kandelo repository")
    exact(metadata.get("kandelo_commit"), kandelo_commit, "VFS report Kandelo commit")
    abi = integer(metadata.get("kandelo_abi"), "VFS report Kandelo ABI", minimum=1)
    release_tag = string(metadata.get("release_tag"), "VFS report bottle release tag", maximum=255)
    exact(abi, expected_abi, "VFS report Kandelo ABI")
    exact(release_tag, bottle_release_tag, "VFS report bottle release tag")

    selection = record(report.get("selection"), "VFS report selection")
    exact(selection.get("kind"), "brewfile", "VFS report selection kind")
    requested = array(selection.get("requested_packages"), "VFS report requested packages")
    exact(requested, config["brewfile"]["packages"], "VFS report requested packages")
    brewfile = record(selection.get("brewfile"), "VFS report Brewfile selection")
    exact(brewfile.get("parser"), "kandelo-static-brewfile-v1", "VFS report Brewfile parser")
    exact(brewfile.get("sha256"), config["brewfile"]["sha256"], "VFS report Brewfile digest")
    exact(brewfile.get("bytes"), config["brewfile"]["bytes"], "VFS report Brewfile size")

    exact(node.get("schema"), 1, "Node evidence schema")
    exact(node.get("status"), "success", "Node evidence status")
    node_selection = record(node.get("selection"), "Node evidence selection")
    exact(node_selection.get("parser"), "kandelo-static-brewfile-v1", "Node evidence parser")
    exact(node_selection.get("requested_packages"), requested, "Node evidence requested packages")
    exact(node_selection.get("sha256"), brewfile.get("sha256"), "Node evidence Brewfile digest")
    exact(node_selection.get("bytes"), brewfile.get("bytes"), "Node evidence Brewfile size")
    sha(node_selection.get("sha256"), "Node evidence Brewfile digest")
    integer(node_selection.get("bytes"), "Node evidence Brewfile size", minimum=1)

    node_image = record(node.get("image"), "Node evidence image")
    exact(node_image.get("sha256"), image_sha, "Node evidence image digest")
    exact(node_image.get("bytes"), image_bytes, "Node evidence image size")
    exact(node_image.get("kernel_abi"), abi, "Node evidence image ABI")

    edges = array(node.get("dependency_edges"), "Node evidence dependency edges")
    if not edges:
        fail("Node evidence must contain a real dependency edge")
    for index, raw_edge in enumerate(edges):
        edge = record(raw_edge, f"Node dependency edge {index}")
        if set(edge) != {"from", "to", "version"}:
            fail(f"Node dependency edge {index} has unexpected fields")
        string(edge.get("from"), f"Node dependency edge {index} source")
        string(edge.get("to"), f"Node dependency edge {index} target")
        string(edge.get("version"), f"Node dependency edge {index} version")

    bottle_values = array(node.get("homebrew_bottles"), "Node Homebrew bottles")
    report_values = array(report.get("packages"), "VFS report packages")
    if not bottle_values or len(bottle_values) != len(report_values):
        fail("Node bottle count does not match the VFS report")
    report_packages: dict[str, dict[str, Any]] = {}
    for index, raw_package in enumerate(report_values):
        package = record(raw_package, f"VFS report package {index}")
        full_name = string(package.get("full_name"), f"VFS report package {index} full name")
        if full_name in report_packages:
            fail(f"duplicate VFS report package {full_name}")
        report_packages[full_name] = package
    root_full_name = f"{tap_name.lower()}/{formula}"
    root_seen = False
    for index, raw_bottle in enumerate(bottle_values):
        bottle = record(raw_bottle, f"Node bottle {index}")
        bottle_name = string(bottle.get("name"), f"Node bottle {index} name")
        if not FORMULA_RE.fullmatch(bottle_name):
            fail(f"Node bottle {index} has an invalid package name")
        full_name = string(bottle.get("full_name"), f"Node bottle {index} full name")
        package = report_packages.get(full_name)
        if package is None:
            fail(f"Node bottle {full_name} is absent from the VFS report")
        for node_key, report_key in (
            ("name", "name"), ("full_name", "full_name"),
            ("tap_repository", "tap_repository"), ("tap_commit", "tap_commit"),
            ("version", "version"), ("sha256", "sha256"), ("bytes", "bytes"),
            ("cache_key_sha", "cache_key_sha"), ("url", "url"),
        ):
            exact(bottle.get(node_key), package.get(report_key), f"bottle {full_name} {node_key}")
        exact(package.get("arch"), "wasm32", f"VFS report package {full_name} arch")
        exact(package.get("source_status"), "success", f"VFS report package {full_name} source status")
        exact(package.get("metadata_status"), "success", f"VFS report package {full_name} metadata status")
        bottle_sha = sha(bottle.get("sha256"), f"Node bottle {full_name} digest")
        sha(bottle.get("cache_key_sha"), f"Node bottle {full_name} cache key")
        integer(bottle.get("bytes"), f"Node bottle {full_name} size", minimum=1)
        repository = string(bottle.get("tap_repository"), f"Node bottle {full_name} repository")
        if not REPOSITORY_RE.fullmatch(repository):
            fail(f"Node bottle {full_name} repository is not owner/repository")
        commit(string(bottle.get("tap_commit"), f"Node bottle {full_name} tap commit"),
               f"Node bottle {full_name} tap commit")
        expected_url = f"https://ghcr.io/v2/{repository.lower()}/{bottle_name}/blobs/sha256:{bottle_sha}"
        exact(bottle.get("url"), expected_url, f"Node bottle {full_name} URL")
        if full_name.lower() == root_full_name:
            root_seen = True
            exact(repository, tap_repository, "selected formula tap repository")
            exact(bottle.get("tap_commit"), tap_commit, "selected formula tap commit")
    if not root_seen:
        fail("selected Formula bottle is absent from Node evidence")

    browser_plan = record(node.get("browser_plan"), "Node browser plan")
    exact(
        browser_plan.get("compatibility_basis"),
        "pending-exact-image-runtime-test",
        "Node browser plan basis",
    )
    exact(
        browser_plan.get("packages"),
        [record(value, f"Node bottle {index}").get("full_name")
         for index, value in enumerate(bottle_values)],
        "Node browser plan packages",
    )
    package_versions = {
        full_name: string(package.get("version"), f"VFS report package {full_name} version")
        for full_name, package in report_packages.items()
    }
    root_has_edge = False
    for index, raw_edge in enumerate(edges):
        edge = record(raw_edge, f"Node dependency edge {index}")
        source = edge["from"]
        target = edge["to"]
        if source not in report_packages or target not in report_packages:
            fail(f"Node dependency edge {index} names a package outside the selected closure")
        exact(edge["version"], package_versions[target], f"Node dependency edge {index} version")
        root_has_edge = root_has_edge or source.lower() == root_full_name
    if not root_has_edge:
        fail("selected Formula has no recorded dependency edge")

    node_runtime = record(node.get("node"), "Node runtime evidence")
    exact(node_runtime.get("executable"), config["executable"], "Node executable")
    exact(node_runtime.get("argv"), config["argv"], "Node argv")
    exact(node_runtime.get("exit_code"), 0, "Node exit code")
    stdout = string(node_runtime.get("stdout"), "Node stdout", maximum=1024 * 1024)
    if config["expected_stdout"] not in stdout:
        fail("Node stdout no longer contains the reviewed expected text")
    exact(
        node_runtime.get("stdout_sha256"),
        digest_bytes(stdout.encode("utf-8")),
        "Node stdout digest",
    )
    sha(node_runtime.get("stderr_sha256"), "Node stderr digest")

    platform_values = array(node.get("platform_inputs"), "Node platform inputs")
    platform: dict[str, dict[str, Any]] = {}
    for index, raw_input in enumerate(platform_values):
        item = record(raw_input, f"Node platform input {index}")
        role = item.get("role")
        if role not in ("base-vfs", "kernel") or role in platform:
            fail("Node platform inputs must contain unique base-vfs and kernel records")
        sha(item.get("sha256"), f"Node platform input {role} digest")
        integer(item.get("bytes"), f"Node platform input {role} size", minimum=1)
        exact(item.get("kernel_abi"), abi, f"Node platform input {role} ABI")
        platform[role] = item
    if set(platform) != {"base-vfs", "kernel"}:
        fail("Node platform inputs must contain base-vfs and kernel")
    base_report = record(report.get("base_image"), "VFS report base image")
    exact(base_report.get("sha256"), platform["base-vfs"].get("sha256"), "base image digest")
    exact(base_report.get("bytes"), platform["base-vfs"].get("bytes"), "base image size")
    exact(base_report.get("kernelAbi"), abi, "base image ABI")

    exact(browser.get("schema"), 1, "browser evidence schema")
    exact(browser.get("status"), "success", "browser evidence status")
    exact(browser.get("runtime"), "browser", "browser evidence runtime")
    exact(browser.get("engine"), "chromium", "browser evidence engine")
    exact(browser.get("image_sha256"), image_sha, "browser image digest")
    exact(browser.get("kernel_sha256"), platform["kernel"].get("sha256"), "browser kernel digest")
    exact(browser.get("executable"), config["executable"], "browser executable")
    exact(browser.get("argv"), config["argv"], "browser argv")

    default_shell: dict[str, Any] | None = None
    evidence_has_shell = (
        "default_shell" in node or "default_shell" in report or "default_shell" in browser
    )
    if config["default_shell"] is None and evidence_has_shell:
        fail("release evidence unexpectedly declares a default shell")
    if config["default_shell"] is not None and not all(
        "default_shell" in value for value in (node, report, browser)
    ):
        fail("release evidence omits the reviewed default shell")
    if config["default_shell"] is not None:
        node_shell = record(node.get("default_shell"), "Node default shell evidence")
        report_shell = record(report.get("default_shell"), "VFS report default shell")
        browser_shell = record(browser.get("default_shell"), "browser default shell evidence")
        exact(node_shell.get("path"), report_shell.get("path"), "default shell path")
        exact(node_shell.get("argv"), report_shell.get("argv"), "default shell argv")
        exact(browser_shell.get("path"), report_shell.get("path"), "browser default shell path")
        exact(browser_shell.get("argv"), report_shell.get("argv"), "browser default shell argv")
        exact(node_shell.get("config_sha256"), report_shell.get("config_sha256"), "default shell config digest")
        exact(node_shell.get("config_bytes"), report_shell.get("config_bytes"), "default shell config size")
        exact(report_shell.get("path"), config["default_shell"]["path"], "reviewed default shell path")
        exact(report_shell.get("argv"), config["default_shell"]["argv"], "reviewed default shell argv")
        exact(report_shell.get("config_sha256"), config["default_shell"]["config_sha256"], "reviewed default shell digest")
        exact(report_shell.get("config_bytes"), config["default_shell"]["config_bytes"], "reviewed default shell size")
        exact(browser_shell.get("interactive"), True, "browser default shell interactive status")
        exact(browser_shell.get("legacy_shell_downloads"), 0, "browser legacy shell downloads")
        shell_owner = string(node_shell.get("bottle_package"), "default shell bottle owner")
        if shell_owner not in {
            string(package.get("name"), f"VFS report package {full_name} name")
            for full_name, package in report_packages.items()
        }:
            fail("default shell bottle owner is absent from the selected closure")
        path = string(report_shell.get("path"), "default shell path")
        if not GUEST_PATH_RE.fullmatch(path):
            fail("default shell path is not an absolute guest path")
        argv = array(report_shell.get("argv"), "default shell argv")
        if not argv or any(not isinstance(item, str) or not item for item in argv):
            fail("default shell argv is invalid")
        default_shell = {"path": path, "argv": argv}

    return {
        "abi": abi,
        "release_tag": release_tag,
        "image_sha": image_sha,
        "image_bytes": image_bytes,
        "report_bytes": report_bytes,
        "node_bytes": node_bytes,
        "browser_bytes": browser_bytes,
        "requested": requested,
        "dependency_edges": edges,
        "executable": config["executable"],
        "argv": config["argv"],
        "default_shell": default_shell,
        "report_packages": report_values,
    }


def https_url(value: Any, label: str) -> str:
    result = string(value, label, maximum=8192)
    parsed = urlsplit(result)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        fail(f"{label} must be an unauthenticated HTTPS URL without a fragment")
    return result


def safe_relative_path(value: Any, label: str) -> str:
    result = string(value, label, maximum=4096)
    if result.startswith("/") or "\\" in result:
        fail(f"{label} must be a safe relative path")
    if any(component in ("", ".", "..") for component in result.split("/")):
        fail(f"{label} must be a safe relative path")
    return result


def validate_lazy_package_record(value: Any, label: str) -> dict[str, Any]:
    package = record(value, label)
    required = {
        "name", "full_name", "tap_repository", "tap_name", "tap_commit",
        "version", "formula_revision", "bottle_rebuild", "arch",
        "source_status", "metadata_status", "url", "sha256", "bytes",
        "cache_key_sha", "link_manifest", "prefix", "keg", "opt_link",
    }
    optional = {"built_from"}
    if not required.issubset(package) or set(package) - required - optional:
        fail(f"{label} has unexpected or missing fields")
    name = string(package.get("name"), f"{label} name")
    if not FORMULA_RE.fullmatch(name):
        fail(f"{label} name is invalid")
    full_name = string(package.get("full_name"), f"{label} full name")
    tap_repository = string(
        package.get("tap_repository"), f"{label} tap repository"
    )
    tap_name = string(package.get("tap_name"), f"{label} tap name")
    if not REPOSITORY_RE.fullmatch(tap_repository):
        fail(f"{label} tap repository is invalid")
    if not TAP_NAME_RE.fullmatch(tap_name):
        fail(f"{label} tap name is invalid")
    exact(full_name, f"{tap_name}/{name}", f"{label} full name")
    tap_commit = string(package.get("tap_commit"), f"{label} tap commit")
    commit(tap_commit, f"{label} tap commit")
    exact(package.get("arch"), "wasm32", f"{label} architecture")
    if package.get("source_status") not in ("success", "fallback"):
        fail(f"{label} source status is invalid")
    integer(package.get("formula_revision"), f"{label} Formula revision")
    integer(package.get("bottle_rebuild"), f"{label} bottle rebuild")
    integer(package.get("bytes"), f"{label} byte count", minimum=1)
    sha(package.get("sha256"), f"{label} digest")
    sha(package.get("cache_key_sha"), f"{label} cache key")
    https_url(package.get("url"), f"{label} URL")
    safe_relative_path(package.get("link_manifest"), f"{label} link manifest")
    string(package.get("version"), f"{label} version")
    string(package.get("metadata_status"), f"{label} metadata status")
    prefix = string(package.get("prefix"), f"{label} prefix")
    exact(prefix, HOMEBREW_PREFIX, f"{label} prefix")
    keg = string(package.get("keg"), f"{label} keg")
    keg_root = f"{prefix}/Cellar/{name}/"
    if (
        not GUEST_PATH_RE.fullmatch(keg)
        or not keg.startswith(keg_root)
        or "/" in keg[len(keg_root):]
    ):
        fail(f"{label} keg is outside its package Cellar path")
    opt_link = record(package.get("opt_link"), f"{label} opt link")
    if set(opt_link) != {"path", "target"}:
        fail(f"{label} opt link has unexpected fields")
    exact(opt_link.get("path"), f"opt/{name}", f"{label} opt link path")
    exact(
        opt_link.get("target"),
        f"../{keg[len(prefix) + 1:]}",
        f"{label} opt link target",
    )
    if "built_from" in package:
        built_from = record(package["built_from"], f"{label} built_from")
        if set(built_from) != {
            "tap_repository", "tap_commit", "kandelo_repository",
            "kandelo_commit", "formula_sha256",
        }:
            fail(f"{label} built_from has unexpected fields")
        if not REPOSITORY_RE.fullmatch(
            string(built_from.get("tap_repository"), f"{label} built_from tap repository")
        ):
            fail(f"{label} built_from tap repository is invalid")
        commit(
            string(built_from.get("tap_commit"), f"{label} built_from tap commit"),
            f"{label} built_from tap commit",
        )
        if not REPOSITORY_RE.fullmatch(
            string(
                built_from.get("kandelo_repository"),
                f"{label} built_from Kandelo repository",
            )
        ):
            fail(f"{label} built_from Kandelo repository is invalid")
        commit(
            string(
                built_from.get("kandelo_commit"),
                f"{label} built_from Kandelo commit",
            ),
            f"{label} built_from Kandelo commit",
        )
        sha(built_from.get("formula_sha256"), f"{label} built_from Formula digest")
    return package


def package_report_identity(package: dict[str, Any], label: str) -> dict[str, Any]:
    keys = (
        "name", "full_name", "tap_repository", "tap_name", "tap_commit",
        "version", "arch", "source_status", "metadata_status", "url",
        "sha256", "bytes", "cache_key_sha", "link_manifest", "prefix",
        "keg", "opt_link",
    )
    missing = set(keys) - set(package)
    if missing:
        fail(f"{label} is missing lazy-layer provenance fields: {sorted(missing)}")
    result = {key: package[key] for key in keys}
    if "built_from" in package:
        result["built_from"] = package["built_from"]
    return result


def lazy_package_identity(package: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in package.items()
        if key not in ("formula_revision", "bottle_rebuild")
    }


def validate_lazy_base_package_source(
    value: Any,
    *,
    expected_abi: int,
    base_sha: str,
    base_bytes: int,
) -> None:
    source = record(value, "Homebrew lazy layer base package source")
    if set(source) != {"schema", "kind", "index", "package", "archive", "output"}:
        fail("Homebrew lazy layer base package source has unexpected fields")
    exact(source.get("schema"), 1, "Homebrew lazy layer base package source schema")
    exact(
        source.get("kind"),
        "kandelo-package-output",
        "Homebrew lazy layer base package source kind",
    )

    index = record(source.get("index"), "Homebrew lazy layer base package index")
    if set(index) != {"url", "sha256", "bytes", "abi"}:
        fail("Homebrew lazy layer base package index has unexpected fields")
    https_url(index.get("url"), "Homebrew lazy layer base package index URL")
    sha(index.get("sha256"), "Homebrew lazy layer base package index digest")
    integer(index.get("bytes"), "Homebrew lazy layer base package index size", minimum=1)
    exact(index.get("abi"), expected_abi, "Homebrew lazy layer base package index ABI")

    package = record(source.get("package"), "Homebrew lazy layer base package")
    if set(package) != {"name", "version", "revision", "arch", "cache_key_sha"}:
        fail("Homebrew lazy layer base package has unexpected fields")
    exact(package.get("name"), "shell", "Homebrew lazy layer base package name")
    string(package.get("version"), "Homebrew lazy layer base package version")
    integer(package.get("revision"), "Homebrew lazy layer base package revision", minimum=1)
    exact(package.get("arch"), "wasm32", "Homebrew lazy layer base package architecture")
    sha(package.get("cache_key_sha"), "Homebrew lazy layer base package cache key")

    archive = record(source.get("archive"), "Homebrew lazy layer base package archive")
    if set(archive) != {"format", "url", "sha256", "bytes"}:
        fail("Homebrew lazy layer base package archive has unexpected fields")
    exact(
        archive.get("format"),
        "kandelo-package-tar-zstd-v2",
        "Homebrew lazy layer base package archive format",
    )
    https_url(archive.get("url"), "Homebrew lazy layer base package archive URL")
    sha(archive.get("sha256"), "Homebrew lazy layer base package archive digest")
    integer(
        archive.get("bytes"),
        "Homebrew lazy layer base package archive size",
        minimum=1,
    )

    output = record(source.get("output"), "Homebrew lazy layer base package output")
    if set(output) != {"name", "path", "sha256", "bytes"}:
        fail("Homebrew lazy layer base package output has unexpected fields")
    exact(output.get("name"), "shell", "Homebrew lazy layer base package output name")
    exact(
        output.get("path"),
        "shell.vfs.zst",
        "Homebrew lazy layer base package output path",
    )
    exact(output.get("sha256"), base_sha, "Homebrew lazy layer base package output digest")
    exact(output.get("bytes"), base_bytes, "Homebrew lazy layer base package output size")


def validate_lazy_layer(
    result: dict[str, Any],
    *,
    archive_path: Path,
    descriptor_path: Path,
    tap_repository: str,
    tap_name: str,
    tap_commit: str,
    kandelo_commit: str,
    runtime_id: str,
) -> None:
    archive_value = read_bytes(
        archive_path,
        "Homebrew deferred-tree payload",
        MAX_LAZY_LAYER_ARCHIVE_BYTES,
    )
    descriptor_value, _ = read_json(
        descriptor_path, "Homebrew lazy layer descriptor"
    )
    descriptor = record(descriptor_value, "Homebrew lazy layer descriptor")
    expected_top_level = {
        "schema", "kind", "arch", "mount_prefix", "tap", "tap_lock",
        "kandelo", "bottle_release_tag", "selection", "packages",
        "base_vfs", "release", "acceptance_vfs", "deferred_trees",
    }
    if set(descriptor) != expected_top_level:
        fail("Homebrew lazy layer descriptor has unexpected fields")
    exact(descriptor.get("schema"), 3, "Homebrew lazy layer schema")
    exact(
        descriptor.get("kind"),
        "kandelo-homebrew-deferred-layer",
        "Homebrew lazy layer kind",
    )
    exact(descriptor.get("arch"), "wasm32", "Homebrew lazy layer architecture")
    exact(descriptor.get("mount_prefix"), "/", "Homebrew lazy layer mount prefix")
    exact(
        descriptor.get("bottle_release_tag"),
        result["release_tag"],
        "Homebrew lazy layer bottle release tag",
    )

    tap = record(descriptor.get("tap"), "Homebrew lazy layer tap")
    if set(tap) != {"repository", "name", "commit"}:
        fail("Homebrew lazy layer tap has unexpected fields")
    exact(tap.get("repository"), tap_repository, "Homebrew lazy layer tap repository")
    exact(tap.get("name"), tap_name, "Homebrew lazy layer tap name")
    exact(tap.get("commit"), tap_commit, "Homebrew lazy layer tap commit")

    kandelo = record(descriptor.get("kandelo"), "Homebrew lazy layer Kandelo source")
    if set(kandelo) != {"repository", "commit", "abi"}:
        fail("Homebrew lazy layer Kandelo source has unexpected fields")
    exact(
        kandelo.get("repository"),
        "Automattic/kandelo",
        "Homebrew lazy layer Kandelo repository",
    )
    exact(kandelo.get("commit"), kandelo_commit, "Homebrew lazy layer Kandelo commit")
    exact(kandelo.get("abi"), result["abi"], "Homebrew lazy layer Kandelo ABI")

    tap_lock = array(descriptor.get("tap_lock"), "Homebrew lazy layer tap lock")
    if not tap_lock:
        fail("Homebrew lazy layer tap lock must not be empty")
    taps_by_name: dict[str, dict[str, Any]] = {}
    repositories: set[str] = set()
    locked_names: list[str] = []
    for index, value in enumerate(tap_lock):
        locked = record(value, f"Homebrew lazy layer tap lock {index}")
        if set(locked) != {
            "repository", "name", "commit", "kandelo_repository",
            "kandelo_commit", "kandelo_abi", "bottle_release_tag",
        }:
            fail(f"Homebrew lazy layer tap lock {index} has unexpected fields")
        repository = string(
            locked.get("repository"), f"Homebrew lazy layer tap lock {index} repository"
        )
        name = string(locked.get("name"), f"Homebrew lazy layer tap lock {index} name")
        if not REPOSITORY_RE.fullmatch(repository) or not TAP_NAME_RE.fullmatch(name):
            fail(f"Homebrew lazy layer tap lock {index} has an invalid identity")
        locked_commit = string(
            locked.get("commit"), f"Homebrew lazy layer tap lock {index} commit"
        )
        commit(locked_commit, f"Homebrew lazy layer tap lock {index} commit")
        kandelo_repository = string(
            locked.get("kandelo_repository"),
            f"Homebrew lazy layer tap lock {index} Kandelo repository",
        )
        if not REPOSITORY_RE.fullmatch(kandelo_repository):
            fail(f"Homebrew lazy layer tap lock {index} Kandelo repository is invalid")
        commit(
            string(
                locked.get("kandelo_commit"),
                f"Homebrew lazy layer tap lock {index} Kandelo commit",
            ),
            f"Homebrew lazy layer tap lock {index} Kandelo commit",
        )
        exact(
            locked.get("kandelo_abi"),
            result["abi"],
            f"Homebrew lazy layer tap lock {index} Kandelo ABI",
        )
        string(
            locked.get("bottle_release_tag"),
            f"Homebrew lazy layer tap lock {index} bottle release tag",
        )
        repository_key = repository.lower()
        if name in taps_by_name or repository_key in repositories:
            fail("Homebrew lazy layer tap lock has a duplicate identity")
        taps_by_name[name] = locked
        repositories.add(repository_key)
        locked_names.append(name)
    if locked_names != sorted(locked_names):
        fail("Homebrew lazy layer tap lock is not in canonical name order")
    root_lock = taps_by_name.get(tap_name)
    if root_lock is None:
        fail("Homebrew lazy layer tap lock omits the root tap")
    exact(
        root_lock.get("repository"),
        tap_repository,
        "Homebrew lazy layer root tap lock repository",
    )
    exact(root_lock.get("commit"), tap_commit, "Homebrew lazy layer root tap lock commit")
    exact(
        root_lock.get("kandelo_repository"),
        "Automattic/kandelo",
        "Homebrew lazy layer root tap lock Kandelo repository",
    )
    exact(
        root_lock.get("kandelo_commit"),
        kandelo_commit,
        "Homebrew lazy layer root tap lock Kandelo commit",
    )
    exact(
        root_lock.get("bottle_release_tag"),
        result["release_tag"],
        "Homebrew lazy layer root tap lock release tag",
    )

    report_packages = [
        record(value, f"VFS report package {index}")
        for index, value in enumerate(result["report_packages"])
    ]
    report_identities = [
        package_report_identity(package, f"VFS report package {index}")
        for index, package in enumerate(report_packages)
    ]
    report_order = [
        string(package.get("full_name"), f"VFS report package {index} full name")
        for index, package in enumerate(report_packages)
    ]

    selection = record(descriptor.get("selection"), "Homebrew lazy layer selection")
    if set(selection) != {
        "requested_packages", "package_order", "base_package_order",
        "layer_package_order",
    }:
        fail("Homebrew lazy layer selection has unexpected fields")
    exact(
        selection.get("requested_packages"),
        [runtime_id],
        "Homebrew lazy layer requested packages",
    )
    package_order = array(
        selection.get("package_order"),
        "Homebrew lazy layer dependency-first package order",
    )
    root_full_name = f"{tap_name.lower()}/{runtime_id}"
    closure = {root_full_name}
    changed = True
    while changed:
        changed = False
        for raw_edge in result["dependency_edges"]:
            edge = record(raw_edge, "Homebrew lazy layer dependency edge")
            source = edge.get("from")
            target = edge.get("to")
            if source in closure and target not in closure:
                closure.add(target)
                changed = True
    expected_package_order = [name for name in report_order if name in closure]
    if root_full_name not in report_order or package_order != expected_package_order:
        fail("Homebrew lazy layer package order is not the exact runtime closure")
    base_order = array(
        selection.get("base_package_order"),
        "Homebrew lazy layer base package order",
    )
    layer_order = array(
        selection.get("layer_package_order"),
        "Homebrew lazy layer layer package order",
    )
    if not layer_order:
        fail("Homebrew lazy layer must add at least one package")
    if len(set(base_order + layer_order)) != len(base_order) + len(layer_order):
        fail("Homebrew lazy layer package ownership is not disjoint")
    ownership = set(base_order)
    ownership.update(layer_order)
    if ownership != set(package_order):
        fail("Homebrew lazy layer package ownership does not cover the selected closure")
    if [name for name in package_order if name in set(base_order)] != base_order:
        fail("Homebrew lazy layer base package order is not dependency-first")
    if [name for name in package_order if name in set(layer_order)] != layer_order:
        fail("Homebrew lazy layer layer package order is not dependency-first")

    packages_value = record(descriptor.get("packages"), "Homebrew lazy layer packages")
    if set(packages_value) != {"base", "layer"}:
        fail("Homebrew lazy layer packages have unexpected fields")
    base_packages = [
        validate_lazy_package_record(value, f"Homebrew lazy layer base package {index}")
        for index, value in enumerate(
            array(packages_value.get("base"), "Homebrew lazy layer base packages")
        )
    ]
    layer_packages = [
        validate_lazy_package_record(value, f"Homebrew lazy layer package {index}")
        for index, value in enumerate(
            array(packages_value.get("layer"), "Homebrew lazy layer layer packages")
        )
    ]
    exact(
        [package["full_name"] for package in base_packages],
        base_order,
        "Homebrew lazy layer base package records",
    )
    exact(
        [package["full_name"] for package in layer_packages],
        layer_order,
        "Homebrew lazy layer package records",
    )
    descriptor_by_name = {
        package["full_name"]: package for package in base_packages + layer_packages
    }
    if len(descriptor_by_name) != len(package_order):
        fail("Homebrew lazy layer package records contain duplicate identities")
    report_by_name = dict(zip(report_order, report_identities, strict=True))
    for index, full_name in enumerate(package_order):
        report_identity = report_by_name.get(full_name)
        if report_identity is None:
            fail(f"Homebrew lazy layer package {full_name} is absent from acceptance")
        package = descriptor_by_name.get(full_name)
        if package is None:
            fail(f"Homebrew lazy layer package record is missing {full_name}")
        exact(
            lazy_package_identity(package),
            report_identity,
            f"Homebrew lazy layer package provenance {index}",
        )
        locked = taps_by_name.get(package["tap_name"])
        if locked is None:
            fail(f"Homebrew lazy layer package {full_name} has no locked tap")
        exact(
            locked.get("repository"),
            package["tap_repository"],
            f"Homebrew lazy layer package {full_name} tap repository",
        )
        built_from = package.get("built_from")
        if built_from is None:
            exact(
                locked.get("commit"),
                package["tap_commit"],
                f"Homebrew lazy layer package {full_name} tap snapshot commit",
            )
        else:
            exact(
                built_from["tap_repository"],
                package["tap_repository"],
                f"Homebrew lazy layer package {full_name} bottle tap repository",
            )
            exact(
                built_from["tap_commit"],
                package["tap_commit"],
                f"Homebrew lazy layer package {full_name} bottle build commit",
            )

    base_vfs = record(descriptor.get("base_vfs"), "Homebrew lazy layer base VFS")
    if set(base_vfs) != {
        "sha256", "bytes", "kernel_abi", "package_source", "composition",
    }:
        fail("Homebrew lazy layer base VFS has unexpected fields")
    base_sha = sha(base_vfs.get("sha256"), "Homebrew lazy layer base VFS digest")
    base_bytes = integer(
        base_vfs.get("bytes"), "Homebrew lazy layer base VFS size", minimum=1
    )
    exact(
        base_vfs.get("kernel_abi"),
        result["abi"],
        "Homebrew lazy layer base VFS ABI",
    )
    validate_lazy_base_package_source(
        base_vfs.get("package_source"),
        expected_abi=result["abi"],
        base_sha=base_sha,
        base_bytes=base_bytes,
    )
    composition = record(
        base_vfs.get("composition"), "Homebrew lazy layer base composition"
    )
    if set(composition) != {
        "path", "sha256", "bytes", "requested_packages_sha256",
        "package_set_sha256", "package_count", "package_order",
    }:
        fail("Homebrew lazy layer base composition has unexpected fields")
    exact(
        composition.get("path"),
        "/etc/kandelo/homebrew-vfs.json",
        "Homebrew lazy layer base composition path",
    )
    sha(composition.get("sha256"), "Homebrew lazy layer base composition digest")
    integer(
        composition.get("bytes"),
        "Homebrew lazy layer base composition size",
        minimum=1,
    )
    sha(
        composition.get("requested_packages_sha256"),
        "Homebrew lazy layer base requested package digest",
    )
    sha(
        composition.get("package_set_sha256"),
        "Homebrew lazy layer base package set digest",
    )
    composition_order = array(
        composition.get("package_order"),
        "Homebrew lazy layer base composition package order",
    )
    if (
        not composition_order
        or any(not isinstance(value, str) or not value for value in composition_order)
        or len(set(composition_order)) != len(composition_order)
    ):
        fail("Homebrew lazy layer base composition package order is invalid")
    exact(
        composition.get("package_count"),
        len(composition_order),
        "Homebrew lazy layer base composition package count",
    )
    if any(name not in composition_order for name in base_order):
        fail("Homebrew lazy layer reuses a package absent from the base composition")

    release_tag = f"homebrew-vfs-sha256-{result['image_sha']}"
    release_root = (
        f"https://github.com/{tap_repository}/releases/download/{release_tag}"
    )
    release = record(descriptor.get("release"), "Homebrew lazy layer release")
    if set(release) != {"repository", "tag"}:
        fail("Homebrew lazy layer release has unexpected fields")
    exact(release.get("repository"), tap_repository, "Homebrew lazy layer release repository")
    exact(release.get("tag"), release_tag, "Homebrew lazy layer release tag")

    acceptance_vfs = record(
        descriptor.get("acceptance_vfs"), "Homebrew lazy layer acceptance VFS"
    )
    if set(acceptance_vfs) != {"asset", "url", "sha256", "bytes"}:
        fail("Homebrew lazy layer acceptance VFS has unexpected fields")
    exact(
        acceptance_vfs.get("asset"),
        IMAGE_ASSET,
        "Homebrew lazy layer acceptance VFS asset",
    )
    exact(
        acceptance_vfs.get("url"),
        f"{release_root}/{IMAGE_ASSET}",
        "Homebrew lazy layer acceptance VFS URL",
    )
    exact(
        acceptance_vfs.get("sha256"),
        result["image_sha"],
        "Homebrew lazy layer acceptance VFS digest",
    )
    exact(
        acceptance_vfs.get("bytes"),
        result["image_bytes"],
        "Homebrew lazy layer acceptance VFS size",
    )

    trees = array(descriptor.get("deferred_trees"), "Homebrew deferred trees")
    if len(trees) != 1:
        fail("The scaffold publisher requires exactly one Homebrew deferred tree")
    tree = record(trees[0], "Homebrew deferred tree")
    if set(tree) != {"id", "activation", "content", "transports", "inventory"}:
        fail("Homebrew deferred tree has unexpected fields")
    exact(tree.get("id"), runtime_id, "Homebrew deferred tree id")

    activation = record(tree.get("activation"), "Homebrew deferred tree activation")
    if set(activation) != {"mode", "capabilities", "roots"}:
        fail("Homebrew deferred tree activation has unexpected fields")
    if activation.get("mode") not in ("boot-prefetch", "first-use"):
        fail("Homebrew deferred tree activation mode is invalid")
    capabilities = array(
        activation.get("capabilities"), "Homebrew deferred tree capabilities"
    )
    roots = array(activation.get("roots"), "Homebrew deferred tree roots")
    if (
        not capabilities
        or capabilities != sorted(capabilities)
        or len(set(capabilities)) != len(capabilities)
        or any(not isinstance(value, str) or not value for value in capabilities)
    ):
        fail("Homebrew deferred tree capabilities are invalid")
    if (
        not roots
        or roots != sorted(roots)
        or len(set(roots)) != len(roots)
        or any(
            not isinstance(value, str)
            or not value.startswith("/")
            or any(part in ("", ".", "..") for part in value[1:].split("/"))
            for value in roots
        )
    ):
        fail("Homebrew deferred tree roots are invalid")

    content = record(tree.get("content"), "Homebrew deferred tree content")
    if set(content) != {"media_type", "decoder", "sha256", "bytes"}:
        fail("Homebrew deferred tree content has unexpected fields")
    decoder = content.get("decoder")
    media_type = content.get("media_type")
    if not (
        (decoder == "zip-v1" and media_type == "application/zip")
        or (
            decoder == "homebrew-bottle-tar-gzip-v1"
            and media_type == "application/vnd.oci.image.layer.v1.tar+gzip"
        )
    ):
        fail("Homebrew deferred tree decoder/media type is unsupported")
    exact(
        content.get("sha256"),
        digest_bytes(archive_value),
        "Homebrew deferred tree digest",
    )
    exact(content.get("bytes"), len(archive_value), "Homebrew deferred tree size")

    transports = array(tree.get("transports"), "Homebrew deferred tree transports")
    if not transports or len(transports) > 8:
        fail("Homebrew deferred tree must have one to eight transports")
    transport_urls: list[str] = []
    for index, value in enumerate(transports):
        transport = record(value, f"Homebrew deferred tree transport {index}")
        if set(transport) != {"url"}:
            fail(f"Homebrew deferred tree transport {index} has unexpected fields")
        transport_urls.append(
            https_url(transport.get("url"), f"Homebrew deferred tree transport {index} URL")
        )
    if len(set(transport_urls)) != len(transport_urls):
        fail("Homebrew deferred tree transports contain duplicates")
    lazy_layer_asset, _ = lazy_layer_asset_names(runtime_id)
    exact(
        transport_urls[0],
        f"{release_root}/{lazy_layer_asset}",
        "Homebrew deferred tree primary release mirror",
    )

    inventory = record(tree.get("inventory"), "Homebrew deferred tree inventory")
    if set(inventory) != {
        "entry_count", "source_entry_count", "regular_inode_count",
        "layer_entry_count", "shared_base_directory_count", "expanded_bytes",
        "payload_bytes", "entries",
    }:
        fail("Homebrew deferred tree inventory has unexpected fields")
    entries = array(inventory.get("entries"), "Homebrew deferred tree entries")
    if not entries or len(entries) > MAX_LAZY_LAYER_ENTRIES:
        fail(
            f"Homebrew lazy layer entries must contain 1 to "
            f"{MAX_LAZY_LAYER_ENTRIES} records"
        )
    validated_entries: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    expanded_payload_bytes = 0
    payload_bytes = 0
    layer_entry_count = 0
    shared_base_directory_count = 0
    has_layer_payload = False
    for index, value in enumerate(entries):
        entry = record(value, f"Homebrew lazy layer entry {index}")
        entry_type = entry.get("type")
        expected_keys = {"path", "source_path", "type", "ownership", "mode", "size"}
        if entry_type == "symlink":
            expected_keys.add("target")
        elif entry_type == "file":
            expected_keys.add("inode_group")
        elif entry_type == "hardlink":
            expected_keys.update(("target", "inode_group"))
        elif entry_type != "directory":
            fail(f"Homebrew lazy layer entry {index} has an invalid type")
        if set(entry) != expected_keys:
            fail(f"Homebrew lazy layer entry {index} has unexpected fields")
        ownership_value = entry.get("ownership")
        if ownership_value not in ("layer", "shared-base-directory"):
            fail(f"Homebrew lazy layer entry {index} has invalid ownership")
        if ownership_value == "shared-base-directory" and entry_type != "directory":
            fail(f"Homebrew lazy layer entry {index} shares a non-directory with its base")
        path = string(
            entry.get("path"),
            f"Homebrew lazy layer entry {index} path",
            maximum=MAX_LAZY_LAYER_PATH_BYTES,
        )
        source_path = string(
            entry.get("source_path"),
            f"Homebrew lazy layer entry {index} source path",
            maximum=MAX_LAZY_LAYER_PATH_BYTES,
        )
        components = path.split("/")
        if path.startswith("/") or "\\" in path or any(
            component in ("", ".", "..") for component in components
        ):
            fail(f"Homebrew lazy layer entry {index} has an unsafe path")
        if not (
            path == "home/linuxbrew/.linuxbrew"
            or path.startswith("home/linuxbrew/.linuxbrew/")
        ):
            fail(f"Homebrew lazy layer entry {index} escapes the Homebrew prefix")
        if path in seen_paths:
            fail(f"Homebrew lazy layer entry {index} duplicates path {path}")
        seen_paths.add(path)
        if source_path.startswith("/") or "\\" in source_path or any(
            component in ("", ".", "..") for component in source_path.split("/")
        ):
            fail(f"Homebrew lazy layer entry {index} has an unsafe source path")
        mode = integer(entry.get("mode"), f"Homebrew lazy layer entry {index} mode")
        if mode > 0o7777:
            fail(f"Homebrew lazy layer entry {index} mode exceeds POSIX permission bits")
        size = integer(entry.get("size"), f"Homebrew lazy layer entry {index} size")
        if size > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail(f"Homebrew lazy layer entry {index} exceeds the size limit")
        if entry_type != "hardlink":
            expanded_payload_bytes += size
        if entry_type == "file":
            payload_bytes += size
        if max(expanded_payload_bytes, payload_bytes) > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail("Homebrew lazy layer exceeds the uncompressed size limit")
        if entry_type == "directory" and size != 0:
            fail(f"Homebrew lazy layer directory {path} has nonzero size")
        if ownership_value == "layer":
            layer_entry_count += 1
            has_layer_payload = has_layer_payload or entry_type != "directory"
        else:
            shared_base_directory_count += 1
        if entry_type in ("file", "hardlink"):
            string(
                entry.get("inode_group"),
                f"Homebrew lazy layer entry {index} inode group",
                maximum=MAX_LAZY_LAYER_PATH_BYTES,
            )
        if entry_type == "symlink":
            target = string(
                entry.get("target"),
                f"Homebrew lazy layer entry {index} target",
                maximum=65_536,
            )
            if len(target.encode("utf-8")) != size:
                fail(f"Homebrew lazy layer symlink {path} size differs from its target")
            validated_entries.append({**entry, "target": target})
        elif entry_type == "hardlink":
            target = string(
                entry.get("target"),
                f"Homebrew lazy layer entry {index} hardlink target",
                maximum=MAX_LAZY_LAYER_PATH_BYTES,
            )
            validated_entries.append({**entry, "target": target})
        else:
            validated_entries.append(entry)
    if not has_layer_payload:
        fail("Homebrew lazy layer has no layer-owned file or symlink")
    paths = [entry["path"] for entry in validated_entries]
    if paths != sorted(paths):
        fail("Homebrew lazy layer entries are not in canonical path order")
    exact(
        inventory.get("entry_count"),
        len(validated_entries),
        "Homebrew lazy layer archive entry count",
    )
    exact(
        inventory.get("layer_entry_count"),
        layer_entry_count,
        "Homebrew lazy layer archive-owned entry count",
    )
    exact(
        inventory.get("shared_base_directory_count"),
        shared_base_directory_count,
        "Homebrew lazy layer shared base directory count",
    )
    exact(
        inventory.get("payload_bytes"),
        payload_bytes,
        "Homebrew deferred tree payload size",
    )
    source_count = len({entry["source_path"] for entry in validated_entries})
    exact(
        inventory.get("source_entry_count"),
        source_count,
        "Homebrew deferred tree source entry count",
    )
    canonical_groups = resolve_lazy_layer_hardlinks(validated_entries)
    exact(
        inventory.get("regular_inode_count"),
        len(canonical_groups),
        "Homebrew deferred tree regular inode count",
    )
    expanded_bytes = integer(
        inventory.get("expanded_bytes"),
        "Homebrew deferred tree expansion size",
    )
    if expanded_bytes > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
        fail("Homebrew deferred tree expansion exceeds the size limit")
    if decoder == "zip-v1":
        exact(
            expanded_bytes,
            expanded_payload_bytes,
            "Homebrew deferred ZIP expansion size",
        )
        validate_lazy_layer_zip(archive_value, validated_entries)
    else:
        validate_lazy_layer_tar_gzip(
            archive_value,
            validated_entries,
            expanded_bytes,
        )


def validate_lazy_layer_zip(
    archive_value: bytes, entries: list[dict[str, Any]]
) -> None:
    indexed: list[dict[str, Any]] = []
    seen_sources: dict[str, dict[str, Any]] = {}
    for entry in entries:
        source_path = entry["source_path"]
        prior = seen_sources.get(source_path)
        if prior is not None:
            if (
                entry["type"] != "hardlink"
                or prior.get("inode_group") != entry.get("inode_group")
            ):
                fail(f"Homebrew deferred ZIP duplicates source member {source_path}")
            continue
        if entry["type"] == "hardlink":
            fail("Homebrew deferred ZIP cannot encode a distinct hardlink member")
        seen_sources[source_path] = entry
        indexed.append(entry)
    try:
        with zipfile.ZipFile(io.BytesIO(archive_value), "r") as archive:
            if archive.comment:
                fail("Homebrew lazy layer ZIP has a non-empty archive comment")
            infos = archive.infolist()
            expected_names = [
                f"{entry['source_path']}/"
                if entry["type"] == "directory"
                else entry["source_path"]
                for entry in indexed
            ]
            actual_names = [info.filename for info in infos]
            if actual_names != expected_names or len(set(actual_names)) != len(actual_names):
                fail("Homebrew lazy layer ZIP entries differ from the canonical index")
            for index, (info, entry) in enumerate(zip(infos, indexed, strict=True)):
                if info.create_system != 3:
                    fail(f"Homebrew lazy layer ZIP entry {index} is not Unix-authored")
                if info.date_time != (1980, 1, 1, 0, 0, 0):
                    fail(f"Homebrew lazy layer ZIP entry {index} has a non-canonical timestamp")
                if info.comment or info.extra or (info.flag_bits & 1):
                    fail(f"Homebrew lazy layer ZIP entry {index} has unsupported metadata")
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    fail(f"Homebrew lazy layer ZIP entry {index} has unsupported compression")
                expected_type = {
                    "directory": S_IFDIR,
                    "file": S_IFREG,
                    "symlink": S_IFLNK,
                }[entry["type"]]
                mode = (info.external_attr >> 16) & 0xffff
                if (mode & S_IFMT) != expected_type or (mode & 0o7777) != entry["mode"]:
                    fail(f"Homebrew lazy layer ZIP entry {index} mode differs from its index")
                exact(
                    info.file_size,
                    entry["size"],
                    f"Homebrew lazy layer ZIP entry {index} size",
                )
                if entry["type"] == "symlink":
                    value = archive.read(info)
                    try:
                        target = value.decode("utf-8")
                    except UnicodeDecodeError:
                        fail(f"Homebrew lazy layer ZIP symlink {index} is not UTF-8")
                    exact(
                        target,
                        entry["target"],
                        f"Homebrew lazy layer ZIP symlink {index} target",
                    )
                else:
                    extracted = 0
                    with archive.open(info, "r") as source:
                        while chunk := source.read(1024 * 1024):
                            extracted += len(chunk)
                    if extracted != entry["size"]:
                        fail(f"Homebrew lazy layer ZIP entry {index} extracted short")
    except zipfile.BadZipFile as error:
        fail(f"Homebrew lazy layer ZIP is invalid: {error}")


def decompress_single_lazy_layer_gzip(
    archive_value: bytes,
    expanded_bytes: int,
) -> bytes:
    if (
        len(archive_value) < 18
        or len(archive_value) > MAX_LAZY_LAYER_ARCHIVE_BYTES
        or archive_value[:3] != b"\x1f\x8b\x08"
    ):
        fail("Homebrew deferred TAR+gzip payload has an invalid gzip envelope")
    if expanded_bytes <= 0 or expanded_bytes > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
        fail("Homebrew deferred TAR+gzip expansion size is outside its bound")

    declared = int.from_bytes(archive_value[-4:], "little")
    exact(declared, expanded_bytes, "Homebrew deferred TAR+gzip expansion size")
    decoder = zlib.decompressobj(zlib.MAX_WBITS | 16)
    try:
        tar_value = decoder.decompress(archive_value, expanded_bytes + 1)
    except zlib.error as error:
        fail(f"Homebrew deferred TAR+gzip payload is invalid: {error}")
    if len(tar_value) > expanded_bytes or decoder.unconsumed_tail:
        fail(
            "Homebrew deferred TAR+gzip expansion exceeds its declared "
            f"{expanded_bytes} bytes"
        )
    if not decoder.eof:
        fail("Homebrew deferred TAR+gzip payload is truncated")
    if decoder.unused_data:
        fail("Homebrew deferred TAR+gzip payload has additional gzip member or data")
    exact(len(tar_value), expanded_bytes, "Homebrew deferred TAR byte count")
    return tar_value


def read_closed_tar_string(
    header: bytes,
    offset: int,
    length: int,
    label: str,
) -> str:
    field = header[offset : offset + length]
    terminator = field.find(b"\0")
    if terminator >= 0:
        field = field[:terminator]
    try:
        return field.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"{label} is not UTF-8: {error}")


def read_closed_tar_number(
    header: bytes,
    offset: int,
    length: int,
    label: str,
) -> int:
    field = header[offset : offset + length]
    if field and field[0] & 0x80:
        fail(f"{label} uses unsupported base-256 encoding")
    raw = read_closed_tar_string(header, offset, length, label).strip()
    if not raw:
        return 0
    if re.fullmatch(r"[0-7]+", raw) is None:
        fail(f"{label} is not a valid octal number")
    value = int(raw, 8)
    if value > TAR_MAX_SAFE_INTEGER:
        fail(f"{label} exceeds the runtime integer range")
    return value


def validate_closed_tar_checksum(header: bytes) -> None:
    recorded = read_closed_tar_number(
        header,
        148,
        8,
        "Homebrew deferred TAR checksum",
    )
    actual = sum(header[:148]) + 8 * 0x20 + sum(header[156:])
    if recorded != actual:
        fail("Homebrew deferred TAR checksum mismatch")


def parse_closed_pax_size(payload: bytes) -> int | None:
    result: int | None = None
    offset = 0
    while offset < len(payload):
        separator = payload.find(b" ", offset)
        if separator <= offset:
            fail("Homebrew deferred TAR has an invalid PAX record length")
        length_bytes = payload[offset:separator]
        if any(byte < ord("0") or byte > ord("9") for byte in length_bytes):
            fail("Homebrew deferred TAR has an invalid PAX record length")
        record_length = int(length_bytes)
        record_end = offset + record_length
        if (
            record_length <= separator - offset + 2
            or record_end > len(payload)
            or payload[record_end - 1] != ord("\n")
        ):
            fail("Homebrew deferred TAR has a truncated PAX record")
        equals = payload.find(b"=", separator + 1, record_end - 1)
        if equals <= separator + 1:
            fail("Homebrew deferred TAR has an invalid PAX record")
        key_bytes = payload[separator + 1 : equals]
        if len(key_bytes) > 256:
            fail("Homebrew deferred TAR PAX record key is too long")
        try:
            key = key_bytes.decode("utf-8")
        except UnicodeDecodeError as error:
            fail(f"Homebrew deferred TAR PAX record key is not UTF-8: {error}")
        if key == "size":
            value_bytes = payload[equals + 1 : record_end - 1]
            if len(value_bytes) > 32:
                fail("Homebrew deferred TAR PAX size is too long")
            try:
                value = value_bytes.decode("utf-8")
            except UnicodeDecodeError as error:
                fail(f"Homebrew deferred TAR PAX size is not UTF-8: {error}")
            if re.fullmatch(r"0|[1-9][0-9]*", value) is None:
                fail("Homebrew deferred TAR PAX size is invalid")
            result = int(value)
            if result > TAR_MAX_SAFE_INTEGER:
                fail("Homebrew deferred TAR PAX size exceeds the runtime integer range")
        offset = record_end
    return result


def advance_closed_tar_payload(tar_value: bytes, offset: int, size: int) -> int:
    padded_bytes = ((size + TAR_BLOCK_BYTES - 1) // TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    if padded_bytes > len(tar_value) - offset:
        fail("Homebrew deferred TAR entry or padding is truncated")
    return offset + padded_bytes


def validate_closed_tar_structure(tar_value: bytes) -> None:
    if len(tar_value) % TAR_BLOCK_BYTES:
        fail("Homebrew deferred TAR byte count is not block-aligned")

    offset = 0
    entry_count = 0
    extension_count = 0
    local_pax_size: int | None = None
    local_pax_pending = False
    global_pax_size: int | None = None
    terminated = False
    while offset + TAR_BLOCK_BYTES <= len(tar_value):
        header = tar_value[offset : offset + TAR_BLOCK_BYTES]
        offset += TAR_BLOCK_BYTES
        if header == TAR_ZERO_BLOCK:
            if tar_value[offset : offset + TAR_BLOCK_BYTES] != TAR_ZERO_BLOCK:
                fail("Homebrew deferred TAR has only one zero end block")
            offset += TAR_BLOCK_BYTES
            if any(tar_value[offset:]):
                fail("Homebrew deferred TAR has nonzero data after its end marker")
            terminated = True
            break

        validate_closed_tar_checksum(header)
        header_size = read_closed_tar_number(
            header,
            124,
            12,
            "Homebrew deferred TAR entry size",
        )
        read_closed_tar_number(
            header,
            100,
            8,
            "Homebrew deferred TAR entry mode",
        )
        read_closed_tar_string(header, 0, 100, "Homebrew deferred TAR entry path")
        read_closed_tar_string(header, 345, 155, "Homebrew deferred TAR path prefix")
        read_closed_tar_string(header, 157, 100, "Homebrew deferred TAR link target")
        typeflag = read_closed_tar_string(
            header,
            156,
            1,
            "Homebrew deferred TAR entry type",
        ) or "0"

        if typeflag in ("x", "g"):
            extension_count += 1
            if extension_count > MAX_LAZY_LAYER_ENTRIES + 1:
                fail("Homebrew deferred TAR has too many extension headers")
            payload_end = offset + header_size
            if payload_end > len(tar_value):
                fail("Homebrew deferred TAR extension header is truncated")
            pax_size = parse_closed_pax_size(tar_value[offset:payload_end])
            offset = advance_closed_tar_payload(tar_value, offset, header_size)
            if typeflag == "x":
                local_pax_size = pax_size
                local_pax_pending = True
            elif pax_size is not None:
                global_pax_size = pax_size
            continue

        if typeflag not in ("0", "1", "2", "5"):
            fail(f"Homebrew deferred TAR has unsupported entry type {typeflag!r}")
        entry_count += 1
        if entry_count > MAX_LAZY_LAYER_ENTRIES:
            fail("Homebrew deferred TAR has too many entries")
        size = (
            local_pax_size
            if local_pax_size is not None
            else global_pax_size
            if global_pax_size is not None
            else header_size
        )
        local_pax_size = None
        local_pax_pending = False
        if typeflag in ("1", "2", "5") and size != 0:
            fail("Homebrew deferred TAR link or directory has a nonzero payload")
        offset = advance_closed_tar_payload(tar_value, offset, size)

    if not terminated:
        fail("Homebrew deferred TAR is missing its two-block end marker")
    if local_pax_pending:
        fail("Homebrew deferred TAR local PAX header has no following entry")


def validate_lazy_layer_tar_gzip(
    archive_value: bytes,
    entries: list[dict[str, Any]],
    expanded_bytes: int,
) -> None:
    tar_value = decompress_single_lazy_layer_gzip(archive_value, expanded_bytes)
    validate_closed_tar_structure(tar_value)

    expected_by_source = {entry["source_path"]: entry for entry in entries}
    expected_by_path = {entry["path"]: entry for entry in entries}
    if len(expected_by_source) != len(entries):
        fail("Homebrew deferred TAR inventory duplicates a source member")
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_value), mode="r:") as archive:
            members = archive.getmembers()
            actual_names = [member.name.removeprefix("./").rstrip("/") for member in members]
            if actual_names != list(expected_by_source) or len(set(actual_names)) != len(actual_names):
                fail("Homebrew deferred TAR members differ from the canonical inventory")
            for index, (member, source_path) in enumerate(
                zip(members, actual_names, strict=True)
            ):
                entry = expected_by_source[source_path]
                actual_type = (
                    "directory" if member.isdir()
                    else "file" if member.isfile()
                    else "symlink" if member.issym()
                    else "hardlink" if member.islnk()
                    else "unsupported"
                )
                exact(
                    actual_type,
                    entry["type"],
                    f"Homebrew deferred TAR entry {index} type",
                )
                exact(
                    member.mode & 0o7777,
                    entry["mode"],
                    f"Homebrew deferred TAR entry {index} mode",
                )
                if actual_type == "file":
                    exact(
                        member.size,
                        entry["size"],
                        f"Homebrew deferred TAR entry {index} size",
                    )
                    extracted = archive.extractfile(member)
                    if extracted is None or len(extracted.read()) != entry["size"]:
                        fail(f"Homebrew deferred TAR entry {index} extracted short")
                elif actual_type == "symlink":
                    exact(
                        member.linkname,
                        entry["target"],
                        f"Homebrew deferred TAR symlink {index} target",
                    )
                elif actual_type == "hardlink":
                    target = expected_by_path.get(entry["target"])
                    if target is None:
                        fail(
                            f"Homebrew deferred TAR hardlink {index} "
                            "target is absent from the inventory"
                        )
                    exact(
                        member.linkname.removeprefix("./").rstrip("/"),
                        target["source_path"],
                        f"Homebrew deferred TAR hardlink {index} target",
                    )
    except tarfile.TarError as error:
        fail(f"Homebrew deferred TAR is invalid: {error}")


def asset_record(repository: str, tag: str, name: str, value: bytes) -> dict[str, Any]:
    return {
        "asset": name,
        "url": f"https://github.com/{repository}/releases/download/{tag}/{name}",
        "sha256": digest_bytes(value),
        "bytes": len(value),
    }


def build_descriptor(
    result: dict[str, Any],
    *,
    tap_repository: str,
    tap_name: str,
    tap_commit: str,
    formula: str,
    kandelo_commit: str,
    image_value: bytes,
) -> dict[str, Any]:
    tag = f"homebrew-vfs-sha256-{result['image_sha']}"
    image = asset_record(tap_repository, tag, IMAGE_ASSET, image_value)
    image["kernel_abi"] = result["abi"]
    descriptor: dict[str, Any] = {
        "schema": 1,
        "kind": "kandelo-homebrew-vfs",
        "formula": formula,
        "arch": "wasm32",
        "tap": {
            "repository": tap_repository,
            "name": tap_name,
            "commit": tap_commit,
        },
        "kandelo": {
            "repository": "Automattic/kandelo",
            "commit": kandelo_commit,
            "abi": result["abi"],
        },
        "bottle_release_tag": result["release_tag"],
        "selection": {
            "requested_packages": result["requested"],
            "dependency_edges": result["dependency_edges"],
        },
        "acceptance": {
            "node": "success",
            "browser": "chromium",
            "executable": result["executable"],
            "argv": result["argv"],
        },
        "release": {"repository": tap_repository, "tag": tag},
        "image": image,
        "evidence": {
            "report": asset_record(tap_repository, tag, REPORT_ASSET, result["report_bytes"]),
            "node": asset_record(tap_repository, tag, NODE_ASSET, result["node_bytes"]),
            "browser": asset_record(tap_repository, tag, BROWSER_ASSET, result["browser_bytes"]),
        },
        "launch": {"query_parameter": "vfs", "value": image["url"]},
    }
    if result["default_shell"] is not None:
        descriptor["default_shell"] = result["default_shell"]
    return descriptor


def descriptor_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def validate_bundle_dir(path: Path, runtime_id: str) -> None:
    if not path.is_dir() or path.is_symlink():
        fail("VFS release handoff must be a real directory")
    names = {entry.name for entry in path.iterdir()}
    expected = expected_assets(runtime_id)
    lazy_layer_asset, _ = lazy_layer_asset_names(runtime_id)
    if names != expected:
        fail(f"VFS release handoff has unexpected entries: {sorted(names ^ expected)}")
    for name in expected:
        regular_file(
            path / name,
            f"VFS release handoff {name}",
            MAX_VFS_BYTES
            if name in (IMAGE_ASSET, lazy_layer_asset)
            else MAX_JSON_BYTES,
        )


def common_kwargs(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    return {
        "image_path": root / IMAGE_ASSET,
        "report_path": root / REPORT_ASSET,
        "node_path": root / NODE_ASSET,
        "browser_path": root / BROWSER_ASSET,
        "tap_root": Path(args.tap_root),
        "tap_repository": args.tap_repository,
        "tap_name": args.tap_name,
        "tap_commit": args.tap_commit,
        "formula": args.formula,
        "kandelo_commit": args.kandelo_commit,
        "expected_abi": args.abi,
        "bottle_release_tag": args.bottle_release_tag,
    }


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.out)
    if output.exists() or output.is_symlink():
        fail("VFS release handoff output must not already exist")
    output.mkdir(mode=0o700, parents=False)
    lazy_layer_asset, lazy_layer_descriptor_asset = lazy_layer_asset_names(args.formula)
    sources = {
        IMAGE_ASSET: Path(args.image),
        REPORT_ASSET: Path(args.report),
        NODE_ASSET: Path(args.node_evidence),
        BROWSER_ASSET: Path(args.browser_evidence),
        lazy_layer_asset: Path(args.lazy_layer),
        lazy_layer_descriptor_asset: Path(args.lazy_layer_descriptor),
    }
    for name, source in sources.items():
        read_bytes(
            source,
            f"release source {name}",
            MAX_VFS_BYTES
            if name in (IMAGE_ASSET, lazy_layer_asset)
            else MAX_JSON_BYTES,
        )
        shutil.copyfile(source, output / name, follow_symlinks=False)
    result = validate_evidence(**common_kwargs(args, output))
    validate_lazy_layer(
        result,
        archive_path=output / lazy_layer_asset,
        descriptor_path=output / lazy_layer_descriptor_asset,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        kandelo_commit=args.kandelo_commit,
        runtime_id=args.formula,
    )
    image_value = read_bytes(output / IMAGE_ASSET, "VFS release image", MAX_VFS_BYTES)
    descriptor = build_descriptor(
        result,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        formula=args.formula,
        kandelo_commit=args.kandelo_commit,
        image_value=image_value,
    )
    (output / DESCRIPTOR_ASSET).write_bytes(descriptor_bytes(descriptor))
    validate(args)
    return descriptor


def validate(args: argparse.Namespace) -> dict[str, Any]:
    handoff = Path(args.handoff if hasattr(args, "handoff") else args.out)
    lazy_layer_asset, lazy_layer_descriptor_asset = lazy_layer_asset_names(args.formula)
    validate_bundle_dir(handoff, args.formula)
    result = validate_evidence(**common_kwargs(args, handoff))
    validate_lazy_layer(
        result,
        archive_path=handoff / lazy_layer_asset,
        descriptor_path=handoff / lazy_layer_descriptor_asset,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        kandelo_commit=args.kandelo_commit,
        runtime_id=args.formula,
    )
    image_value = read_bytes(handoff / IMAGE_ASSET, "VFS release image", MAX_VFS_BYTES)
    expected = build_descriptor(
        result,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        formula=args.formula,
        kandelo_commit=args.kandelo_commit,
        image_value=image_value,
    )
    actual, _ = read_json(handoff / DESCRIPTOR_ASSET, "VFS release descriptor")
    exact(actual, expected, "VFS release descriptor")
    return expected


def emit_outputs(descriptor: dict[str, Any]) -> None:
    release = record(descriptor["release"], "release descriptor")
    image = record(descriptor["image"], "image descriptor")
    values = {
        "release-tag": release["tag"],
        "image-url": image["url"],
        "descriptor-url": (
            f"https://github.com/{release['repository']}/releases/download/"
            f"{release['tag']}/{DESCRIPTOR_ASSET}"
        ),
        "image-sha256": image["sha256"],
        "image-bytes": image["bytes"],
    }
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            for key, value in values.items():
                stream.write(f"{key}={value}\n")
    print(json.dumps(values, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)
    for command in ("prepare", "validate"):
        sub = subcommands.add_parser(command)
        sub.add_argument("--tap-root", required=True)
        sub.add_argument("--tap-repository", required=True)
        sub.add_argument("--tap-name", required=True)
        sub.add_argument("--tap-commit", required=True)
        sub.add_argument("--formula", required=True)
        sub.add_argument("--kandelo-commit", required=True)
        sub.add_argument("--abi", required=True, type=int)
        sub.add_argument("--bottle-release-tag", required=True)
        if command == "prepare":
            sub.add_argument("--image", required=True)
            sub.add_argument("--report", required=True)
            sub.add_argument("--node-evidence", required=True)
            sub.add_argument("--browser-evidence", required=True)
            sub.add_argument("--lazy-layer", required=True)
            sub.add_argument("--lazy-layer-descriptor", required=True)
            sub.add_argument("--out", required=True)
        else:
            sub.add_argument("--handoff", required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        descriptor = prepare(args) if args.command == "prepare" else validate(args)
        emit_outputs(descriptor)
        return 0
    except ValidationError as error:
        print(f"homebrew-vfs-release.py: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
