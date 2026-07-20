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
import zipfile
from typing import Any


MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_VFS_BYTES = 2 * 1024 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
FORMULA_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
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
LAZY_LAYER_ASSET = "kandelo-homebrew-shell-layer.zip"
LAZY_LAYER_DESCRIPTOR_ASSET = "kandelo-homebrew-shell-layer.json"
EXPECTED_ASSETS = {
    IMAGE_ASSET,
    REPORT_ASSET,
    NODE_ASSET,
    BROWSER_ASSET,
    DESCRIPTOR_ASSET,
    LAZY_LAYER_ASSET,
    LAZY_LAYER_DESCRIPTOR_ASSET,
}
MAX_LAZY_LAYER_ENTRIES = 100_000
MAX_LAZY_LAYER_PATH_BYTES = 4096
MAX_LAZY_LAYER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
S_IFMT = 0o170000
S_IFREG = 0o100000
S_IFDIR = 0o040000
S_IFLNK = 0o120000


class ValidationError(Exception):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


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


def validate_lazy_layer(
    result: dict[str, Any],
    *,
    archive_path: Path,
    descriptor_path: Path,
    tap_repository: str,
    tap_name: str,
    tap_commit: str,
    kandelo_commit: str,
) -> None:
    archive_value = read_bytes(archive_path, "Homebrew lazy layer ZIP", MAX_VFS_BYTES)
    descriptor_value, _ = read_json(
        descriptor_path, "Homebrew lazy layer descriptor"
    )
    descriptor = record(descriptor_value, "Homebrew lazy layer descriptor")
    expected_top_level = {
        "schema", "kind", "arch", "mount_prefix", "tap", "kandelo",
        "bottle_release_tag", "selection", "packages", "release",
        "source_vfs", "archive", "entries",
    }
    if set(descriptor) != expected_top_level:
        fail("Homebrew lazy layer descriptor has unexpected fields")
    exact(descriptor.get("schema"), 1, "Homebrew lazy layer schema")
    exact(
        descriptor.get("kind"),
        "kandelo-homebrew-lazy-archive",
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

    selection = record(descriptor.get("selection"), "Homebrew lazy layer selection")
    if set(selection) != {"requested_packages", "package_order"}:
        fail("Homebrew lazy layer selection has unexpected fields")
    exact(
        selection.get("requested_packages"),
        result["requested"],
        "Homebrew lazy layer requested packages",
    )
    report_packages = [
        record(value, f"VFS report package {index}")
        for index, value in enumerate(result["report_packages"])
    ]
    package_order = [
        string(package.get("full_name"), f"VFS report package {index} full name")
        for index, package in enumerate(report_packages)
    ]
    exact(
        selection.get("package_order"),
        package_order,
        "Homebrew lazy layer dependency-first package order",
    )

    expected_package_keys = {
        "name", "full_name", "tap_repository", "tap_name", "tap_commit",
        "version", "arch", "source_status", "metadata_status", "url",
        "sha256", "bytes", "cache_key_sha", "link_manifest",
    }
    expected_packages: list[dict[str, Any]] = []
    for index, package in enumerate(report_packages):
        missing = expected_package_keys - set(package)
        if missing:
            fail(
                f"VFS report package {index} is missing lazy-layer provenance fields: "
                f"{sorted(missing)}"
            )
        expected_packages.append(
            {key: package[key] for key in (
                "name", "full_name", "tap_repository", "tap_name", "tap_commit",
                "version", "arch", "source_status", "metadata_status", "url",
                "sha256", "bytes", "cache_key_sha", "link_manifest",
            )}
        )
    packages = array(descriptor.get("packages"), "Homebrew lazy layer packages")
    for index, value in enumerate(packages):
        package = record(value, f"Homebrew lazy layer package {index}")
        if set(package) != expected_package_keys:
            fail(f"Homebrew lazy layer package {index} has unexpected fields")
    exact(packages, expected_packages, "Homebrew lazy layer package provenance")

    release_tag = f"homebrew-vfs-sha256-{result['image_sha']}"
    release_root = (
        f"https://github.com/{tap_repository}/releases/download/{release_tag}"
    )
    release = record(descriptor.get("release"), "Homebrew lazy layer release")
    if set(release) != {"repository", "tag"}:
        fail("Homebrew lazy layer release has unexpected fields")
    exact(release.get("repository"), tap_repository, "Homebrew lazy layer release repository")
    exact(release.get("tag"), release_tag, "Homebrew lazy layer release tag")

    source_vfs = record(descriptor.get("source_vfs"), "Homebrew lazy layer source VFS")
    if set(source_vfs) != {"asset", "url", "sha256", "bytes"}:
        fail("Homebrew lazy layer source VFS has unexpected fields")
    exact(source_vfs.get("asset"), IMAGE_ASSET, "Homebrew lazy layer source VFS asset")
    exact(
        source_vfs.get("url"),
        f"{release_root}/{IMAGE_ASSET}",
        "Homebrew lazy layer source VFS URL",
    )
    exact(source_vfs.get("sha256"), result["image_sha"], "Homebrew lazy layer source VFS digest")
    exact(source_vfs.get("bytes"), result["image_bytes"], "Homebrew lazy layer source VFS size")

    archive = record(descriptor.get("archive"), "Homebrew lazy layer archive")
    expected_archive_keys = {
        "format", "asset", "url", "sha256", "bytes", "entry_count",
        "uncompressed_bytes",
    }
    if set(archive) != expected_archive_keys:
        fail("Homebrew lazy layer archive has unexpected fields")
    exact(archive.get("format"), "zip", "Homebrew lazy layer archive format")
    exact(archive.get("asset"), LAZY_LAYER_ASSET, "Homebrew lazy layer archive asset")
    exact(
        archive.get("url"),
        f"{release_root}/{LAZY_LAYER_ASSET}",
        "Homebrew lazy layer archive URL",
    )
    exact(
        archive.get("sha256"),
        digest_bytes(archive_value),
        "Homebrew lazy layer archive digest",
    )
    exact(archive.get("bytes"), len(archive_value), "Homebrew lazy layer archive size")

    entries = array(descriptor.get("entries"), "Homebrew lazy layer entries")
    if not entries or len(entries) > MAX_LAZY_LAYER_ENTRIES:
        fail(
            f"Homebrew lazy layer entries must contain 1 to "
            f"{MAX_LAZY_LAYER_ENTRIES} records"
        )
    validated_entries: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    uncompressed_bytes = 0
    for index, value in enumerate(entries):
        entry = record(value, f"Homebrew lazy layer entry {index}")
        entry_type = entry.get("type")
        expected_keys = {"path", "type", "mode", "size"}
        if entry_type == "symlink":
            expected_keys.add("target")
        elif entry_type not in ("directory", "file"):
            fail(f"Homebrew lazy layer entry {index} has an invalid type")
        if set(entry) != expected_keys:
            fail(f"Homebrew lazy layer entry {index} has unexpected fields")
        path = string(
            entry.get("path"),
            f"Homebrew lazy layer entry {index} path",
            maximum=MAX_LAZY_LAYER_PATH_BYTES,
        )
        components = path.split("/")
        if path.startswith("/") or "\\" in path or any(
            component in ("", ".", "..") for component in components
        ):
            fail(f"Homebrew lazy layer entry {index} has an unsafe path")
        if path in seen_paths:
            fail(f"Homebrew lazy layer entry {index} duplicates path {path}")
        seen_paths.add(path)
        mode = integer(entry.get("mode"), f"Homebrew lazy layer entry {index} mode")
        if mode > 0o7777:
            fail(f"Homebrew lazy layer entry {index} mode exceeds POSIX permission bits")
        size = integer(entry.get("size"), f"Homebrew lazy layer entry {index} size")
        if size > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail(f"Homebrew lazy layer entry {index} exceeds the size limit")
        uncompressed_bytes += size
        if uncompressed_bytes > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail("Homebrew lazy layer exceeds the uncompressed size limit")
        if entry_type == "directory" and size != 0:
            fail(f"Homebrew lazy layer directory {path} has nonzero size")
        if entry_type == "symlink":
            target = string(
                entry.get("target"),
                f"Homebrew lazy layer entry {index} target",
                maximum=65_536,
            )
            validated_entries.append({**entry, "target": target})
        else:
            validated_entries.append(entry)
    paths = [entry["path"] for entry in validated_entries]
    if paths != sorted(paths):
        fail("Homebrew lazy layer entries are not in canonical path order")
    exact(
        archive.get("entry_count"),
        len(validated_entries),
        "Homebrew lazy layer archive entry count",
    )
    exact(
        archive.get("uncompressed_bytes"),
        uncompressed_bytes,
        "Homebrew lazy layer archive uncompressed size",
    )
    validate_lazy_layer_zip(archive_value, validated_entries)


def validate_lazy_layer_zip(
    archive_value: bytes, entries: list[dict[str, Any]]
) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(archive_value), "r") as archive:
            if archive.comment:
                fail("Homebrew lazy layer ZIP has a non-empty archive comment")
            infos = archive.infolist()
            expected_names = [
                f"{entry['path']}/" if entry["type"] == "directory" else entry["path"]
                for entry in entries
            ]
            actual_names = [info.filename for info in infos]
            if actual_names != expected_names or len(set(actual_names)) != len(actual_names):
                fail("Homebrew lazy layer ZIP entries differ from the canonical index")
            for index, (info, entry) in enumerate(zip(infos, entries, strict=True)):
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


