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
import tempfile
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
DEFERRED_TREE_CAPABILITY_RE = re.compile(r"^[a-z0-9][a-z0-9:._-]*$")
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAP_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
GITHUB_RELEASE_URL_RE = re.compile(
    r"^https://github\.com(?::443)?/"
    r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*/releases/download/"
    r"[A-Za-z0-9][A-Za-z0-9._@+=,-]*/[A-Za-z0-9][A-Za-z0-9._@+=,-]*$"
)
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
RUNTIME_LAYER_TAG_PREFIX = "homebrew-runtime-layer-sha256-"
MAX_LAZY_LAYER_ENTRIES = 100_000
MAX_LAZY_LAYER_PATH_BYTES = 4096
MAX_LAZY_LAYER_PACKAGES = 512
MAX_LAZY_LAYER_TREES = 512
MAX_LAZY_LAYER_TAP_LOCKS = 32
MAX_LAZY_LAYER_PACKAGE_NAME_BYTES = 255
MAX_LAZY_LAYER_REPOSITORY_BYTES = 512
MAX_LAZY_LAYER_REQUESTED_PACKAGES = 128
MAX_LAZY_LAYER_TRANSPORTS_PER_TREE = 8
MAX_LAZY_LAYER_ACTIVATION_CAPABILITIES = 32
MAX_LAZY_LAYER_ACTIVATION_ROOTS = 64
MAX_LAZY_LAYER_ACTIVATION_CAPABILITY_BYTES = 255
MAX_RELEASE_ASSET_NAME_BYTES = 255
MAX_LAZY_LAYER_RUNTIME_ID_BYTES = (
    MAX_RELEASE_ASSET_NAME_BYTES
    - len("kandelo-homebrew-")
    - len("-layer.json")
)
MAX_LAZY_LAYER_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_LAZY_LAYER_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew"
MAX_BOTTLE_CHANGED_FILES = 100_000
HOMEBREW_REPLACEMENTS = (
    (b"@@HOMEBREW_PREFIX@@", HOMEBREW_PREFIX.encode()),
    (b"@@HOMEBREW_CELLAR@@", f"{HOMEBREW_PREFIX}/Cellar".encode()),
    (b"@@HOMEBREW_REPOSITORY@@", HOMEBREW_PREFIX.encode()),
    (b"@@HOMEBREW_LIBRARY@@", f"{HOMEBREW_PREFIX}/Library".encode()),
    (b"@@HOMEBREW_PERL@@", f"{HOMEBREW_PREFIX}/opt/perl/bin/perl".encode()),
)
HOMEBREW_JAVA_PLACEHOLDER = b"@@HOMEBREW_JAVA@@"
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
    if (
        len(runtime_id.encode("utf-8")) > MAX_LAZY_LAYER_RUNTIME_ID_BYTES
        or not RUNTIME_LAYER_ID_RE.fullmatch(runtime_id)
    ):
        fail("Homebrew lazy layer runtime id is invalid")
    prefix = f"kandelo-homebrew-{runtime_id}-layer"
    return f"{prefix}.bin", f"{prefix}.json"


def expected_assets(runtime_id: str, tree_assets: list[str]) -> set[str]:
    _, descriptor = lazy_layer_asset_names(runtime_id)
    return {
        IMAGE_ASSET,
        REPORT_ASSET,
        NODE_ASSET,
        BROWSER_ASSET,
        DESCRIPTOR_ASSET,
        descriptor,
        *tree_assets,
    }


def deferred_tree_asset_names(
    descriptor: dict[str, Any], runtime_id: str
) -> list[str]:
    """Return the exact ordered payload names from an untrusted descriptor."""
    trees = array(descriptor.get("deferred_trees"), "Homebrew deferred trees")
    if not trees or len(trees) > MAX_LAZY_LAYER_TREES:
        fail(
            "Homebrew deferred trees must contain 1 to "
            f"{MAX_LAZY_LAYER_TREES} records"
        )
    assets: list[str] = []
    ids: list[str] = []
    reserved = expected_assets(runtime_id, [])
    for index, value in enumerate(trees):
        tree = record(value, f"Homebrew deferred tree {index}")
        tree_id = string(
            tree.get("id"),
            f"Homebrew deferred tree {index} id",
            maximum=MAX_LAZY_LAYER_RUNTIME_ID_BYTES,
        )
        if RUNTIME_LAYER_ID_RE.fullmatch(tree_id) is None:
            fail(f"Homebrew deferred tree {index} id is invalid")
        release_assets: list[str] = []
        for transport_value in array(
            tree.get("transports"), f"Homebrew deferred tree {index} transports"
        ):
            transport = record(
                transport_value, f"Homebrew deferred tree {index} transport"
            )
            if transport.get("kind") != "bundle-release":
                continue
            asset = string(
                transport.get("asset"),
                f"Homebrew deferred tree {index} release asset",
                maximum=MAX_RELEASE_ASSET_NAME_BYTES,
            )
            if ASSET_RE.fullmatch(asset) is None:
                fail(f"Homebrew deferred tree {index} release asset is unsafe")
            release_assets.append(asset)
        if len(release_assets) != 1:
            fail("Homebrew deferred tree must have exactly one bundle release transport")
        if release_assets[0] in reserved:
            fail("Homebrew deferred tree asset collides with bundle metadata")
        ids.append(tree_id)
        assets.append(release_assets[0])
    if ids != sorted(ids) or len(set(ids)) != len(ids):
        fail("Homebrew deferred trees are not canonical")
    if len(set(assets)) != len(assets):
        fail("Homebrew deferred trees reuse a bundle release asset")
    root_asset, _ = lazy_layer_asset_names(runtime_id)
    if root_asset not in assets:
        fail("Homebrew deferred trees omit the runtime root asset")
    return assets


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
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty string no larger than {maximum} bytes")
    if has_lone_unicode_surrogate(value):
        fail(f"{label} must contain only Unicode scalar values")
    if len(value.encode("utf-8")) > maximum:
        fail(f"{label} must be a non-empty string no larger than {maximum} bytes")
    if "\0" in value:
        fail(f"{label} must not contain NUL")
    return value