def validate_bundle_dir(path: Path) -> None:
    if not path.is_dir() or path.is_symlink():
        fail("VFS release handoff must be a real directory")
    names = {entry.name for entry in path.iterdir()}
    if names != EXPECTED_ASSETS:
        fail(f"VFS release handoff has unexpected entries: {sorted(names ^ EXPECTED_ASSETS)}")
    for name in EXPECTED_ASSETS:
        regular_file(
            path / name,
            f"VFS release handoff {name}",
            MAX_VFS_BYTES
            if name in (IMAGE_ASSET, LAZY_LAYER_ASSET)
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
    sources = {
        IMAGE_ASSET: Path(args.image),
        REPORT_ASSET: Path(args.report),
        NODE_ASSET: Path(args.node_evidence),
        BROWSER_ASSET: Path(args.browser_evidence),
        LAZY_LAYER_ASSET: Path(args.lazy_layer),
        LAZY_LAYER_DESCRIPTOR_ASSET: Path(args.lazy_layer_descriptor),
    }
    for name, source in sources.items():
        read_bytes(
            source,
            f"release source {name}",
            MAX_VFS_BYTES
            if name in (IMAGE_ASSET, LAZY_LAYER_ASSET)
            else MAX_JSON_BYTES,
        )
        shutil.copyfile(source, output / name, follow_symlinks=False)
    result = validate_evidence(**common_kwargs(args, output))
    validate_lazy_layer(
        result,
        archive_path=output / LAZY_LAYER_ASSET,
        descriptor_path=output / LAZY_LAYER_DESCRIPTOR_ASSET,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        kandelo_commit=args.kandelo_commit,
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
    validate_bundle_dir(handoff)
    result = validate_evidence(**common_kwargs(args, handoff))
    validate_lazy_layer(
        result,
        archive_path=handoff / LAZY_LAYER_ASSET,
        descriptor_path=handoff / LAZY_LAYER_DESCRIPTOR_ASSET,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        kandelo_commit=args.kandelo_commit,
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