def has_lone_unicode_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def assert_json_unicode_scalars(value: Any, label: str) -> None:
    if isinstance(value, str):
        if has_lone_unicode_surrogate(value):
            fail(f"{label} must contain only Unicode scalar values")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_json_unicode_scalars(item, f"{label}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if has_lone_unicode_surrogate(key):
                fail(f"{label} key must contain only Unicode scalar values")
            assert_json_unicode_scalars(item, f"{label}.{key}")


def integer(
    value: Any,
    label: str,
    *,
    minimum: int = 0,
    maximum: int = TAR_MAX_SAFE_INTEGER,
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        fail(
            f"{label} must be a safe integer between {minimum} and {maximum}"
        )
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


def tap_checkout_map(args: argparse.Namespace) -> dict[str, dict[str, Any]]:
    tap_name = repository(args.tap_name, "primary tap name")
    tap_repository = repository(args.tap_repository, "primary tap repository")
    tap_commit = commit(string(args.tap_commit, "primary tap commit"), "primary tap commit")
    primary_root = Path(args.tap_root)
    result: dict[str, dict[str, Any]] = {
        tap_name: {
            "name": tap_name,
            "repository": tap_repository,
            "root": primary_root,
            "commit": tap_commit,
            "primary": True,
        }
    }
    for index, raw in enumerate(args.dependency_tap_root):
        binding = string(raw, f"dependency tap root {index}", maximum=16 * 1024)
        if "=" not in binding:
            fail(f"dependency tap root {index} must be TAP-NAME=PATH")
        name_value, path_value = binding.split("=", 1)
        name = repository(name_value, f"dependency tap root {index} name")
        if name in result:
            fail(f"dependency tap root {index} duplicates tap {name}")
        path_text = string(path_value, f"dependency tap root {index} path", maximum=8192)
        root = Path(path_text)
        if not root.is_dir() or root.is_symlink():
            fail(f"dependency tap root {index} must be a real directory")
        checkout_commit = git(root, "rev-parse", "HEAD")
        commit(checkout_commit, f"dependency tap root {index} commit")
        if git(root, "status", "--short", "--untracked-files=all"):
            fail(f"dependency tap root {index} is not clean")
        result[name] = {
            "name": name,
            "root": root,
            "commit": checkout_commit,
            "primary": False,
        }
    return result


def tap_file(
    tap_root: Path,
    relative: Any,
    label: str,
    max_bytes: int,
    *,
    path_maximum: int = 255,
) -> Path:
    value = string(relative, f"{label} path", maximum=path_maximum)
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


def validate_link_manifest_contract(
    tap_root: Path,
    package: dict[str, Any],
    label: str,
    expected_abi: int,
) -> dict[str, Any]:
    manifest_path = tap_file(
        tap_root,
        package.get("link_manifest"),
        f"{label} reviewed link manifest",
        16 * 1024 * 1024,
        path_maximum=MAX_LAZY_LAYER_PATH_BYTES,
    )
    manifest_value, _ = read_json(manifest_path, f"{label} reviewed link manifest")
    manifest = record(manifest_value, f"{label} reviewed link manifest")
    required = {
        "schema", "package", "version", "arch", "kandelo_abi", "prefix",
        "cellar", "keg", "bottle", "links", "receipts", "env",
    }
    if set(manifest) != required:
        fail(f"{label} reviewed link manifest has unexpected or missing fields")
    exact(manifest.get("schema"), 1, f"{label} reviewed link manifest schema")
    exact(manifest.get("package"), package.get("name"), f"{label} reviewed package")
    exact(manifest.get("version"), package.get("version"), f"{label} reviewed version")
    exact(manifest.get("arch"), package.get("arch"), f"{label} reviewed architecture")
    exact(manifest.get("kandelo_abi"), expected_abi, f"{label} reviewed Kandelo ABI")
    exact(manifest.get("prefix"), package.get("prefix"), f"{label} reviewed prefix")
    exact(manifest.get("keg"), package.get("keg"), f"{label} reviewed keg")
    cellar = string(manifest.get("cellar"), f"{label} reviewed cellar", maximum=4096)
    if GUEST_PATH_RE.fullmatch(cellar) is None or not package["keg"].startswith(f"{cellar}/"):
        fail(f"{label} reviewed cellar is invalid")
    bottle = record(manifest.get("bottle"), f"{label} reviewed bottle")
    if set(bottle) != {"url", "sha256", "bytes", "cache_key_sha", "payload_root"}:
        fail(f"{label} reviewed bottle has unexpected or missing fields")
    exact(bottle.get("url"), package.get("url"), f"{label} reviewed bottle URL")
    exact(bottle.get("sha256"), package.get("sha256"), f"{label} reviewed bottle digest")
    exact(bottle.get("bytes"), package.get("bytes"), f"{label} reviewed bottle size")
    exact(
        bottle.get("cache_key_sha"),
        package.get("cache_key_sha"),
        f"{label} reviewed bottle cache key",
    )
    payload_root = safe_relative_path(
        bottle.get("payload_root"), f"{label} reviewed bottle payload root"
    )
    manifest_by_target: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(array(manifest.get("links"), f"{label} reviewed links")):
        link = record(raw, f"{label} reviewed link {index}")
        allowed = {"type", "source", "target", "mode"}
        if set(link) - allowed or not {"type", "source", "target"}.issubset(link):
            fail(f"{label} reviewed link {index} has unexpected or missing fields")
        if link.get("type") not in ("symlink", "directory", "file"):
            fail(f"{label} reviewed link {index} type is invalid")
        source = safe_relative_path(link.get("source"), f"{label} reviewed link {index} source")
        target = safe_relative_path(link.get("target"), f"{label} reviewed link {index} target")
        if target in manifest_by_target:
            fail(f"{label} reviewed links duplicate target {target}")
        mode: int | None = None
        if "mode" in link:
            mode_text = string(link.get("mode"), f"{label} reviewed link {index} mode", maximum=4)
            if re.fullmatch(r"[0-7]{4}", mode_text) is None:
                fail(f"{label} reviewed link {index} mode is invalid")
            mode = int(mode_text, 8)
        manifest_by_target[target] = {
            "index": index,
            "type": link["type"],
            "source": source,
            "target": target,
            **({} if mode is None else {"mode": mode}),
        }

    receipts = [
        safe_relative_path(value, f"{label} reviewed receipt {index}")
        for index, value in enumerate(array(manifest.get("receipts"), f"{label} reviewed receipts"))
    ]
    if not receipts or len(set(receipts)) != len(receipts):
        fail(f"{label} reviewed receipts are empty or duplicated")
    exact(package.get("receipts"), receipts, f"{label} applied receipts")
    env = record(manifest.get("env"), f"{label} reviewed environment")
    if set(env) - {"PATH_prepend"}:
        fail(f"{label} reviewed environment has unexpected fields")
    path_prepend = [
        safe_relative_path(value, f"{label} PATH entry {index}")
        for index, value in enumerate(array(env.get("PATH_prepend", []), f"{label} PATH entries"))
    ]
    if len(set(path_prepend)) != len(path_prepend):
        fail(f"{label} PATH entries are duplicated")
    links: list[dict[str, Any]] = []
    for reviewed in manifest_by_target.values():
        links.append({
            "type": reviewed["type"],
            "index": reviewed["index"],
            "source": reviewed["source"],
            "target": reviewed["target"],
            "mode_override": reviewed.get("mode"),
        })
    return {
        "cellar": cellar,
        "payload_root": payload_root,
        "links": links,
        "receipts": receipts,
    }


def reconstruct_applied_link_contracts(
    report: dict[str, Any],
    report_packages: list[dict[str, Any]],
    manifest_contracts: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Reconstruct the exact eager link result from manifests and conflicts."""
    owners_by_path: dict[str, list[str]] = {}
    target_by_path: dict[str, str] = {}
    for package in report_packages:
        full_name = full_package_name(package.get("full_name"), "VFS report package full name")
        prefix = string(
            package.get("prefix"),
            f"VFS report package {full_name} prefix",
            maximum=MAX_LAZY_LAYER_PATH_BYTES,
        )
        if GUEST_PATH_RE.fullmatch(prefix) is None:
            fail(f"VFS report package {full_name} prefix is invalid")
        contract = manifest_contracts[full_name]
        for link in contract["links"]:
            path = f"{prefix}/{link['target']}"
            prior_target = target_by_path.setdefault(path, link["target"])
            if prior_target != link["target"]:
                fail(f"VFS report link conflict at {path} has inconsistent targets")
            owners_by_path.setdefault(path, []).append(full_name)

    conflict_paths = [
        path for path, owners in owners_by_path.items() if len(owners) > 1
    ]
    has_conflicts = "link_conflicts" in report
    if bool(conflict_paths) != has_conflicts:
        fail("VFS report link_conflicts presence differs from exact manifest conflicts")
    raw_conflicts = array(
        report.get("link_conflicts", []), "VFS report link conflicts"
    )
    if len(raw_conflicts) != len(conflict_paths):
        fail("VFS report link conflicts do not exactly cover manifest conflicts")

    conflicts: list[dict[str, Any]] = []
    conflict_by_path: dict[str, dict[str, Any]] = {}
    for index, (raw, expected_path) in enumerate(zip(raw_conflicts, conflict_paths, strict=True)):
        conflict = record(raw, f"VFS report link conflict {index}")
        if set(conflict) != {
            "path", "target", "owners", "selected_package", "skipped_packages",
            "reason", "resolution",
        }:
            fail(f"VFS report link conflict {index} has unexpected fields")
        path = string(
            conflict.get("path"),
            f"VFS report link conflict {index} path",
            maximum=MAX_LAZY_LAYER_PATH_BYTES,
        )
        if GUEST_PATH_RE.fullmatch(path) is None:
            fail(f"VFS report link conflict {index} path is invalid")
        exact(path, expected_path, f"VFS report link conflict {index} path")
        target = safe_relative_path(
            conflict.get("target"), f"VFS report link conflict {index} target"
        )
        exact(
            target,
            target_by_path[expected_path],
            f"VFS report link conflict {index} target",
        )
        owners = [
            full_package_name(value, f"VFS report link conflict {index} owner {owner_index}")
            for owner_index, value in enumerate(
                bounded_array(
                    conflict.get("owners"),
                    f"VFS report link conflict {index} owners",
                    minimum=2,
                    maximum=MAX_LAZY_LAYER_PACKAGES,
                )
            )
        ]
        exact(owners, owners_by_path[expected_path], f"VFS report link conflict {index} owners")
        selected = full_package_name(
            conflict.get("selected_package"),
            f"VFS report link conflict {index} selected package",
        )
        if selected not in owners:
            fail(f"VFS report link conflict {index} selects a non-owner")
        skipped = [
            full_package_name(
                value, f"VFS report link conflict {index} skipped package {skip_index}"
            )
            for skip_index, value in enumerate(
                bounded_array(
                    conflict.get("skipped_packages"),
                    f"VFS report link conflict {index} skipped packages",
                    minimum=1,
                    maximum=MAX_LAZY_LAYER_PACKAGES,
                )
            )
        ]
        exact(
            skipped,
            [owner for owner in owners if owner != selected],
            f"VFS report link conflict {index} skipped packages",
        )
        reason = string(
            conflict.get("reason"), f"VFS report link conflict {index} reason"
        )
        if not reason.strip():
            fail(f"VFS report link conflict {index} reason is empty")
        exact(
            conflict.get("resolution"),
            "migration-lock",
            f"VFS report link conflict {index} resolution",
        )
        validated = {
            "path": path,
            "target": target,
            "owners": owners,
            "selected_package": selected,
            "skipped_packages": skipped,
            "reason": reason,
            "resolution": "migration-lock",
        }
        conflicts.append(validated)
        conflict_by_path[path] = validated

    applied_contracts: dict[str, dict[str, Any]] = {}
    for package in report_packages:
        full_name = package["full_name"]
        prefix = package["prefix"]
        contract = manifest_contracts[full_name]
        applied_links = [
            link for link in contract["links"]
            if (
                (conflict := conflict_by_path.get(f"{prefix}/{link['target']}")) is None
                or conflict["selected_package"] == full_name
            )
        ]
        exact(
            package.get("links"),
            [link["target"] for link in applied_links],
            f"VFS report package {full_name} applied links",
        )
        applied_contracts[full_name] = {**contract, "links": applied_links}
    return applied_contracts, conflicts


def resolve_original_bottle_guest_source(
    entries_by_path: dict[str, dict[str, Any]],
    start: str,
    tree_id: str,
) -> dict[str, Any]:
    current = start
    seen: set[str] = set()
    while True:
        if current in seen:
            fail(f"Homebrew deferred tree {tree_id} source link cycle at {current}")
        seen.add(current)
        entry = entries_by_path.get(current)
        if entry is None:
            fail(f"Homebrew deferred tree {tree_id} source link is missing at {current}")
        if entry["type"] == "hardlink":
            current = entry["target"]
            continue
        if entry["type"] != "symlink":
            return entry
        target = entry["target"]
        components: list[str] = [] if target.startswith("/") else current.split("/")[:-1]
        for component in target.split("/"):
            if component in ("", "."):
                continue
            if component == "..":
                if not components:
                    fail(f"Homebrew deferred tree {tree_id} source link escapes its tree")
                components.pop()
            else:
                components.append(component)
        current = "/".join(components)


def validate_evidence(
    *,
    image_path: Path,
    report_path: Path,
    node_path: Path,
    browser_path: Path,
    tap_root: Path,
    tap_checkouts: dict[str, dict[str, Any]],
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
    primary_checkout = tap_checkouts.get(tap_name)
    if primary_checkout is None or not primary_checkout["primary"]:
        fail("exact tap checkout map omits the primary tap")
    try:
        exact(
            primary_checkout["root"].resolve(strict=True),
            tap_root.resolve(strict=True),
            "primary tap checkout root",
        )
    except OSError as error:
        fail(f"primary tap checkout cannot be resolved: {error}")
    exact(primary_checkout["repository"], tap_repository, "primary tap checkout repository")
    exact(primary_checkout["commit"], tap_commit, "primary tap checkout commit")
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
    manifest_link_contracts: dict[str, dict[str, Any]] = {}
    for index, raw_package in enumerate(report_values):
        package = record(raw_package, f"VFS report package {index}")
        full_name = full_package_name(
            package.get("full_name"), f"VFS report package {index} full name"
        )
        if full_name in report_packages:
            fail(f"duplicate VFS report package {full_name}")
        report_packages[full_name] = package
        package_tap_name = repository(
            package.get("tap_name"), f"VFS report package {full_name} tap name"
        )
        package_tap_repository = repository(
            package.get("tap_repository"),
            f"VFS report package {full_name} tap repository",
        )
        package_name_value = package_name(
            package.get("name"), f"VFS report package {full_name} name"
        )
        exact(
            full_name,
            f"{package_tap_name}/{package_name_value}",
            f"VFS report package {full_name} full name",
        )
        checkout = tap_checkouts.get(package_tap_name)
        if checkout is None:
            fail(f"VFS report package {full_name} has no exact tap checkout")
        if package_tap_name == tap_name:
            exact(
                package_tap_repository,
                tap_repository,
                f"VFS report package {full_name} primary tap repository",
            )
        manifest_link_contracts[full_name] = validate_link_manifest_contract(
            checkout["root"], package, f"VFS report package {full_name}", abi
        )
    applied_link_contracts, link_conflicts = reconstruct_applied_link_contracts(
        report, report_values, manifest_link_contracts
    )
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
        bottle_repository = string(
            bottle.get("tap_repository"), f"Node bottle {full_name} repository"
        )
        if not REPOSITORY_RE.fullmatch(bottle_repository):
            fail(f"Node bottle {full_name} repository is not owner/repository")
        commit(string(bottle.get("tap_commit"), f"Node bottle {full_name} tap commit"),
               f"Node bottle {full_name} tap commit")
        expected_url = (
            f"https://ghcr.io/v2/{bottle_repository.lower()}/{bottle_name}/"
            f"blobs/sha256:{bottle_sha}"
        )
        exact(bottle.get("url"), expected_url, f"Node bottle {full_name} URL")
        if full_name.lower() == root_full_name:
            root_seen = True
            exact(bottle_repository, tap_repository, "selected formula tap repository")
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
        "applied_link_contracts": applied_link_contracts,
        "manifest_link_contracts": manifest_link_contracts,
        "link_conflicts": link_conflicts,
        "tap_checkouts": tap_checkouts,
        "root_full_name": root_full_name,
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
    path = string(value, label, maximum=MAX_LAZY_LAYER_PATH_BYTES)
    if path.startswith("/") or "\\" in path or any(
        component in ("", ".", "..") for component in path.split("/")
    ):
        fail(f"{label} is not a safe relative POSIX path")
    return path


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
    name = package_name(package.get("name"), f"{label} name")
    full_name = full_package_name(package.get("full_name"), f"{label} full name")
    tap_repository = repository(package.get("tap_repository"), f"{label} tap repository")
    tap_name = repository(package.get("tap_name"), f"{label} tap name")
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
    string(package.get("version"), f"{label} version", maximum=256)
    string(package.get("metadata_status"), f"{label} metadata status", maximum=256)
    prefix = string(package.get("prefix"), f"{label} prefix", maximum=MAX_LAZY_LAYER_PATH_BYTES)
    exact(prefix, HOMEBREW_PREFIX, f"{label} prefix")
    keg = string(package.get("keg"), f"{label} keg", maximum=MAX_LAZY_LAYER_PATH_BYTES)
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
        repository(
            built_from.get("tap_repository"), f"{label} built_from tap repository"
        )
        commit(
            string(built_from.get("tap_commit"), f"{label} built_from tap commit"),
            f"{label} built_from tap commit",
        )
        repository(
            built_from.get("kandelo_repository"),
            f"{label} built_from Kandelo repository",
        )
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
    string(
        package.get("version"),
        "Homebrew lazy layer base package version",
        maximum=256,
    )
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


def repository(value: Any, label: str) -> str:
    result = string(value, label, maximum=MAX_LAZY_LAYER_REPOSITORY_BYTES)
    if REPOSITORY_RE.fullmatch(result) is None:
        fail(f"{label} is invalid")
    return result


def package_name(value: Any, label: str) -> str:
    result = string(value, label, maximum=MAX_LAZY_LAYER_PACKAGE_NAME_BYTES)
    if FORMULA_RE.fullmatch(result) is None:
        fail(f"{label} is invalid")
    return result


def full_package_name(value: Any, label: str) -> str:
    result = string(value, label, maximum=MAX_LAZY_LAYER_REPOSITORY_BYTES)
    components = result.split("/")
    if len(components) != 3 or any(FORMULA_RE.fullmatch(part) is None for part in components):
        fail(f"{label} is invalid")
    return result


def bounded_array(
    value: Any, label: str, *, minimum: int = 0, maximum: int
) -> list[Any]:
    result = array(value, label)
    if not minimum <= len(result) <= maximum:
        fail(f"{label} must contain {minimum} to {maximum} items")
    return result


def validate_deferred_tree_activation(value: Any, label: str) -> tuple[list[str], list[str]]:
    activation = record(value, label)
    if set(activation) != {"mode", "capabilities", "roots"}:
        fail(f"{label} has unexpected fields")
    if activation.get("mode") not in ("boot-prefetch", "first-use"):
        fail(f"{label} mode is invalid")
    raw_capabilities = array(activation.get("capabilities"), f"{label} capabilities")
    if not 1 <= len(raw_capabilities) <= MAX_LAZY_LAYER_ACTIVATION_CAPABILITIES:
        fail(
            f"{label} capabilities must contain 1 to "
            f"{MAX_LAZY_LAYER_ACTIVATION_CAPABILITIES} items"
        )
    capabilities = [
        string(
            value,
            f"{label} capability {index}",
            maximum=MAX_LAZY_LAYER_ACTIVATION_CAPABILITY_BYTES,
        )
        for index, value in enumerate(raw_capabilities)
    ]
    if (
        capabilities != sorted(capabilities)
        or len(set(capabilities)) != len(capabilities)
        or any(DEFERRED_TREE_CAPABILITY_RE.fullmatch(value) is None for value in capabilities)
    ):
        fail(f"{label} capabilities are invalid")
    raw_roots = array(activation.get("roots"), f"{label} roots")
    if not 1 <= len(raw_roots) <= MAX_LAZY_LAYER_ACTIVATION_ROOTS:
        fail(
            f"{label} roots must contain 1 to "
            f"{MAX_LAZY_LAYER_ACTIVATION_ROOTS} items"
        )
    roots = [
        string(value, f"{label} root {index}", maximum=MAX_LAZY_LAYER_PATH_BYTES)
        for index, value in enumerate(raw_roots)
    ]
    if (
        roots != sorted(roots)
        or len(set(roots)) != len(roots)
        or any(value != "/" and GUEST_PATH_RE.fullmatch(value) is None for value in roots)
    ):
        fail(f"{label} roots are invalid")
    return capabilities, roots


def validate_original_bottle_source(
    value: Any, tree_id: str
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    source = record(value, f"Homebrew deferred tree {tree_id} source inventory")
    if set(source) != {"schema", "kind", "entries"}:
        fail(f"Homebrew deferred tree {tree_id} source inventory has unexpected fields")
    exact(source.get("schema"), 1, f"Homebrew deferred tree {tree_id} source schema")
    exact(
        source.get("kind"),
        "homebrew-bottle-tar-gzip-v1",
        f"Homebrew deferred tree {tree_id} source kind",
    )
    raw_entries = array(
        source.get("entries"), f"Homebrew deferred tree {tree_id} source entries"
    )
    if not raw_entries or len(raw_entries) > MAX_LAZY_LAYER_ENTRIES:
        fail(f"Homebrew deferred tree {tree_id} source inventory has an invalid size")
    entries: list[dict[str, Any]] = []
    by_path: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(raw_entries):
        entry = record(raw, f"Homebrew deferred tree {tree_id} source entry {index}")
        entry_type = entry.get("type")
        expected = {"path", "type", "mode", "size"}
        if entry_type in ("symlink", "hardlink"):
            expected.add("target")
        elif entry_type not in ("directory", "file"):
            fail(f"Homebrew deferred tree {tree_id} source entry {index} has invalid type")
        if set(entry) != expected:
            fail(
                f"Homebrew deferred tree {tree_id} source entry {index} "
                "has unexpected fields"
            )
        path = safe_relative_path(
            entry.get("path"), f"Homebrew deferred tree {tree_id} source entry {index} path"
        )
        if path in by_path:
            fail(f"Homebrew deferred tree {tree_id} source duplicates {path}")
        mode = integer(
            entry.get("mode"), f"Homebrew deferred tree {tree_id} source {path} mode"
        )
        if mode > 0o7777:
            fail(f"Homebrew deferred tree {tree_id} source {path} mode is invalid")
        if entry_type == "symlink" and mode != 0o777:
            fail(
                f"Homebrew deferred tree {tree_id} source {path} "
                "symlink mode must be 0777"
            )
        size = integer(
            entry.get("size"), f"Homebrew deferred tree {tree_id} source {path} size"
        )
        if size > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail(f"Homebrew deferred tree {tree_id} source {path} exceeds the size limit")
        if entry_type != "file" and size != 0:
            fail(f"Homebrew deferred tree {tree_id} source {path} has nonzero link size")
        validated = {"path": path, "type": entry_type, "mode": mode, "size": size}
        if entry_type == "symlink":
            validated["target"] = string(
                entry.get("target"),
                f"Homebrew deferred tree {tree_id} source {path} target",
                maximum=65_536,
            )
        elif entry_type == "hardlink":
            validated["target"] = safe_relative_path(
                entry.get("target"),
                f"Homebrew deferred tree {tree_id} source {path} target",
            )
        entries.append(validated)
        by_path[path] = validated
    paths = [entry["path"] for entry in entries]
    if paths != sorted(paths):
        fail(f"Homebrew deferred tree {tree_id} source inventory is not canonical")

    resolved: dict[str, dict[str, Any]] = {}
    for start in entries:
        if start["type"] != "hardlink" or start["path"] in resolved:
            continue
        chain: list[dict[str, Any]] = []
        seen: set[str] = set()
        cursor = start
        while cursor["type"] == "hardlink":
            path = cursor["path"]
            if path in resolved:
                cursor = resolved[path]
                break
            if path in seen:
                fail(f"Homebrew deferred tree {tree_id} source hardlink cycle reaches {path}")
            seen.add(path)
            chain.append(cursor)
            target = by_path.get(cursor["target"])
            if target is None or target["type"] not in ("file", "hardlink"):
                fail(
                    f"Homebrew deferred tree {tree_id} source hardlink {path} "
                    "target is invalid"
                )
            cursor = target
        if cursor["type"] != "file":
            fail(f"Homebrew deferred tree {tree_id} source hardlink has no regular target")
        for link in chain:
            resolved[link["path"]] = cursor
    return entries, resolved


def parse_homebrew_install_receipt(value: bytes) -> dict[str, Any]:
    try:
        receipt = json.loads(value.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"INSTALL_RECEIPT.json is not valid UTF-8 JSON: {error}")
    if not isinstance(receipt, dict):
        fail("INSTALL_RECEIPT.json must contain an object")
    changed = receipt.get("changed_files", [])
    if not isinstance(changed, list):
        fail("INSTALL_RECEIPT.json changed_files must be an array when present")
    if len(changed) > MAX_BOTTLE_CHANGED_FILES:
        fail(
            f"INSTALL_RECEIPT.json declares {len(changed)} changed files, "
            f"limit {MAX_BOTTLE_CHANGED_FILES}"
        )
    seen: set[str] = set()
    validated: list[str] = []
    for index, path_value in enumerate(changed):
        if not isinstance(path_value, str):
            fail(f"INSTALL_RECEIPT.json changed_files[{index}] is not a string")
        path = safe_relative_path(path_value, "Homebrew changed file")
        if path in seen:
            fail(f"INSTALL_RECEIPT.json repeats changed file {path}")
        seen.add(path)
        validated.append(path)
    return {
        "changed_files": validated,
        "runtime_dependencies": receipt.get("runtime_dependencies"),
    }


def homebrew_java_home(runtime_dependencies: Any) -> bytes | None:
    if not isinstance(runtime_dependencies, list):
        return None
    names: set[str] = set()
    for dependency in runtime_dependencies:
        if not isinstance(dependency, dict):
            continue
        candidate = dependency.get("full_name", dependency.get("name"))
        if not isinstance(candidate, str):
            continue
        name = candidate.rsplit("/", 1)[-1]
        if re.fullmatch(r"openjdk(?:@[^/]+)?", name):
            names.add(name)
    if len(names) != 1:
        return None
    return f"{HOMEBREW_PREFIX}/opt/{next(iter(names))}/libexec".encode()


def relocate_homebrew_bottle_file(
    value: bytes, receipt: dict[str, Any], path: str
) -> bytes:
    relocated = value
    for placeholder, replacement in HOMEBREW_REPLACEMENTS:
        relocated = relocated.replace(placeholder, replacement)
    if HOMEBREW_JAVA_PLACEHOLDER in relocated:
        java_home = homebrew_java_home(receipt.get("runtime_dependencies"))
        if java_home is None:
            fail(
                f"Homebrew changed file {path} uses "
                "@@HOMEBREW_JAVA@@ without exactly one OpenJDK runtime dependency"
            )
        relocated = relocated.replace(HOMEBREW_JAVA_PLACEHOLDER, java_home)
    for placeholder, _ in (*HOMEBREW_REPLACEMENTS, (HOMEBREW_JAVA_PLACEHOLDER, b"")):
        if placeholder in relocated:
            fail(
                f"Homebrew changed file {path} retains "
                f"{placeholder.decode('ascii')}"
            )
    return relocated


def original_bottle_relocation(
    archive_value: bytes,
    source_entries: list[dict[str, Any]],
    canonical_source_by_path: dict[str, dict[str, Any]],
    expanded_bytes: int,
) -> dict[str, Any]:
    source_by_path = {entry["path"]: entry for entry in source_entries}
    receipts = [
        entry for entry in source_entries
        if entry["path"] == "INSTALL_RECEIPT.json"
        or entry["path"].endswith("/INSTALL_RECEIPT.json")
    ]
    if not receipts:
        return {"source_paths": set(), "bytes_by_canonical": {}}
    if len(receipts) > 1:
        fail(
            f"Homebrew deferred bottle has {len(receipts)} INSTALL_RECEIPT.json "
            "source members, expected one"
        )
    receipt_source = receipts[0]
    receipt_canonical = (
        receipt_source if receipt_source["type"] == "file"
        else canonical_source_by_path.get(receipt_source["path"])
    )
    if receipt_canonical is None or receipt_canonical["type"] != "file":
        fail("Homebrew deferred bottle INSTALL_RECEIPT.json is not regular")

    tar_value = decompress_single_lazy_layer_gzip(archive_value, expanded_bytes)
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_value), mode="r:") as archive:
            members = {
                normalize_tar_member_name(member.name): member
                for member in archive.getmembers()
            }

            def regular_bytes(source: dict[str, Any]) -> bytes:
                canonical = (
                    source if source["type"] == "file"
                    else canonical_source_by_path.get(source["path"])
                )
                if canonical is None or canonical["type"] != "file":
                    fail(
                        f"Homebrew deferred bottle changed source {source['path']} "
                        "is not regular"
                    )
                member = members.get(canonical["path"])
                extracted = None if member is None else archive.extractfile(member)
                if extracted is None:
                    fail(
                        f"Homebrew deferred bottle cannot read regular source "
                        f"{canonical['path']}"
                    )
                return extracted.read()

            receipt = parse_homebrew_install_receipt(regular_bytes(receipt_source))
            separator = receipt_source["path"].rfind("/")
            source_root = (
                "" if separator < 0 else receipt_source["path"][:separator]
            )
            source_paths: set[str] = set()
            bytes_by_canonical: dict[str, bytes] = {}
            for relative in receipt["changed_files"]:
                source_path = relative if not source_root else f"{source_root}/{relative}"
                source = source_by_path.get(source_path)
                if source is None or source["type"] not in ("file", "hardlink"):
                    fail(
                        f"Homebrew deferred bottle changed source {source_path} "
                        "is missing or not regular"
                    )
                canonical = (
                    source if source["type"] == "file"
                    else canonical_source_by_path.get(source["path"])
                )
                assert canonical is not None
                relocated = relocate_homebrew_bottle_file(
                    regular_bytes(source), receipt, source_path
                )
                prior = bytes_by_canonical.get(canonical["path"])
                if prior is not None and prior != relocated:
                    fail("Homebrew hard-link aliases produce different relocated bytes")
                source_paths.add(source_path)
                bytes_by_canonical[canonical["path"]] = relocated
            return {
                "source_paths": source_paths,
                "bytes_by_canonical": bytes_by_canonical,
            }
    except tarfile.TarError as error:
        fail(f"Homebrew deferred TAR is invalid: {error}")


def validate_original_bottle_inventory(
    value: Any,
    *,
    tree_id: str,
    archive_value: bytes,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, Any],
]:
    inventory = record(value, f"Homebrew deferred tree {tree_id} inventory")
    expected_inventory = {
        "entry_count", "source_entry_count", "regular_inode_count",
        "layer_entry_count", "mergeable_directory_count", "expanded_bytes",
        "payload_bytes", "source", "entries",
    }
    if set(inventory) != expected_inventory:
        fail(f"Homebrew deferred tree {tree_id} inventory has unexpected fields")
    source_entries, canonical_source_by_path = validate_original_bottle_source(
        inventory.get("source"), tree_id
    )
    expanded_bytes = integer(
        inventory.get("expanded_bytes"), f"Homebrew deferred tree {tree_id} expanded bytes"
    )
    if expanded_bytes > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
        fail(f"Homebrew deferred tree {tree_id} expansion bound is invalid")
    relocation = original_bottle_relocation(
        archive_value,
        source_entries,
        canonical_source_by_path,
        expanded_bytes,
    )
    source_by_path = {entry["path"]: entry for entry in source_entries}
    raw_entries = array(inventory.get("entries"), f"Homebrew deferred tree {tree_id} entries")
    if not raw_entries or len(raw_entries) > MAX_LAZY_LAYER_ENTRIES:
        fail(f"Homebrew deferred tree {tree_id} entries have an invalid size")
    entries: list[dict[str, Any]] = []
    by_path: dict[str, dict[str, Any]] = {}
    decoded_payload_bytes = 0
    payload_bytes = 0
    layer_count = 0
    mergeable_count = 0
    has_payload = False
    for index, raw in enumerate(raw_entries):
        entry = record(raw, f"Homebrew deferred tree {tree_id} entry {index}")
        entry_type = entry.get("type")
        expected = {
            "path", "source_path", "materialization", "type", "ownership",
            "mode", "size",
        }
        if entry_type == "symlink":
            expected.add("target")
        elif entry_type == "file":
            expected.add("inode_group")
        elif entry_type == "hardlink":
            expected.update(("target", "inode_group"))
        elif entry_type != "directory":
            fail(f"Homebrew deferred tree {tree_id} entry {index} has invalid type")
        if set(entry) != expected:
            fail(f"Homebrew deferred tree {tree_id} entry {index} has unexpected fields")
        path = safe_relative_path(
            entry.get("path"), f"Homebrew deferred tree {tree_id} entry {index} path"
        )
        if path != HOMEBREW_PREFIX[1:] and not path.startswith(f"{HOMEBREW_PREFIX[1:]}/"):
            fail(f"Homebrew deferred tree {tree_id} entry {index} escapes Homebrew")
        if path in by_path:
            fail(f"Homebrew deferred tree {tree_id} duplicates guest path {path}")
        source_path = safe_relative_path(
            entry.get("source_path"),
            f"Homebrew deferred tree {tree_id} entry {index} source path",
        )
        materialization = entry.get("materialization")
        if materialization not in (
            "archive", "archive-homebrew-relocate", "archive-copy",
            "archive-copy-mode", "descriptor"
        ):
            fail(f"Homebrew deferred tree {tree_id} entry {index} materialization is invalid")
        ownership = entry.get("ownership")
        if ownership not in ("layer", "mergeable-directory"):
            fail(f"Homebrew deferred tree {tree_id} entry {index} ownership is invalid")
        if ownership == "mergeable-directory" and entry_type != "directory":
            fail(f"Homebrew deferred tree {tree_id} merges a non-directory")
        mode = integer(
            entry.get("mode"), f"Homebrew deferred tree {tree_id} entry {index} mode"
        )
        if mode > 0o7777:
            fail(f"Homebrew deferred tree {tree_id} entry {index} mode is invalid")
        if entry_type == "symlink" and materialization == "archive" and mode != 0o777:
            fail(
                f"Homebrew deferred tree {tree_id} archive symlink {path} "
                "mode must be 0777"
            )
        size = integer(
            entry.get("size"), f"Homebrew deferred tree {tree_id} entry {index} size"
        )
        if size > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail(f"Homebrew deferred tree {tree_id} entry {index} exceeds the size limit")
        if entry_type == "directory" and size != 0:
            fail(f"Homebrew deferred tree {tree_id} directory {path} has nonzero size")
        validated = {
            "path": path,
            "source_path": source_path,
            "materialization": materialization,
            "type": entry_type,
            "ownership": ownership,
            "mode": mode,
            "size": size,
        }
        if entry_type == "symlink":
            target = string(
                entry.get("target"),
                f"Homebrew deferred tree {tree_id} entry {index} target",
                maximum=65_536,
            )
            if len(target.encode("utf-8")) != size:
                fail(f"Homebrew deferred tree {tree_id} symlink {path} size differs")
            validated["target"] = target
        elif entry_type in ("file", "hardlink"):
            validated["inode_group"] = string(
                entry.get("inode_group"),
                f"Homebrew deferred tree {tree_id} entry {index} inode group",
                maximum=MAX_LAZY_LAYER_PATH_BYTES,
            )
            if entry_type == "hardlink":
                validated["target"] = safe_relative_path(
                    entry.get("target"),
                    f"Homebrew deferred tree {tree_id} entry {index} target",
                )
        source = source_by_path.get(source_path)
        if materialization == "descriptor":
            if entry_type not in ("directory", "symlink") or source is not None:
                fail(f"Homebrew deferred tree {tree_id} descriptor entry {path} is invalid")
        elif source is None:
            fail(f"Homebrew deferred tree {tree_id} entry {path} source is absent")
        elif materialization in ("archive-copy", "archive-copy-mode"):
            if (
                entry_type != "file"
                or source["type"] != "file"
                or materialization == "archive-copy" and source["mode"] != mode
            ):
                fail(f"Homebrew deferred tree {tree_id} archive copy {path} differs")
        elif materialization == "archive-homebrew-relocate":
            if (
                entry_type not in ("file", "hardlink")
                or source["type"] != entry_type
                or entry_type == "file" and source["mode"] != mode
            ):
                fail(
                    f"Homebrew deferred tree {tree_id} receipt-relocated "
                    f"entry {path} differs"
                )
        elif (
            source["type"] != entry_type
            or entry_type == "symlink" and source.get("target") != validated.get("target")
            or entry_type != "hardlink" and source["mode"] != mode
        ):
            fail(f"Homebrew deferred tree {tree_id} archive entry {path} differs")
        if entry_type != "hardlink":
            decoded_payload_bytes += size
        if entry_type == "file":
            payload_bytes += size
        if max(decoded_payload_bytes, payload_bytes) > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES:
            fail(f"Homebrew deferred tree {tree_id} exceeds the payload size limit")
        if ownership == "layer":
            layer_count += 1
            has_payload = has_payload or entry_type != "directory"
        else:
            mergeable_count += 1
        entries.append(validated)
        by_path[path] = validated
    relocation_markers = {
        entry["source_path"] for entry in entries
        if entry["materialization"] == "archive-homebrew-relocate"
    }
    if relocation_markers != relocation["source_paths"]:
        fail(
            f"Homebrew deferred tree {tree_id} relocation markers differ "
            "from INSTALL_RECEIPT.json"
        )
    relocated_canonical_paths = set(relocation["bytes_by_canonical"])
    for entry in entries:
        if entry["materialization"] == "descriptor" or entry["type"] not in (
            "file", "hardlink"
        ):
            continue
        source = source_by_path[entry["source_path"]]
        canonical = (
            source if source["type"] == "file"
            else canonical_source_by_path.get(source["path"])
        )
        if canonical is None or canonical["type"] != "file":
            fail(f"Homebrew deferred tree {tree_id} regular source is unresolved")
        expected_size = (
            len(relocation["bytes_by_canonical"][canonical["path"]])
            if canonical["path"] in relocated_canonical_paths
            else canonical["size"]
        )
        if entry["size"] != expected_size:
            fail(f"Homebrew deferred tree {tree_id} archive entry {entry['path']} differs")
    if not has_payload:
        fail(f"Homebrew deferred tree {tree_id} has no layer-owned payload")
    paths = [entry["path"] for entry in entries]
    if paths != sorted(paths):
        fail(f"Homebrew deferred tree {tree_id} entries are not canonical")
    for entry in entries:
        components = entry["path"].split("/")
        for length in range(1, len(components)):
            ancestor = by_path.get("/".join(components[:length]))
            if ancestor is not None and ancestor["type"] != "directory":
                fail(f"Homebrew deferred tree {tree_id} descends through a non-directory")
    canonical_groups = resolve_lazy_layer_hardlinks(entries)
    for entry in entries:
        if entry["type"] != "hardlink" or entry["materialization"] not in (
            "archive", "archive-homebrew-relocate"
        ):
            continue
        source = source_by_path[entry["source_path"]]
        target = by_path.get(entry["target"])
        regular_source = canonical_source_by_path.get(source["path"])
        if (
            target is None
            or source.get("target") != target["source_path"]
            or regular_source is None
            or regular_source["type"] != "file"
            or regular_source["mode"] != entry["mode"]
            or target["mode"] != entry["mode"]
        ):
            fail(f"Homebrew deferred tree {tree_id} hardlink {entry['path']} differs")
    exact(inventory.get("entry_count"), len(entries), f"Homebrew deferred tree {tree_id} entry count")
    exact(
        inventory.get("source_entry_count"),
        len(source_entries),
        f"Homebrew deferred tree {tree_id} source count",
    )
    exact(
        inventory.get("regular_inode_count"),
        len(canonical_groups),
        f"Homebrew deferred tree {tree_id} inode count",
    )
    exact(inventory.get("layer_entry_count"), layer_count, f"Homebrew deferred tree {tree_id} layer count")
    exact(
        inventory.get("mergeable_directory_count"),
        mergeable_count,
        f"Homebrew deferred tree {tree_id} mergeable directory count",
    )
    exact(inventory.get("payload_bytes"), payload_bytes, f"Homebrew deferred tree {tree_id} payload bytes")
    validate_lazy_layer_tar_gzip(archive_value, source_entries, expanded_bytes)
    return entries, source_entries, canonical_source_by_path, relocation


def expected_original_bottle_tree_id(
    package: dict[str, Any], runtime_id: str, root_full_name: str
) -> str:
    if package["full_name"] == root_full_name:
        return runtime_id
    slug = re.sub(r"[^a-z0-9]+", "-", package["name"]).strip("-") or "package"
    suffix = f"-{digest_bytes(package['full_name'].encode('utf-8'))[:16]}"
    prefix = "bottle-"
    maximum_slug = MAX_LAZY_LAYER_RUNTIME_ID_BYTES - len(prefix) - len(suffix)
    return f"{prefix}{slug[:maximum_slug]}{suffix}"


def original_bottle_payload_asset(tree_id: str) -> str:
    return f"kandelo-homebrew-{tree_id}-layer.bin"


def map_original_bottle_source_to_guest(
    package: dict[str, Any], payload_root: str, source_path: str
) -> str | None:
    if source_path == payload_root:
        return None
    if source_path.startswith(f"{payload_root}/"):
        return f"{package['keg'].removeprefix('/')}/{source_path[len(payload_root) + 1:]}"
    if source_path == "Cellar" or source_path.startswith("Cellar/"):
        return f"{package['prefix'].removeprefix('/')}/{source_path}"
    return f"{package['keg'].removeprefix('/')}/{source_path}"


def validate_original_bottle_symlink_target(
    package: dict[str, Any], guest_path: str, target: str, tree_id: str
) -> None:
    if not target or target.startswith("/") or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
        fail(f"Homebrew deferred tree {tree_id} archive symlink target is non-relative")
    components = guest_path.split("/")[:-1]
    for component in target.split("/"):
        if component in ("", "."):
            continue
        if component == "..":
            if not components:
                fail(f"Homebrew deferred tree {tree_id} archive symlink escapes its keg")
            components.pop()
        else:
            components.append(component)
    normalized = "/".join(components)
    keg = package["keg"].removeprefix("/")
    if normalized != keg and not normalized.startswith(f"{keg}/"):
        fail(f"Homebrew deferred tree {tree_id} archive symlink escapes its keg")


def expected_descriptor_source_path(
    tree_id: str, suffix: str, reserved: set[str]
) -> str:
    base = f".kandelo-descriptor/{tree_id}/{suffix}"
    candidate = base
    index = 1
    while candidate in reserved:
        candidate = f"{base}-{index}"
        index += 1
    reserved.add(candidate)
    return candidate


def expected_inode_group(tree_id: str, kind: str, path: str) -> str:
    return f"{tree_id}:{kind}:{digest_bytes(path.encode('utf-8'))}"


def expected_external_bottle_transport(package: dict[str, Any]) -> dict[str, str] | None:
    value = package["url"]
    if GITHUB_RELEASE_URL_RE.fullmatch(value) is None:
        return None
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        return None
    return {"kind": "external-https", "url": value}


def entry_ownership(
    package: dict[str, Any], path: str, entry_type: str
) -> str:
    keg = package["keg"].removeprefix("/")
    if entry_type == "directory" and path != keg and not path.startswith(f"{keg}/"):
        return "mergeable-directory"
    return "layer"


def validate_canonical_original_bottle_trees(
    tree_data: list[dict[str, Any]],
    *,
    layer_packages: list[dict[str, Any]],
    link_contracts: dict[str, dict[str, Any]],
    runtime_id: str,
    root_full_name: str,
    draft: bool,
    release_root: str | None,
) -> None:
    data_by_package = {item["package"]["full_name"]: item for item in tree_data}
    root_packages = [package for package in layer_packages if package["full_name"] == root_full_name]
    if len(root_packages) != 1:
        fail("Homebrew original bottle root package differs from the selected runtime")

    expected_ids = {
        package["full_name"]: expected_original_bottle_tree_id(
            package, runtime_id, root_full_name
        )
        for package in layer_packages
    }
    if len(set(expected_ids.values())) != len(expected_ids):
        fail("Homebrew original bottle canonical tree identities collide")

    expected_by_package: dict[str, dict[str, dict[str, Any]]] = {
        package["full_name"]: {} for package in layer_packages
    }
    source_guests: dict[str, dict[str, str]] = {}
    assigned_sources: dict[str, tuple[str, dict[str, Any]]] = {}
    reserved_sources: dict[str, set[str]] = {}

    # This is the producer's exact package-order source projection. The first
    # package owns a shared source directory; every non-directory overlap is an
    # invalid pour rather than an order-dependent winner.
    for package in layer_packages:
        full_name = package["full_name"]
        data = data_by_package.get(full_name)
        contract = link_contracts.get(full_name)
        if data is None or contract is None:
            fail(f"Homebrew original bottle lacks canonical inputs for {full_name}")
        tree_id = expected_ids[full_name]
        if data["tree_id"] != tree_id:
            fail(f"Homebrew deferred tree for {full_name} has a non-canonical id")
        reserved_sources[full_name] = {entry["path"] for entry in data["source_entries"]}
        guests: dict[str, str] = {}
        for source in data["source_entries"]:
            guest = map_original_bottle_source_to_guest(
                package, contract["payload_root"], source["path"]
            )
            if guest is None:
                continue
            if source["type"] == "symlink":
                validate_original_bottle_symlink_target(
                    package, guest, source["target"], tree_id
                )
            guests[source["path"]] = guest
            prior = assigned_sources.get(guest)
            if prior is not None:
                if source["type"] == "directory" and prior[1]["type"] == "directory":
                    if source["mode"] != prior[1]["mode"]:
                        fail(
                            "Homebrew original bottles assign different modes "
                            f"to directory /{guest}"
                        )
                    continue
                fail(f"Homebrew original bottles overlap at /{guest}")
            assigned_sources[guest] = (full_name, source)
        source_guests[full_name] = guests

    for guest, (full_name, source) in assigned_sources.items():
        data = data_by_package[full_name]
        tree_id = expected_ids[full_name]
        canonical = data["canonical_source_by_path"].get(source["path"])
        canonical_regular = source if source["type"] == "file" else canonical
        relocated = (
            None if canonical_regular is None
            else data["relocation"]["bytes_by_canonical"].get(canonical_regular["path"])
        )
        expected: dict[str, Any] = {
            "path": guest,
            "source_path": source["path"],
            "materialization": (
                "archive-homebrew-relocate"
                if source["path"] in data["relocation"]["source_paths"]
                else "archive"
            ),
            "type": source["type"],
            "ownership": entry_ownership(data["package"], guest, source["type"]),
            "mode": source["mode"],
            "size": (
                len(relocated)
                if relocated is not None
                else canonical["size"]
                if source["type"] == "hardlink"
                else len(source["target"].encode("utf-8"))
                if source["type"] == "symlink"
                else source["size"]
            ),
        }
        if source["type"] == "symlink":
            expected["target"] = source["target"]
        elif source["type"] == "file":
            expected["inode_group"] = expected_inode_group(
                tree_id, "source", source["path"]
            )
        elif source["type"] == "hardlink":
            if canonical is None:
                fail(f"Homebrew deferred tree {tree_id} hardlink source is unresolved")
            target = source_guests[full_name].get(source["target"])
            if target is None:
                fail(f"Homebrew deferred tree {tree_id} hardlink target is unmapped")
            expected["target"] = target
            expected["mode"] = canonical["mode"]
            expected["inode_group"] = expected_inode_group(
                tree_id, "source", canonical["path"]
            )
        expected_by_package[full_name][guest] = expected

    canonical_poured_namespace = {
        path: entry
        for entries in expected_by_package.values()
        for path, entry in entries.items()
    }
    source_directories: set[str] = set()
    for package in layer_packages:
        prefix = package["prefix"].removeprefix("/")
        source_directories.update((
            prefix,
            link_contracts[package["full_name"]]["cellar"].removeprefix("/"),
            package["keg"].removeprefix("/"),
        ))
    for path in list(canonical_poured_namespace):
        components = path.split("/")
        for length in range(1, len(components)):
            source_directories.add("/".join(components[:length]))
    for path in sorted(source_directories):
        canonical_poured_namespace.setdefault(path, {
            "path": path,
            "materialization": "descriptor",
            "type": "directory",
            "mode": 0o755,
            "size": 0,
        })

    # The eager builder checks receipts with lstat after staging and before
    # prefix links are applied. Mirror that exact contract: the mapped path
    # itself must exist, but a symlink receipt need not resolve to its target.
    for package in layer_packages:
        contract = link_contracts[package["full_name"]]
        for receipt in contract["receipts"]:
            receipt_path = (
                f"{package['prefix'].removeprefix('/')}/{receipt}"
                if receipt == "Cellar" or receipt.startswith("Cellar/")
                else f"{package['keg'].removeprefix('/')}/{receipt}"
            )
            if receipt_path not in canonical_poured_namespace:
                fail(
                    f"Homebrew deferred tree receipt {receipt} is missing at "
                    f"/{receipt_path}"
                )

    # Apply the exact reviewed prefix-link set in manifest order, followed by
    # the one canonical opt link per package.
    for package in layer_packages:
        full_name = package["full_name"]
        data = data_by_package[full_name]
        tree_id = expected_ids[full_name]
        expected_entries = expected_by_package[full_name]
        contract = link_contracts[full_name]
        reserved = reserved_sources[full_name]
        for link in contract["links"]:
            source_path = (
                f"{package['prefix'].removeprefix('/')}/{link['source']}"
                if link["source"] == "Cellar" or link["source"].startswith("Cellar/")
                else f"{package['keg'].removeprefix('/')}/{link['source']}"
            )
            target_path = f"{package['prefix'].removeprefix('/')}/{link['target']}"
            if target_path in canonical_poured_namespace:
                fail(f"Homebrew deferred tree {tree_id} link ownership overlaps at /{target_path}")
            source = resolve_original_bottle_guest_source(
                canonical_poured_namespace, source_path, tree_id
            )
            if source["type"] not in ("file", "directory"):
                fail(f"Homebrew deferred tree {tree_id} link source is unsupported")
            if link["type"] == "file":
                if source["type"] != "file" or source["materialization"] not in (
                    "archive", "archive-homebrew-relocate"
                ):
                    fail(f"Homebrew deferred tree {tree_id} copied link source is not regular")
                mode = source["mode"] if link["mode_override"] is None else link["mode_override"]
                expected_entries[target_path] = {
                    "path": target_path,
                    "source_path": source["source_path"],
                    "materialization": (
                        "archive-copy" if mode == source["mode"] else "archive-copy-mode"
                    ),
                    "type": "file",
                    "ownership": "layer",
                    "mode": mode,
                    "size": source["size"],
                    "inode_group": expected_inode_group(tree_id, "copy", target_path),
                }
            elif link["type"] == "symlink":
                target = f"/{source_path}"
                expected_entries[target_path] = {
                    "path": target_path,
                    "source_path": expected_descriptor_source_path(
                        tree_id, f"link-{link['index']}", reserved
                    ),
                    "materialization": "descriptor",
                    "type": "symlink",
                    "ownership": "layer",
                    "mode": 0o777,
                    "size": len(target.encode("utf-8")),
                    "target": target,
                }
            else:
                if source["type"] != "directory":
                    fail(f"Homebrew deferred tree {tree_id} directory link source differs")
                mode = source["mode"] if link["mode_override"] is None else link["mode_override"]
                expected_entries[target_path] = {
                    "path": target_path,
                    "source_path": expected_descriptor_source_path(
                        tree_id, f"link-{link['index']}", reserved
                    ),
                    "materialization": "descriptor",
                    "type": "directory",
                    "ownership": entry_ownership(package, target_path, "directory"),
                    "mode": mode,
                    "size": 0,
                }
            canonical_poured_namespace[target_path] = expected_entries[target_path]

        opt = package["opt_link"]
        opt_path = f"{package['prefix'].removeprefix('/')}/{opt['path']}"
        if opt_path in canonical_poured_namespace:
            fail(f"Homebrew deferred tree {tree_id} canonical opt ownership overlaps")
        expected_entries[opt_path] = {
            "path": opt_path,
            "source_path": expected_descriptor_source_path(tree_id, "opt", reserved),
            "materialization": "descriptor",
            "type": "symlink",
            "ownership": "layer",
            "mode": 0o777,
            "size": len(opt["target"].encode("utf-8")),
            "target": opt["target"],
        }
        canonical_poured_namespace[opt_path] = expected_entries[opt_path]

    # `ensureDirRecursive` supplies every missing Homebrew-prefix ancestor with
    # mode 0755. The producer assigns each such directory to the lexicographically
    # first descendant tree id after all package-owned entries are known.
    required_directories: set[str] = set()
    prefix_roots: set[str] = set()
    for package in layer_packages:
        prefix = package["prefix"].removeprefix("/")
        prefix_roots.add(prefix)
        required_directories.update((prefix, link_contracts[package["full_name"]]["cellar"].removeprefix("/"), package["keg"].removeprefix("/")))
    for entries in expected_by_package.values():
        for path in entries:
            components = path.split("/")
            for length in range(1, len(components)):
                ancestor = "/".join(components[:length])
                if any(ancestor == prefix or ancestor.startswith(f"{prefix}/") for prefix in prefix_roots):
                    required_directories.add(ancestor)
    assigned_paths = {
        path: full_name
        for full_name, entries in expected_by_package.items()
        for path in entries
    }
    for path in sorted(required_directories):
        if path in assigned_paths:
            continue
        owners = sorted(
            {
                expected_ids[full_name]
                for candidate, full_name in assigned_paths.items()
                if candidate.startswith(f"{path}/")
            }
        )
        if not owners:
            fail(f"Homebrew structural directory /{path} has no canonical owner")
        tree_id = owners[0]
        full_name = next(name for name, value in expected_ids.items() if value == tree_id)
        data = data_by_package[full_name]
        expected_by_package[full_name][path] = {
            "path": path,
            "source_path": expected_descriptor_source_path(
                tree_id,
                f"directory-{digest_bytes(path.encode('utf-8'))[:16]}",
                reserved_sources[full_name],
            ),
            "materialization": "descriptor",
            "type": "directory",
            "ownership": entry_ownership(data["package"], path, "directory"),
            "mode": 0o755,
            "size": 0,
        }
        assigned_paths[path] = full_name

    for package in layer_packages:
        full_name = package["full_name"]
        data = data_by_package[full_name]
        tree_id = expected_ids[full_name]
        asset = original_bottle_payload_asset(tree_id)
        expected_transports: list[dict[str, str]] = [{"kind": "bundle-release", "asset": asset}]
        if not draft:
            assert release_root is not None
            expected_transports[0]["url"] = f"{release_root}/{asset}"
        external = expected_external_bottle_transport(package)
        if external is not None:
            expected_transports.append(external)
        exact(
            data["tree"]["activation"],
            {
                "mode": "first-use",
                "capabilities": [f"homebrew-bottle:{tree_id}"],
                "roots": [package["keg"]],
            },
            f"Homebrew deferred tree {tree_id} canonical activation",
        )
        exact(
            data["tree"]["transports"],
            expected_transports,
            f"Homebrew deferred tree {tree_id} canonical transports",
        )
        exact(
            data["release_asset"],
            asset,
            f"Homebrew deferred tree {tree_id} canonical payload asset",
        )
        expected_entries = sorted(
            expected_by_package[full_name].values(), key=lambda entry: entry["path"]
        )
        exact(
            data["entries"],
            expected_entries,
            f"Homebrew deferred tree {tree_id} canonical guest projection",
        )


def validate_original_bottle_trees(
    trees: list[Any],
    *,
    payload_values: dict[str, bytes],
    layer_packages: list[dict[str, Any]],
    applied_link_contracts: dict[str, dict[str, Any]],
    bundle_tree_assets: list[dict[str, Any]] | None,
    release_root: str | None,
    runtime_id: str,
    root_full_name: str,
    draft: bool,
) -> None:
    if not trees or len(trees) > len(layer_packages):
        fail("Homebrew original bottle trees differ from the layer package set")
    package_by_name = {package["full_name"]: package for package in layer_packages}
    seen_packages: set[str] = set()
    seen_ids: set[str] = set()
    seen_digests: set[str] = set()
    seen_urls: set[str] = set()
    seen_paths: set[str] = set()
    tree_id_order: list[str] = []
    expected_bundle: list[dict[str, Any]] = []
    validated_tree_data: list[dict[str, Any]] = []
    aggregate_expanded = 0
    aggregate_payload = 0
    aggregate_entries = 0
    for index, raw in enumerate(trees):
        tree = record(raw, f"Homebrew deferred tree {index}")
        if set(tree) != {"id", "package", "activation", "content", "transports", "inventory"}:
            fail(f"Homebrew deferred tree {index} has unexpected fields")
        tree_id = string(
            tree.get("id"),
            f"Homebrew deferred tree {index} id",
            maximum=MAX_LAZY_LAYER_RUNTIME_ID_BYTES,
        )
        if RUNTIME_LAYER_ID_RE.fullmatch(tree_id) is None or tree_id in seen_ids:
            fail(f"Homebrew deferred tree {index} id is invalid or duplicated")
        seen_ids.add(tree_id)
        tree_id_order.append(tree_id)
        package_name = string(tree.get("package"), f"Homebrew deferred tree {tree_id} package")
        package = package_by_name.get(package_name)
        if package is None or package_name in seen_packages:
            fail(f"Homebrew deferred tree {tree_id} package binding is invalid")
        seen_packages.add(package_name)

        _, roots = validate_deferred_tree_activation(
            tree.get("activation"), f"Homebrew deferred tree {tree_id} activation"
        )
        exact(
            roots,
            [package["keg"]],
            f"Homebrew deferred tree {tree_id} activation keg",
        )

        content = record(tree.get("content"), f"Homebrew deferred tree {tree_id} content")
        if set(content) != {"media_type", "decoder", "sha256", "bytes"}:
            fail(f"Homebrew deferred tree {tree_id} content has unexpected fields")
        exact(
            content.get("decoder"),
            "homebrew-bottle-tar-gzip-v1",
            f"Homebrew deferred tree {tree_id} decoder",
        )
        exact(
            content.get("media_type"),
            "application/vnd.oci.image.layer.v1.tar+gzip",
            f"Homebrew deferred tree {tree_id} media type",
        )
        content_sha = sha(content.get("sha256"), f"Homebrew deferred tree {tree_id} digest")
        content_bytes = integer(
            content.get("bytes"), f"Homebrew deferred tree {tree_id} bytes", minimum=1
        )
        exact(content_sha, package["sha256"], f"Homebrew deferred tree {tree_id} package digest")
        exact(content_bytes, package["bytes"], f"Homebrew deferred tree {tree_id} package size")
        if content_sha in seen_digests:
            fail(f"Homebrew deferred tree {tree_id} reuses a content identity")
        seen_digests.add(content_sha)

        transports = array(tree.get("transports"), f"Homebrew deferred tree {tree_id} transports")
        if (
            not transports
            or len(transports) > MAX_LAZY_LAYER_TRANSPORTS_PER_TREE
        ):
            fail(f"Homebrew deferred tree {tree_id} transports have an invalid size")
        release_asset: str | None = None
        external_count = 0
        for transport_index, raw_transport in enumerate(transports):
            transport = record(
                raw_transport, f"Homebrew deferred tree {tree_id} transport {transport_index}"
            )
            kind = transport.get("kind")
            if kind == "bundle-release":
                expected = {"kind", "asset"} if draft else {"kind", "asset", "url"}
                if set(transport) != expected or release_asset is not None:
                    fail(f"Homebrew deferred tree {tree_id} release transport is invalid")
                release_asset = string(
                    transport.get("asset"),
                    f"Homebrew deferred tree {tree_id} release asset",
                    maximum=MAX_RELEASE_ASSET_NAME_BYTES,
                )
                if ASSET_RE.fullmatch(release_asset) is None:
                    fail(f"Homebrew deferred tree {tree_id} release asset is unsafe")
                if not draft:
                    assert release_root is not None
                    url = https_url(
                        transport.get("url"),
                        f"Homebrew deferred tree {tree_id} release URL",
                    )
                    exact(
                        url,
                        f"{release_root}/{release_asset}",
                        f"Homebrew deferred tree {tree_id} release URL",
                    )
                    if url in seen_urls:
                        fail(f"Homebrew deferred tree {tree_id} reuses a transport")
                    seen_urls.add(url)
            elif kind == "external-https":
                if set(transport) != {"kind", "url"}:
                    fail(f"Homebrew deferred tree {tree_id} external transport is invalid")
                external_count += 1
                url = https_url(
                    transport.get("url"), f"Homebrew deferred tree {tree_id} external URL"
                )
                if url in seen_urls:
                    fail(f"Homebrew deferred tree {tree_id} reuses a transport")
                seen_urls.add(url)
            else:
                fail(f"Homebrew deferred tree {tree_id} transport kind is unsupported")
        if release_asset is None or external_count > 1:
            fail(f"Homebrew deferred tree {tree_id} transport set is invalid")
        archive_value = payload_values.get(release_asset)
        if archive_value is None:
            fail(f"Homebrew deferred tree {tree_id} payload is missing")
        exact(content_sha, digest_bytes(archive_value), f"Homebrew deferred tree {tree_id} payload digest")
        exact(content_bytes, len(archive_value), f"Homebrew deferred tree {tree_id} payload size")
        (
            entries,
            source_entries,
            canonical_source_by_path,
            relocation,
        ) = validate_original_bottle_inventory(
            tree.get("inventory"), tree_id=tree_id, archive_value=archive_value
        )
        entries_by_path = {entry["path"]: entry for entry in entries}
        keg_path = package["keg"].removeprefix("/")
        opt_path = f"{package['prefix']}/{package['opt_link']['path']}".removeprefix("/")
        keg = entries_by_path.get(keg_path)
        opt = entries_by_path.get(opt_path)
        if (
            keg is None
            or keg["type"] != "directory"
            or keg["ownership"] != "layer"
            or opt is None
            or opt["type"] != "symlink"
            or opt["ownership"] != "layer"
            or opt.get("target") != package["opt_link"]["target"]
        ):
            fail(f"Homebrew deferred tree {tree_id} does not own its package keg and opt link")
        if package_name not in applied_link_contracts:
            fail(f"Homebrew deferred tree {tree_id} has no reviewed link contract")
        for root in roots:
            relative = root[1:]
            if not any(
                entry["path"] == relative or entry["path"].startswith(f"{relative}/")
                for entry in entries
            ):
                fail(f"Homebrew deferred tree {tree_id} activation root is unowned")
        for entry in entries:
            if entry["path"] in seen_paths:
                fail(f"Homebrew deferred trees overlap at {entry['path']}")
            seen_paths.add(entry["path"])
        aggregate_expanded += integer(
            record(tree["inventory"], "Homebrew deferred tree inventory").get("expanded_bytes"),
            f"Homebrew deferred tree {tree_id} expanded bytes",
        )
        aggregate_payload += integer(
            record(tree["inventory"], "Homebrew deferred tree inventory").get("payload_bytes"),
            f"Homebrew deferred tree {tree_id} payload bytes",
        )
        aggregate_entries += len(entries) + len(
            record(tree["inventory"]["source"], "Homebrew source inventory")["entries"]
        )
        if (
            aggregate_expanded > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES
            or aggregate_payload > MAX_LAZY_LAYER_UNCOMPRESSED_BYTES
            or aggregate_entries > MAX_LAZY_LAYER_ENTRIES
        ):
            fail("Homebrew deferred-tree collection exceeds aggregate bounds")
        expected_bundle.append({
            "id": tree_id,
            "asset": release_asset,
            "sha256": content_sha,
            "bytes": content_bytes,
        })
        validated_tree_data.append({
            "tree": tree,
            "tree_id": tree_id,
            "package": package,
            "release_asset": release_asset,
            "entries": entries,
            "entries_by_path": entries_by_path,
            "source_entries": source_entries,
            "canonical_source_by_path": canonical_source_by_path,
            "relocation": relocation,
        })
    if tree_id_order != sorted(tree_id_order):
        fail("Homebrew deferred trees are not in canonical order")
    if seen_packages != set(package_by_name):
        fail("Homebrew original bottle package binding is incomplete")
    validate_canonical_original_bottle_trees(
        validated_tree_data,
        layer_packages=layer_packages,
        link_contracts=applied_link_contracts,
        runtime_id=runtime_id,
        root_full_name=root_full_name,
        draft=draft,
        release_root=release_root,
    )
    root_packages = [
        package for package in layer_packages
        if package["full_name"] == root_full_name
    ]
    if len(root_packages) != 1 or not any(
        tree.get("id") == runtime_id
        and tree.get("package") == root_packages[0]["full_name"]
        for tree in trees
    ):
        fail("Homebrew original bottle root tree differs from the selected runtime")
    if not draft:
        assert bundle_tree_assets is not None
        exact(
            bundle_tree_assets,
            expected_bundle,
            "Homebrew deferred tree bundled asset identities",
        )


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
    draft: bool = False,
    payload_paths: dict[str, Path] | None = None,
) -> None:
    descriptor_value, descriptor_raw = read_json(
        descriptor_path, "Homebrew lazy layer descriptor"
    )
    descriptor = record(descriptor_value, "Homebrew lazy layer descriptor")
    tree_assets = deferred_tree_asset_names(descriptor, runtime_id)
    root_asset, _ = lazy_layer_asset_names(runtime_id)
    if payload_paths is None:
        exact(archive_path.name, root_asset, "Homebrew runtime root payload path")
        payload_paths = {
            asset: archive_path if asset == root_asset else archive_path.parent / asset
            for asset in tree_assets
        }
    else:
        exact(
            set(payload_paths),
            set(tree_assets),
            "Homebrew deferred-tree source payload set",
        )
    payload_values: dict[str, bytes] = {}
    aggregate_payload_bytes = 0
    for asset in tree_assets:
        payload = read_bytes(
            payload_paths[asset],
            f"Homebrew deferred-tree payload {asset}",
            MAX_LAZY_LAYER_ARCHIVE_BYTES,
        )
        aggregate_payload_bytes += len(payload)
        if aggregate_payload_bytes > MAX_LAZY_LAYER_ARCHIVE_BYTES:
            fail("Homebrew deferred-tree payload collection exceeds the size limit")
        payload_values[asset] = payload
    common_top_level = {
        "schema", "kind", "arch", "mount_prefix", "tap", "tap_lock",
        "kandelo", "bottle_release_tag", "selection", "packages",
        "base_vfs", "acceptance_vfs", "deferred_trees",
    }
    expected_top_level = (
        common_top_level
        if draft
        else common_top_level | {
            "bundle", "release", "acceptance_evidence",
        }
    )
    if set(descriptor) != expected_top_level:
        fail("Homebrew lazy layer descriptor has unexpected fields")
    descriptor_schema = descriptor.get("schema")
    if descriptor_schema not in (4, 5):
        fail("Homebrew lazy layer schema must be 4 or 5")
    exact(
        descriptor.get("kind"),
        (
            "kandelo-homebrew-deferred-layer-draft"
            if draft
            else "kandelo-homebrew-deferred-layer"
        ),
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

    tap_lock = bounded_array(
        descriptor.get("tap_lock"),
        "Homebrew lazy layer tap lock",
        minimum=1,
        maximum=MAX_LAZY_LAYER_TAP_LOCKS,
    )
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
        repository_value = repository(
            locked.get("repository"), f"Homebrew lazy layer tap lock {index} repository"
        )
        name = repository(
            locked.get("name"), f"Homebrew lazy layer tap lock {index} name"
        )
        locked_commit = string(
            locked.get("commit"), f"Homebrew lazy layer tap lock {index} commit"
        )
        commit(locked_commit, f"Homebrew lazy layer tap lock {index} commit")
        kandelo_repository = repository(
            locked.get("kandelo_repository"),
            f"Homebrew lazy layer tap lock {index} Kandelo repository",
        )
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
            maximum=256,
        )
        repository_key = repository_value.lower()
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
    checkouts = result["tap_checkouts"]
    exact(
        set(taps_by_name),
        set(checkouts),
        "Homebrew lazy layer tap lock checkout coverage",
    )
    for name, checkout in checkouts.items():
        locked = taps_by_name[name]
        exact(
            locked.get("commit"),
            checkout["commit"],
            f"Homebrew lazy layer tap lock {name} checkout commit",
        )
        if checkout["primary"]:
            exact(
                locked.get("repository"),
                checkout["repository"],
                f"Homebrew lazy layer tap lock {name} checkout repository",
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
    requested_packages = bounded_array(
        selection.get("requested_packages"),
        "Homebrew lazy layer requested packages",
        minimum=1,
        maximum=MAX_LAZY_LAYER_REQUESTED_PACKAGES,
    )
    exact(
        requested_packages,
        [runtime_id],
        "Homebrew lazy layer requested packages",
    )
    package_order = [
        full_package_name(value, f"Homebrew lazy layer package order {index}")
        for index, value in enumerate(bounded_array(
            selection.get("package_order"),
            "Homebrew lazy layer dependency-first package order",
            minimum=1,
            maximum=MAX_LAZY_LAYER_PACKAGES,
        ))
    ]
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
    base_order = [
        full_package_name(value, f"Homebrew lazy layer base package order {index}")
        for index, value in enumerate(bounded_array(
            selection.get("base_package_order"),
            "Homebrew lazy layer base package order",
            maximum=MAX_LAZY_LAYER_PACKAGES,
        ))
    ]
    layer_order = [
        full_package_name(value, f"Homebrew lazy layer layer package order {index}")
        for index, value in enumerate(bounded_array(
            selection.get("layer_package_order"),
            "Homebrew lazy layer layer package order",
            minimum=1,
            maximum=MAX_LAZY_LAYER_PACKAGES,
        ))
    ]
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
    base_names = set(base_order)
    layer_names = set(layer_order)
    for conflict in result["link_conflicts"]:
        owners = set(conflict["owners"])
        if owners & base_names and owners & layer_names:
            fail(
                f"Homebrew lazy layer link conflict {conflict['target']} spans "
                "base and deferred packages"
            )

    packages_value = record(descriptor.get("packages"), "Homebrew lazy layer packages")
    if set(packages_value) != {"base", "layer"}:
        fail("Homebrew lazy layer packages have unexpected fields")
    base_packages = [
        validate_lazy_package_record(value, f"Homebrew lazy layer base package {index}")
        for index, value in enumerate(
            bounded_array(
                packages_value.get("base"),
                "Homebrew lazy layer base packages",
                maximum=MAX_LAZY_LAYER_PACKAGES,
            )
        )
    ]
    layer_packages = [
        validate_lazy_package_record(value, f"Homebrew lazy layer package {index}")
        for index, value in enumerate(
            bounded_array(
                packages_value.get("layer"),
                "Homebrew lazy layer layer packages",
                minimum=1,
                maximum=MAX_LAZY_LAYER_PACKAGES,
            )
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
    composition_order = [
        full_package_name(value, f"Homebrew lazy layer base composition package {index}")
        for index, value in enumerate(bounded_array(
            composition.get("package_order"),
            "Homebrew lazy layer base composition package order",
            minimum=1,
            maximum=MAX_LAZY_LAYER_PACKAGES,
        ))
    ]
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

    acceptance_tag = f"homebrew-vfs-sha256-{result['image_sha']}"
    acceptance_root = (
        f"https://github.com/{tap_repository}/releases/download/{acceptance_tag}"
    )
    expected_acceptance_identity = {
        "asset": IMAGE_ASSET,
        "sha256": result["image_sha"],
        "bytes": result["image_bytes"],
    }
    release_root: str | None = None
    bundle_tree_assets: list[dict[str, Any]] | None = None
    if draft:
        acceptance_vfs = validate_asset_identity(
            descriptor.get("acceptance_vfs"),
            "Homebrew lazy layer acceptance VFS",
            expected_asset=IMAGE_ASSET,
            maximum_bytes=MAX_VFS_BYTES,
        )
        exact(
            acceptance_vfs,
            expected_acceptance_identity,
            "Homebrew lazy layer acceptance VFS identity",
        )
    else:
        bundle = record(descriptor.get("bundle"), "Homebrew lazy layer bundle")
        if set(bundle) != {
            "schema", "kind", "algorithm", "descriptor_encoding", "sha256", "assets"
        }:
            fail("Homebrew lazy layer bundle has unexpected fields")
        exact(bundle.get("schema"), 1, "Homebrew lazy layer bundle schema")
        exact(
            bundle.get("kind"),
            "kandelo-homebrew-runtime-layer-bundle",
            "Homebrew lazy layer bundle kind",
        )
        exact(
            bundle.get("algorithm"),
            "sha256-canonical-json-v1",
            "Homebrew lazy layer bundle algorithm",
        )
        exact(
            bundle.get("descriptor_encoding"),
            "canonical-json-v1",
            "Homebrew lazy layer descriptor encoding",
        )
        bundle_sha = sha(bundle.get("sha256"), "Homebrew lazy layer bundle digest")
        assets = record(bundle.get("assets"), "Homebrew lazy layer bundle assets")
        if set(assets) != {
            "acceptance_vfs", "acceptance_descriptor", "acceptance_report",
            "acceptance_node_evidence", "acceptance_browser_evidence",
            "deferred_trees",
        }:
            fail("Homebrew lazy layer bundle assets have unexpected fields")
        bundle_acceptance = validate_asset_identity(
            assets.get("acceptance_vfs"),
            "Homebrew lazy layer bundled acceptance VFS",
            expected_asset=IMAGE_ASSET,
            maximum_bytes=MAX_VFS_BYTES,
        )
        bundle_evidence = {
            "descriptor": validate_asset_identity(
                assets.get("acceptance_descriptor"),
                "Homebrew lazy layer bundled acceptance descriptor",
                expected_asset=DESCRIPTOR_ASSET,
            ),
            "report": validate_asset_identity(
                assets.get("acceptance_report"),
                "Homebrew lazy layer bundled acceptance report",
                expected_asset=REPORT_ASSET,
            ),
            "node": validate_asset_identity(
                assets.get("acceptance_node_evidence"),
                "Homebrew lazy layer bundled Node evidence",
                expected_asset=NODE_ASSET,
            ),
            "browser": validate_asset_identity(
                assets.get("acceptance_browser_evidence"),
                "Homebrew lazy layer bundled browser evidence",
                expected_asset=BROWSER_ASSET,
            ),
        }
        bundle_tree_assets = []
        for index, value in enumerate(
            array(assets.get("deferred_trees"), "Homebrew lazy layer bundled trees")
        ):
            tree_asset = record(value, f"Homebrew lazy layer bundled tree {index}")
            if set(tree_asset) != {"id", "asset", "sha256", "bytes"}:
                fail(f"Homebrew lazy layer bundled tree {index} has unexpected fields")
            tree_id = string(tree_asset.get("id"), f"Homebrew lazy layer bundled tree {index} id")
            if RUNTIME_LAYER_ID_RE.fullmatch(tree_id) is None:
                fail(f"Homebrew lazy layer bundled tree {index} id is invalid")
            identity = validate_asset_identity(
                {key: tree_asset[key] for key in ("asset", "sha256", "bytes")},
                f"Homebrew lazy layer bundled tree {index}",
                maximum_bytes=MAX_LAZY_LAYER_ARCHIVE_BYTES,
            )
            bundle_tree_assets.append({"id": tree_id, **identity})
        if (
            not bundle_tree_assets
            or [item["id"] for item in bundle_tree_assets]
                != sorted(item["id"] for item in bundle_tree_assets)
            or len({item["id"] for item in bundle_tree_assets})
                != len(bundle_tree_assets)
        ):
            fail("Homebrew lazy layer bundled trees are not canonical")

        release_tag = RUNTIME_LAYER_TAG_PREFIX + bundle_sha
        release_root = (
            f"https://github.com/{tap_repository}/releases/download/{release_tag}"
        )
        release = record(descriptor.get("release"), "Homebrew lazy layer release")
        if set(release) != {"repository", "tag"}:
            fail("Homebrew lazy layer release has unexpected fields")
        exact(
            release.get("repository"),
            tap_repository,
            "Homebrew lazy layer release repository",
        )
        exact(release.get("tag"), release_tag, "Homebrew lazy layer release tag")

        acceptance_vfs = validate_release_asset(
            descriptor.get("acceptance_vfs"),
            "Homebrew lazy layer acceptance VFS",
            expected_asset=IMAGE_ASSET,
            release_root=acceptance_root,
            maximum_bytes=MAX_VFS_BYTES,
        )
        exact(
            identity_without_url(acceptance_vfs),
            expected_acceptance_identity,
            "Homebrew lazy layer acceptance VFS identity",
        )
        exact(
            identity_without_url(acceptance_vfs),
            bundle_acceptance,
            "Homebrew lazy layer bundled acceptance VFS identity",
        )
        evidence = record(
            descriptor.get("acceptance_evidence"),
            "Homebrew lazy layer acceptance evidence",
        )
        if set(evidence) != {"descriptor", "report", "node", "browser"}:
            fail("Homebrew lazy layer acceptance evidence has unexpected fields")
        evidence_assets = {
            "descriptor": DESCRIPTOR_ASSET,
            "report": REPORT_ASSET,
            "node": NODE_ASSET,
            "browser": BROWSER_ASSET,
        }
        actual_evidence = {
            "descriptor": asset_identity(
                DESCRIPTOR_ASSET,
                read_bytes(
                    descriptor_path.parent / DESCRIPTOR_ASSET,
                    "Homebrew acceptance VFS descriptor",
                    MAX_JSON_BYTES,
                ),
            ),
            "report": asset_identity(REPORT_ASSET, result["report_bytes"]),
            "node": asset_identity(NODE_ASSET, result["node_bytes"]),
            "browser": asset_identity(BROWSER_ASSET, result["browser_bytes"]),
        }
        for name, asset_name in evidence_assets.items():
            item = validate_release_asset(
                evidence.get(name),
                f"Homebrew lazy layer acceptance {name}",
                expected_asset=asset_name,
                release_root=acceptance_root,
            )
            exact(
                identity_without_url(item),
                bundle_evidence[name],
                f"Homebrew lazy layer bundled acceptance {name}",
            )
            exact(
                identity_without_url(item),
                actual_evidence[name],
                f"Homebrew lazy layer exact acceptance {name}",
            )

    trees = array(descriptor.get("deferred_trees"), "Homebrew deferred trees")
    if descriptor_schema == 5:
        validate_original_bottle_trees(
            trees,
            payload_values=payload_values,
            layer_packages=layer_packages,
            applied_link_contracts=result["applied_link_contracts"],
            bundle_tree_assets=bundle_tree_assets,
            release_root=release_root,
            runtime_id=runtime_id,
            root_full_name=result["root_full_name"],
            draft=draft,
        )
        if not draft:
            exact(
                descriptor["bundle"]["sha256"],
                runtime_layer_bundle_sha256(descriptor),
                "Homebrew lazy layer canonical bundle digest",
            )
            exact(
                descriptor_raw,
                runtime_layer_descriptor_bytes(descriptor),
                "Homebrew lazy layer canonical descriptor bytes",
            )
        return
    if any(
        isinstance(value, dict)
        and (
            "package" in value
            or isinstance(value.get("inventory"), dict)
            and "source" in value["inventory"]
        )
        for value in trees
    ):
        fail("Homebrew lazy layer schema 4 cannot contain original-bottle metadata")
    if len(trees) != 1:
        fail("The scaffold publisher requires exactly one Homebrew deferred tree")
    archive_value = payload_values[root_asset]
    tree = record(trees[0], "Homebrew deferred tree")
    if set(tree) != {"id", "activation", "content", "transports", "inventory"}:
        fail("Homebrew deferred tree has unexpected fields")
    exact(tree.get("id"), runtime_id, "Homebrew deferred tree id")

    _, roots = validate_deferred_tree_activation(
        tree.get("activation"), "Homebrew deferred tree activation"
    )

    content = record(tree.get("content"), "Homebrew deferred tree content")
    if set(content) != {"media_type", "decoder", "sha256", "bytes"}:
        fail("Homebrew deferred tree content has unexpected fields")
    decoder = content.get("decoder")
    media_type = content.get("media_type")
    if decoder != "zip-v1" or media_type != "application/zip":
        fail("Homebrew lazy layer schema 4 requires the legacy ZIP decoder")
    exact(
        content.get("sha256"),
        digest_bytes(archive_value),
        "Homebrew deferred tree digest",
    )
    exact(content.get("bytes"), len(archive_value), "Homebrew deferred tree size")

    transports = array(tree.get("transports"), "Homebrew deferred tree transports")
    if not transports or len(transports) > MAX_LAZY_LAYER_TRANSPORTS_PER_TREE:
        fail(
            "Homebrew deferred tree must have one to "
            f"{MAX_LAZY_LAYER_TRANSPORTS_PER_TREE} transports"
        )
    lazy_layer_asset, _ = lazy_layer_asset_names(runtime_id)
    transport_urls: list[str] = []
    release_transport_count = 0
    for index, value in enumerate(transports):
        transport = record(value, f"Homebrew deferred tree transport {index}")
        kind = string(
            transport.get("kind"),
            f"Homebrew deferred tree transport {index} kind",
            maximum=64,
        )
        if kind == "bundle-release":
            expected_keys = {"kind", "asset"} if draft else {"kind", "asset", "url"}
            if set(transport) != expected_keys:
                fail(f"Homebrew deferred tree transport {index} has unexpected fields")
            asset_name = string(
                transport.get("asset"),
                f"Homebrew deferred tree transport {index} asset",
                maximum=MAX_RELEASE_ASSET_NAME_BYTES,
            )
            if ASSET_RE.fullmatch(asset_name) is None:
                fail(f"Homebrew deferred tree transport {index} asset is unsafe")
            exact(asset_name, lazy_layer_asset, "Homebrew deferred tree release asset")
            release_transport_count += 1
            if draft:
                continue
            assert release_root is not None
            transport_url = https_url(
                transport.get("url"),
                f"Homebrew deferred tree transport {index} URL",
            )
            exact(
                transport_url,
                f"{release_root}/{lazy_layer_asset}",
                "Homebrew deferred tree release transport",
            )
        elif kind == "external-https":
            if set(transport) != {"kind", "url"}:
                fail(f"Homebrew deferred tree transport {index} has unexpected fields")
            transport_url = https_url(
                transport.get("url"),
                f"Homebrew deferred tree transport {index} URL",
            )
        else:
            fail(f"Homebrew deferred tree transport {index} kind is unsupported")
        transport_urls.append(transport_url)
    if release_transport_count != 1:
        fail("Homebrew deferred tree must have exactly one bundle release transport")
    if len(set(transport_urls)) != len(transport_urls):
        fail("Homebrew deferred tree transports contain duplicates")
    if not draft:
        assert bundle_tree_assets is not None
        exact(
            bundle_tree_assets,
            [{
                "id": runtime_id,
                "asset": lazy_layer_asset,
                "sha256": content.get("sha256"),
                "bytes": content.get("bytes"),
            }],
            "Homebrew deferred tree bundled asset identity",
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
    if not draft:
        exact(
            descriptor["bundle"]["sha256"],
            runtime_layer_bundle_sha256(descriptor),
            "Homebrew lazy layer canonical bundle digest",
        )
        exact(
            descriptor_raw,
            runtime_layer_descriptor_bytes(descriptor),
            "Homebrew lazy layer canonical descriptor bytes",
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


def normalize_tar_member_name(value: str) -> str:
    """Match the runtime decoder's canonical treatment of repeated ./ prefixes."""
    while value.startswith("./"):
        value = value[2:]
    return value.rstrip("/")


def validate_lazy_layer_tar_gzip(
    archive_value: bytes,
    entries: list[dict[str, Any]],
    expanded_bytes: int,
) -> None:
    tar_value = decompress_single_lazy_layer_gzip(archive_value, expanded_bytes)
    validate_closed_tar_structure(tar_value)

    def source_name(entry: dict[str, Any]) -> str:
        return entry.get("source_path", entry["path"])

    expected_by_source = {source_name(entry): entry for entry in entries}
    expected_by_path = {entry["path"]: entry for entry in entries}
    if len(expected_by_source) != len(entries):
        fail("Homebrew deferred TAR inventory duplicates a source member")
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_value), mode="r:") as archive:
            members = archive.getmembers()
            actual_names = [normalize_tar_member_name(member.name) for member in members]
            if (
                set(actual_names) != set(expected_by_source)
                or len(set(actual_names)) != len(actual_names)
            ):
                fail("Homebrew deferred TAR members differ from the complete source inventory")
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
                        normalize_tar_member_name(member.linkname),
                        source_name(target),
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


def asset_identity(name: str, value: bytes) -> dict[str, Any]:
    if ASSET_RE.fullmatch(name) is None:
        fail(f"unsafe runtime-layer asset name {name!r}")
    return {"asset": name, "sha256": digest_bytes(value), "bytes": len(value)}


def validate_asset_identity(
    value: Any,
    label: str,
    *,
    expected_asset: str | None = None,
    maximum_bytes: int = MAX_JSON_BYTES,
) -> dict[str, Any]:
    identity = record(value, label)
    if set(identity) != {"asset", "sha256", "bytes"}:
        fail(f"{label} has unexpected fields")
    name = string(
        identity.get("asset"),
        f"{label} asset",
        maximum=MAX_RELEASE_ASSET_NAME_BYTES,
    )
    if ASSET_RE.fullmatch(name) is None:
        fail(f"{label} asset is unsafe")
    if expected_asset is not None:
        exact(name, expected_asset, f"{label} asset")
    size = integer(identity.get("bytes"), f"{label} size", minimum=1)
    if size > maximum_bytes:
        fail(f"{label} exceeds {maximum_bytes} bytes")
    return {
        "asset": name,
        "sha256": sha(identity.get("sha256"), f"{label} digest"),
        "bytes": size,
    }


def validate_release_asset(
    value: Any,
    label: str,
    *,
    expected_asset: str,
    release_root: str,
    maximum_bytes: int = MAX_JSON_BYTES,
) -> dict[str, Any]:
    item = record(value, label)
    if set(item) != {"asset", "url", "sha256", "bytes"}:
        fail(f"{label} has unexpected fields")
    identity = validate_asset_identity(
        {key: item[key] for key in ("asset", "sha256", "bytes")},
        label,
        expected_asset=expected_asset,
        maximum_bytes=maximum_bytes,
    )
    url = https_url(item.get("url"), f"{label} URL")
    exact(url, f"{release_root}/{expected_asset}", f"{label} URL")
    return {**identity, "url": url}


def identity_without_url(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "asset": value["asset"],
        "sha256": value["sha256"],
        "bytes": value["bytes"],
    }


def runtime_layer_bundle_identity_document(
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    """Project a closed descriptor to its non-circular immutable identity."""
    evidence = record(
        descriptor.get("acceptance_evidence"),
        "Homebrew runtime layer acceptance evidence",
    )
    return {
        "schema": 1,
        "kind": "kandelo-homebrew-runtime-layer-bundle-identity",
        "bundle": {
            "schema": descriptor["bundle"]["schema"],
            "kind": descriptor["bundle"]["kind"],
            "algorithm": descriptor["bundle"]["algorithm"],
            "descriptor_encoding": descriptor["bundle"]["descriptor_encoding"],
            "assets": descriptor["bundle"]["assets"],
        },
        "layer": {
            "schema": descriptor["schema"],
            "kind": descriptor["kind"],
            "arch": descriptor["arch"],
            "mount_prefix": descriptor["mount_prefix"],
            "tap": descriptor["tap"],
            "tap_lock": descriptor["tap_lock"],
            "kandelo": descriptor["kandelo"],
            "bottle_release_tag": descriptor["bottle_release_tag"],
            "selection": descriptor["selection"],
            "packages": descriptor["packages"],
            "base_vfs": descriptor["base_vfs"],
            "acceptance_vfs": identity_without_url(descriptor["acceptance_vfs"]),
            "acceptance_evidence": {
                "descriptor": identity_without_url(evidence["descriptor"]),
                "report": identity_without_url(evidence["report"]),
                "node": identity_without_url(evidence["node"]),
                "browser": identity_without_url(evidence["browser"]),
            },
            "deferred_trees": [
                {
                    "id": tree["id"],
                    **({"package": tree["package"]} if "package" in tree else {}),
                    "activation": tree["activation"],
                    "content": tree["content"],
                    "transports": [
                        runtime_layer_transport_identity(transport)
                        for transport in tree["transports"]
                    ],
                    "inventory": tree["inventory"],
                }
                for tree in descriptor["deferred_trees"]
            ],
        },
    }


def runtime_layer_transport_identity(transport: dict[str, Any]) -> dict[str, Any]:
    if transport["kind"] == "bundle-release":
        return {"kind": "bundle-release", "asset": transport["asset"]}
    return transport


def runtime_layer_bundle_sha256(descriptor: dict[str, Any]) -> str:
    assert_json_unicode_scalars(descriptor, "Homebrew runtime layer descriptor")
    canonical = json.dumps(
        runtime_layer_bundle_identity_document(descriptor),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return digest_bytes(canonical)


def runtime_layer_descriptor_bytes(descriptor: dict[str, Any]) -> bytes:
    """Return the normative canonical-json-v1 public descriptor encoding."""
    assert_json_unicode_scalars(descriptor, "Homebrew runtime layer descriptor")
    return (
        json.dumps(
            descriptor,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        + "\n"
    ).encode("utf-8")


def close_lazy_layer_descriptor(
    draft: dict[str, Any],
    *,
    tap_repository: str,
    runtime_id: str,
    image_value: bytes,
    payload_values: dict[str, bytes],
    vfs_descriptor_value: bytes,
    report_value: bytes,
    node_value: bytes,
    browser_value: bytes,
) -> dict[str, Any]:
    if (
        draft.get("schema") not in (4, 5)
        or draft.get("kind") != "kandelo-homebrew-deferred-layer-draft"
    ):
        fail("Homebrew lazy layer closer received a non-draft descriptor")
    closed = json.loads(json.dumps(draft))
    closed["kind"] = "kandelo-homebrew-deferred-layer"
    tree_assets = []
    for tree in closed["deferred_trees"]:
        transports = tree["transports"]
        release_transports = [
            transport for transport in transports
            if transport.get("kind") == "bundle-release"
        ]
        if len(release_transports) != 1:
            fail("Homebrew lazy layer draft must have exactly one bundle release asset")
        asset = release_transports[0]["asset"]
        payload = payload_values.get(asset)
        if payload is None:
            fail(f"Homebrew lazy layer closer is missing payload {asset}")
        tree_assets.append({
            "id": tree["id"],
            "asset": asset,
            "sha256": tree["content"]["sha256"],
            "bytes": tree["content"]["bytes"],
        })
        exact(
            {"sha256": tree["content"]["sha256"], "bytes": tree["content"]["bytes"]},
            {"sha256": digest_bytes(payload), "bytes": len(payload)},
            f"Homebrew runtime-layer payload identity {tree['id']}",
        )
    exact(
        set(payload_values),
        {asset["asset"] for asset in tree_assets},
        "Homebrew runtime-layer payload set",
    )

    acceptance_vfs = asset_identity(IMAGE_ASSET, image_value)
    exact(
        closed.get("acceptance_vfs"),
        acceptance_vfs,
        "Homebrew lazy layer draft acceptance VFS",
    )
    identities = {
        "acceptance_vfs": acceptance_vfs,
        "acceptance_descriptor": asset_identity(
            DESCRIPTOR_ASSET, vfs_descriptor_value
        ),
        "acceptance_report": asset_identity(REPORT_ASSET, report_value),
        "acceptance_node_evidence": asset_identity(NODE_ASSET, node_value),
        "acceptance_browser_evidence": asset_identity(
            BROWSER_ASSET, browser_value
        ),
        "deferred_trees": tree_assets,
    }
    closed["bundle"] = {
        "schema": 1,
        "kind": "kandelo-homebrew-runtime-layer-bundle",
        "algorithm": "sha256-canonical-json-v1",
        "descriptor_encoding": "canonical-json-v1",
        "sha256": "0" * 64,
        "assets": identities,
    }
    acceptance_tag = f"homebrew-vfs-sha256-{acceptance_vfs['sha256']}"
    acceptance_root = (
        f"https://github.com/{tap_repository}/releases/download/{acceptance_tag}"
    )

    def release_asset(identity: dict[str, Any]) -> dict[str, Any]:
        return {
            **identity,
            "url": f"{acceptance_root}/{identity['asset']}",
        }

    closed["acceptance_vfs"] = release_asset(acceptance_vfs)
    closed["acceptance_evidence"] = {
        "descriptor": release_asset(identities["acceptance_descriptor"]),
        "report": release_asset(identities["acceptance_report"]),
        "node": release_asset(identities["acceptance_node_evidence"]),
        "browser": release_asset(identities["acceptance_browser_evidence"]),
    }
    placeholder_tag = RUNTIME_LAYER_TAG_PREFIX + "0" * 64
    closed["release"] = {
        "repository": tap_repository,
        "tag": placeholder_tag,
    }
    placeholder_root = (
        f"https://github.com/{tap_repository}/releases/download/{placeholder_tag}"
    )
    for tree in closed["deferred_trees"]:
        tree["transports"] = [
            {
                **transport,
                "url": f"{placeholder_root}/{transport['asset']}",
            }
            if transport["kind"] == "bundle-release"
            else transport
            for transport in tree["transports"]
        ]

    bundle_sha = runtime_layer_bundle_sha256(closed)
    release_tag = RUNTIME_LAYER_TAG_PREFIX + bundle_sha
    release_root = (
        f"https://github.com/{tap_repository}/releases/download/{release_tag}"
    )
    closed["bundle"]["sha256"] = bundle_sha
    closed["release"]["tag"] = release_tag
    for tree in closed["deferred_trees"]:
        for transport in tree["transports"]:
            if transport["kind"] == "bundle-release":
                transport["url"] = f"{release_root}/{transport['asset']}"
    return closed


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
    _, descriptor_asset = lazy_layer_asset_names(runtime_id)
    descriptor_value, _ = read_json(
        path / descriptor_asset, "Homebrew lazy layer descriptor"
    )
    tree_assets = deferred_tree_asset_names(
        record(descriptor_value, "Homebrew lazy layer descriptor"), runtime_id
    )
    names = {entry.name for entry in path.iterdir()}
    expected = expected_assets(runtime_id, tree_assets)
    if names != expected:
        fail(f"VFS release handoff has unexpected entries: {sorted(names ^ expected)}")
    for name in expected:
        regular_file(
            path / name,
            f"VFS release handoff {name}",
            MAX_VFS_BYTES
            if name == IMAGE_ASSET
            else MAX_LAZY_LAYER_ARCHIVE_BYTES
            if name in tree_assets
            else MAX_JSON_BYTES,
        )


def common_kwargs(args: argparse.Namespace, root: Path) -> dict[str, Any]:
    return {
        "image_path": root / IMAGE_ASSET,
        "report_path": root / REPORT_ASSET,
        "node_path": root / NODE_ASSET,
        "browser_path": root / BROWSER_ASSET,
        "tap_root": Path(args.tap_root),
        "tap_checkouts": tap_checkout_map(args),
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
    lazy_layer_asset, lazy_layer_descriptor_asset = lazy_layer_asset_names(args.formula)
    draft_source_value, _ = read_json(
        Path(args.lazy_layer_descriptor), "Homebrew lazy layer draft descriptor"
    )
    draft_source = record(draft_source_value, "Homebrew lazy layer draft descriptor")
    tree_assets = deferred_tree_asset_names(draft_source, args.formula)
    root_payload_source = Path(args.lazy_layer)
    sources = {
        IMAGE_ASSET: Path(args.image),
        REPORT_ASSET: Path(args.report),
        NODE_ASSET: Path(args.node_evidence),
        BROWSER_ASSET: Path(args.browser_evidence),
        lazy_layer_descriptor_asset: Path(args.lazy_layer_descriptor),
        **{
            asset: (
                root_payload_source
                if asset == lazy_layer_asset
                else root_payload_source.parent / asset
            )
            for asset in tree_assets
        },
    }
    # Validate every source and the aggregate runtime-layer collection before
    # creating any externally visible handoff path. A failed attempt must be
    # safely retryable with the same --out value.
    aggregate_tree_bytes = 0
    for name, source in sources.items():
        maximum = (
            MAX_VFS_BYTES
            if name == IMAGE_ASSET
            else MAX_LAZY_LAYER_ARCHIVE_BYTES
            if name in tree_assets
            else MAX_JSON_BYTES
        )
        size = regular_file(source, f"release source {name}", maximum).st_size
        if name in tree_assets:
            aggregate_tree_bytes += size
            if aggregate_tree_bytes > MAX_LAZY_LAYER_ARCHIVE_BYTES:
                fail("Homebrew deferred-tree payload collection exceeds the size limit")
    for name, source in sources.items():
        read_bytes(
            source,
            f"release source {name}",
            MAX_VFS_BYTES
            if name == IMAGE_ASSET
            else MAX_LAZY_LAYER_ARCHIVE_BYTES
            if name in tree_assets
            else MAX_JSON_BYTES,
        )
    evidence_kwargs = common_kwargs(args, Path("."))
    evidence_kwargs.update({
        "image_path": sources[IMAGE_ASSET],
        "report_path": sources[REPORT_ASSET],
        "node_path": sources[NODE_ASSET],
        "browser_path": sources[BROWSER_ASSET],
    })
    result = validate_evidence(**evidence_kwargs)
    validate_lazy_layer(
        result,
        archive_path=sources[lazy_layer_asset],
        descriptor_path=sources[lazy_layer_descriptor_asset],
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        kandelo_commit=args.kandelo_commit,
        runtime_id=args.formula,
        draft=True,
        payload_paths={asset: sources[asset] for asset in tree_assets},
    )
    image_value = read_bytes(sources[IMAGE_ASSET], "VFS release image", MAX_VFS_BYTES)
    descriptor = build_descriptor(
        result,
        tap_repository=args.tap_repository,
        tap_name=args.tap_name,
        tap_commit=args.tap_commit,
        formula=args.formula,
        kandelo_commit=args.kandelo_commit,
        image_value=image_value,
    )
    vfs_descriptor_value = descriptor_bytes(descriptor)
    closed_layer = close_lazy_layer_descriptor(
        draft_source,
        tap_repository=args.tap_repository,
        runtime_id=args.formula,
        image_value=image_value,
        payload_values={
            asset: read_bytes(
                sources[asset],
                f"Homebrew deferred-tree payload {asset}",
                MAX_LAZY_LAYER_ARCHIVE_BYTES,
            )
            for asset in tree_assets
        },
        vfs_descriptor_value=vfs_descriptor_value,
        report_value=result["report_bytes"],
        node_value=result["node_bytes"],
        browser_value=result["browser_bytes"],
    )
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent))
    try:
        for name, source in sources.items():
            shutil.copyfile(source, stage / name, follow_symlinks=False)
        (stage / DESCRIPTOR_ASSET).write_bytes(vfs_descriptor_value)
        (stage / lazy_layer_descriptor_asset).write_bytes(
            runtime_layer_descriptor_bytes(closed_layer)
        )
        validation_args = argparse.Namespace(**vars(args))
        validation_args.handoff = str(stage)
        validate(validation_args)
        if output.exists() or output.is_symlink():
            fail("VFS release handoff output appeared during preparation")
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
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
        sub.add_argument("--dependency-tap-root", action="append", default=[])
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
