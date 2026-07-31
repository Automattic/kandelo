#!/usr/bin/env python3
"""Create and verify the bounded public browser-proof runtime handoff."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
from typing import Any, Iterable
from urllib.parse import urlsplit


SCHEMA = 1
KIND = "kandelo-homebrew-browser-proof-runtime-handoff"
NODE_MAJOR = 24
PLAYWRIGHT_VERSION = "1.61.0"
MAX_FILE_COUNT = 4_096
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = 512 * 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_PATH_BYTES = 512
PAYLOAD_MODE = 0o644
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REF_RE = re.compile(r"^[0-9a-f]{40}$")

DIST_PREFIX = PurePosixPath("browser/apps/browser-demos/dist")
FIXTURE_DESTINATION = PurePosixPath(
    "browser/fixture/homebrew-guest-lifecycle.json"
)
SOURCE_FILE_MAP = {
    "apps/browser-demos/test/homebrew-guest-lifecycle.spec.ts":
        "browser/apps/browser-demos/test/homebrew-guest-lifecycle.spec.ts",
    "homebrew/test/browser-proof-runtime/package-lock.json":
        "browser/package-lock.json",
    "homebrew/test/browser-proof-runtime/package.json":
        "browser/package.json",
    "homebrew/test/browser-proof-runtime/playwright.config.ts":
        "browser/playwright.config.ts",
    "homebrew/test/browser-proof-runtime/serve-sealed-dist.mjs":
        "browser/serve-sealed-dist.mjs",
    "homebrew/test/homebrew_guest_lifecycle_browser_fixture.ts":
        "browser/homebrew/test/homebrew_guest_lifecycle_browser_fixture.ts",
    "homebrew/test/homebrew_guest_lifecycle_contract.ts":
        "browser/homebrew/test/homebrew_guest_lifecycle_contract.ts",
    "homebrew/test/homebrew_guest_lifecycle_progress.ts":
        "browser/homebrew/test/homebrew_guest_lifecycle_progress.ts",
    "host/src/homebrew-bottle-mirror-plan.ts":
        "browser/host/src/homebrew-bottle-mirror-plan.ts",
    "host/src/homebrew-runtime-layer-limits.ts":
        "browser/host/src/homebrew-runtime-layer-limits.ts",
    "host/src/vfs/closed-lazy-assets.ts":
        "browser/host/src/vfs/closed-lazy-assets.ts",
    "host/src/vfs/deferred-tree-limits.ts":
        "browser/host/src/vfs/deferred-tree-limits.ts",
    "scripts/homebrew-closed-lazy-assets-contract.ts":
        "browser/scripts/homebrew-closed-lazy-assets-contract.ts",
}
REQUIRED_DIST_FILES = {
    DIST_PREFIX / "index.html",
    DIST_PREFIX / "pages/homebrew-vfs-test/index.html",
    DIST_PREFIX / "service-worker.js",
}
REQUIRED_FIXED_FILES = {
    PurePosixPath(destination) for destination in SOURCE_FILE_MAP.values()
} | {FIXTURE_DESTINATION}


class HandoffError(RuntimeError):
    """A handoff violates the browser-proof boundary."""


class DuplicateJsonKey(HandoffError):
    """JSON declared the same object member more than once."""


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(f"JSON duplicates object key: {key}")
        result[key] = value
    return result


def _decode_json(data: bytes, label: str) -> Any:
    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=_strict_object,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {value}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise HandoffError(f"{label} is not strict UTF-8 JSON: {error}") from error


def _canonical_json(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_exact_keys(
    value: Any,
    expected: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        raise HandoffError(f"{label} has unknown or missing fields")
    return value


def _validate_ref(value: str, label: str) -> None:
    if not REF_RE.fullmatch(value):
        raise HandoffError(f"{label} must be an exact lowercase commit SHA")


def _validate_relative_path(value: Any) -> PurePosixPath:
    if not isinstance(value, str) or value == "":
        raise HandoffError("manifest file path must be a non-empty string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise HandoffError("manifest file path is not valid UTF-8") from error
    if len(encoded) > MAX_PATH_BYTES:
        raise HandoffError("manifest file path exceeds its byte bound")
    if "\\" in value or "\0" in value:
        raise HandoffError(f"manifest file path is unsafe: {value!r}")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or value != path.as_posix()
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise HandoffError(f"manifest file path is unsafe: {value!r}")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _regular_file(path: Path, label: str) -> os.stat_result:
    try:
        details = path.lstat()
    except FileNotFoundError as error:
        raise HandoffError(f"{label} does not exist: {path}") from error
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise HandoffError(f"{label} must be a regular non-symlink file: {path}")
    return details


def _regular_directory(path: Path, label: str) -> os.stat_result:
    try:
        details = path.lstat()
    except FileNotFoundError as error:
        raise HandoffError(f"{label} does not exist: {path}") from error
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise HandoffError(
            f"{label} must be a regular non-symlink directory: {path}"
        )
    return details


def _source_file(source_root: Path, relative: str) -> Path:
    current = source_root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            details = current.lstat()
        except FileNotFoundError as error:
            raise HandoffError(
                f"runtime source does not exist: {relative}"
            ) from error
        if stat.S_ISLNK(details.st_mode):
            raise HandoffError(f"runtime source traverses a symlink: {relative}")
    _regular_file(current, "runtime source")
    return current


def _scan_tree(root: Path) -> tuple[dict[PurePosixPath, os.stat_result], set[PurePosixPath]]:
    files: dict[PurePosixPath, os.stat_result] = {}
    directories: set[PurePosixPath] = set()

    def visit(directory: Path, relative: PurePosixPath) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as error:
            raise HandoffError(f"cannot inspect handoff tree: {error}") from error
        for entry in entries:
            child_relative = (
                PurePosixPath(entry.name)
                if relative == PurePosixPath(".")
                else relative / entry.name
            )
            _validate_relative_path(child_relative.as_posix())
            details = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(details.st_mode):
                raise HandoffError(
                    f"handoff contains a symlink: {child_relative.as_posix()}"
                )
            if stat.S_ISDIR(details.st_mode):
                directories.add(child_relative)
                visit(Path(entry.path), child_relative)
            elif stat.S_ISREG(details.st_mode):
                files[child_relative] = details
            else:
                raise HandoffError(
                    "handoff contains a special file: "
                    f"{child_relative.as_posix()}"
                )

    visit(root, PurePosixPath("."))
    return files, directories


def _validate_public_fixture(data: bytes) -> None:
    fixture = _require_exact_keys(
        _decode_json(data, "browser lifecycle fixture"),
        {
            "schema",
            "allowLiveNetwork",
            "transportMode",
            "image",
            "bootstrap",
            "bottleMirror",
            "revisions",
            "timeoutMs",
        },
        "browser lifecycle fixture",
    )
    if (
        fixture["schema"] != 1
        or fixture["allowLiveNetwork"] is not True
        or fixture["transportMode"] != "public"
    ):
        raise HandoffError(
            "browser lifecycle fixture must opt into public transport"
        )

    bootstrap = _require_exact_keys(
        fixture["bootstrap"],
        {"spec", "archive", "environment"},
        "browser lifecycle fixture bootstrap",
    )
    mirror = _require_exact_keys(
        fixture["bottleMirror"],
        {"plan"},
        "browser lifecycle fixture bottle mirror",
    )
    for label, asset in [
        ("image", fixture["image"]),
        ("bootstrap spec", bootstrap["spec"]),
        ("bootstrap archive", bootstrap["archive"]),
        ("bootstrap environment", bootstrap["environment"]),
        ("bottle mirror plan", mirror["plan"]),
    ]:
        _validate_exact_asset(asset, label)

    revisions = _require_exact_keys(
        fixture["revisions"],
        {"coreRevision", "canaryRevision"},
        "browser lifecycle fixture revisions",
    )
    for label in ("coreRevision", "canaryRevision"):
        value = revisions[label]
        if not isinstance(value, str) or not REF_RE.fullmatch(value):
            raise HandoffError(
                f"browser lifecycle fixture {label} is not an exact commit SHA"
            )
    timeout = fixture["timeoutMs"]
    if not _is_integer(timeout) or timeout < 1_000 or timeout > 1_800_000:
        raise HandoffError("browser lifecycle fixture timeout is out of bounds")


def _validate_exact_asset(value: Any, label: str) -> None:
    asset = _require_exact_keys(
        value,
        {"url", "sha256", "bytes"},
        f"browser lifecycle fixture {label}",
    )
    url = asset["url"]
    if not isinstance(url, str):
        raise HandoffError(f"browser lifecycle fixture {label} URL is invalid")
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError as error:
        raise HandoffError(
            f"browser lifecycle fixture {label} URL is invalid"
        ) from error
    if (
        parsed.scheme != "https"
        or hostname is None
        or username is not None
        or password is not None
        or parsed.fragment != ""
    ):
        raise HandoffError(f"browser lifecycle fixture {label} URL is invalid")
    sha256 = asset["sha256"]
    if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
        raise HandoffError(
            f"browser lifecycle fixture {label} SHA-256 is invalid"
        )
    size = asset["bytes"]
    if not _is_integer(size) or size < 1 or size > MAX_FILE_BYTES:
        raise HandoffError(
            f"browser lifecycle fixture {label} byte size is invalid"
        )


def _copy_payload(source: Path, destination: Path) -> None:
    details = _regular_file(source, "handoff input")
    if details.st_size > MAX_FILE_BYTES:
        raise HandoffError(f"handoff input exceeds the per-file bound: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(PAYLOAD_MODE)


def _copy_dist(dist: Path, staging: Path) -> None:
    _regular_directory(dist, "sealed browser dist")

    def visit(directory: Path, relative: PurePosixPath) -> None:
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            child_relative = relative / entry.name
            _validate_relative_path(child_relative.as_posix())
            details = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(details.st_mode):
                raise HandoffError(
                    "sealed browser dist contains a symlink: "
                    f"{child_relative.as_posix()}"
                )
            if stat.S_ISDIR(details.st_mode):
                visit(Path(entry.path), child_relative)
            elif stat.S_ISREG(details.st_mode):
                _copy_payload(
                    Path(entry.path),
                    staging / child_relative.as_posix(),
                )
            else:
                raise HandoffError(
                    "sealed browser dist contains a special file: "
                    f"{child_relative.as_posix()}"
                )

    visit(dist, DIST_PREFIX)


def _git_output(source_root: Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(source_root), *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise HandoffError(
            f"cannot inspect browser runtime source checkout: {error}"
        ) from error
    return result.stdout.strip()


def _require_node_major() -> None:
    try:
        result = subprocess.run(
            ["node", "-p", 'process.versions.node.split(".")[0]'],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise HandoffError(f"cannot inspect the Node.js runtime: {error}") from error
    actual_major = result.stdout.strip()
    if actual_major != str(NODE_MAJOR):
        reported_major = actual_major[:32] or "<empty>"
        raise HandoffError(
            "browser proof runtime requires "
            f"Node.js {NODE_MAJOR}; found {reported_major}"
        )


def create_handoff(
    *,
    source_root: Path,
    dist: Path,
    fixture: Path,
    product_kandelo_ref: str,
    runtime_source_ref: str,
    output: Path,
) -> None:
    _validate_ref(product_kandelo_ref, "product Kandelo authority")
    _validate_ref(runtime_source_ref, "browser runtime source authority")
    _require_node_major()
    _regular_directory(source_root, "browser runtime source root")
    _regular_file(fixture, "public browser lifecycle fixture")
    if _git_output(source_root, "rev-parse", "HEAD") != runtime_source_ref:
        raise HandoffError(
            "browser runtime checkout does not match --runtime-source-ref"
        )
    dirty_source = _git_output(
        source_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    )
    if dirty_source:
        # Porcelain v1 quotes unusual path bytes, so this bounded preview is
        # useful in CI without allowing an arbitrary filename to flood logs.
        preview = "; ".join(dirty_source.splitlines()[:8])[:512]
        raise HandoffError(
            f"browser runtime source checkout is not clean: {preview}"
        )
    if output.exists() or output.is_symlink():
        raise HandoffError(f"browser runtime output already exists: {output}")

    output_parent = output.parent.resolve(strict=True)
    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{output.name}.",
            dir=output_parent,
        )
    )
    try:
        for source_relative, destination_relative in sorted(
            SOURCE_FILE_MAP.items()
        ):
            _copy_payload(
                _source_file(source_root, source_relative),
                staging / destination_relative,
            )
        _copy_dist(dist, staging)
        _copy_payload(fixture, staging / FIXTURE_DESTINATION.as_posix())
        fixture_bytes = (
            staging / FIXTURE_DESTINATION.as_posix()
        ).read_bytes()
        _validate_public_fixture(fixture_bytes)

        files, _directories = _scan_tree(staging)
        records = []
        total_bytes = 0
        for relative in sorted(files, key=lambda path: path.as_posix()):
            details = files[relative]
            total_bytes += details.st_size
            records.append(
                {
                    "path": relative.as_posix(),
                    "bytes": details.st_size,
                    "sha256": _sha256(staging / relative.as_posix()),
                    "mode": f"{stat.S_IMODE(details.st_mode):04o}",
                }
            )
        manifest = {
            "schema": SCHEMA,
            "kind": KIND,
            "authorities": {
                "product_kandelo_ref": product_kandelo_ref,
                "runtime_source_ref": runtime_source_ref,
            },
            "runtime": {
                "node_major": NODE_MAJOR,
                "playwright_version": PLAYWRIGHT_VERSION,
            },
            "limits": {
                "max_file_count": MAX_FILE_COUNT,
                "max_file_bytes": MAX_FILE_BYTES,
                "max_path_bytes": MAX_PATH_BYTES,
                "max_total_bytes": MAX_TOTAL_BYTES,
            },
            "total_bytes": total_bytes,
            "files": records,
        }
        manifest_path = staging / "handoff.json"
        manifest_path.write_bytes(_canonical_json(manifest))
        manifest_path.chmod(PAYLOAD_MODE)
        verify_handoff(
            root=staging,
            product_kandelo_ref=product_kandelo_ref,
            runtime_source_ref=runtime_source_ref,
        )
        staging.rename(output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _validate_manifest(
    manifest: Any,
    *,
    product_kandelo_ref: str,
    runtime_source_ref: str,
) -> list[dict[str, Any]]:
    document = _require_exact_keys(
        manifest,
        {
            "schema",
            "kind",
            "authorities",
            "runtime",
            "limits",
            "total_bytes",
            "files",
        },
        "browser runtime manifest",
    )
    if document["schema"] != SCHEMA or document["kind"] != KIND:
        raise HandoffError("browser runtime manifest identity is invalid")
    if document["authorities"] != {
        "product_kandelo_ref": product_kandelo_ref,
        "runtime_source_ref": runtime_source_ref,
    }:
        raise HandoffError("browser runtime manifest authority differs")
    if document["runtime"] != {
        "node_major": NODE_MAJOR,
        "playwright_version": PLAYWRIGHT_VERSION,
    }:
        raise HandoffError("browser runtime requirements differ")
    if document["limits"] != {
        "max_file_count": MAX_FILE_COUNT,
        "max_file_bytes": MAX_FILE_BYTES,
        "max_path_bytes": MAX_PATH_BYTES,
        "max_total_bytes": MAX_TOTAL_BYTES,
    }:
        raise HandoffError("browser runtime manifest limits differ")
    total_bytes = document["total_bytes"]
    if (
        not _is_integer(total_bytes)
        or total_bytes < 1
        or total_bytes > MAX_TOTAL_BYTES
    ):
        raise HandoffError("browser runtime manifest total is invalid")
    records = document["files"]
    if (
        not isinstance(records, list)
        or not records
        or len(records) > MAX_FILE_COUNT
    ):
        raise HandoffError("browser runtime manifest file count is invalid")
    return records


def _expected_directories(paths: Iterable[PurePosixPath]) -> set[PurePosixPath]:
    directories: set[PurePosixPath] = set()
    for path in paths:
        parent = path.parent
        while parent != PurePosixPath("."):
            directories.add(parent)
            parent = parent.parent
    return directories


def _validate_package(root: Path) -> None:
    package = _require_exact_keys(
        _decode_json((root / "browser/package.json").read_bytes(), "package"),
        {"name", "version", "private", "type", "devDependencies", "engines"},
        "browser runtime package",
    )
    if package != {
        "name": "kandelo-homebrew-browser-proof-runtime",
        "version": "1.0.0",
        "private": True,
        "type": "module",
        "devDependencies": {"@playwright/test": PLAYWRIGHT_VERSION},
        "engines": {"node": ">=24 <25"},
    }:
        raise HandoffError("browser runtime package identity differs")
    lock = _require_exact_keys(
        _decode_json(
            (root / "browser/package-lock.json").read_bytes(),
            "package lock",
        ),
        {"name", "version", "lockfileVersion", "requires", "packages"},
        "browser runtime package lock",
    )
    packages = lock["packages"]
    expected_package_keys = {
        "",
        "node_modules/@playwright/test",
        "node_modules/fsevents",
        "node_modules/playwright",
        "node_modules/playwright-core",
    }
    if (
        lock["name"] != package["name"]
        or lock["version"] != package["version"]
        or lock["lockfileVersion"] != 3
        or lock["requires"] is not True
        or not isinstance(packages, dict)
        or set(packages) != expected_package_keys
        or not all(
            isinstance(packages[key], dict) for key in expected_package_keys
        )
        or packages[""].get("devDependencies") != package["devDependencies"]
        or packages[""].get("engines") != package["engines"]
        or packages["node_modules/@playwright/test"].get("version")
        != PLAYWRIGHT_VERSION
        or packages["node_modules/playwright"].get("version")
        != PLAYWRIGHT_VERSION
        or packages["node_modules/playwright-core"].get("version")
        != PLAYWRIGHT_VERSION
    ):
        raise HandoffError("browser runtime package lock differs")


def verify_handoff(
    *,
    root: Path,
    product_kandelo_ref: str,
    runtime_source_ref: str,
) -> None:
    _validate_ref(product_kandelo_ref, "product Kandelo authority")
    _validate_ref(runtime_source_ref, "browser runtime source authority")
    _require_node_major()
    _regular_directory(root, "browser runtime handoff root")
    manifest_path = root / "handoff.json"
    manifest_details = _regular_file(
        manifest_path,
        "browser runtime manifest",
    )
    if (
        manifest_details.st_size < 1
        or manifest_details.st_size > MAX_MANIFEST_BYTES
        or stat.S_IMODE(manifest_details.st_mode) != PAYLOAD_MODE
    ):
        raise HandoffError("browser runtime manifest size or mode is invalid")
    manifest_bytes = manifest_path.read_bytes()
    manifest = _decode_json(manifest_bytes, "browser runtime manifest")
    if manifest_bytes != _canonical_json(manifest):
        raise HandoffError("browser runtime manifest is not canonical JSON")
    records = _validate_manifest(
        manifest,
        product_kandelo_ref=product_kandelo_ref,
        runtime_source_ref=runtime_source_ref,
    )

    expected: dict[PurePosixPath, dict[str, Any]] = {}
    declared_total = 0
    for value in records:
        record = _require_exact_keys(
            value,
            {"path", "bytes", "sha256", "mode"},
            "browser runtime file record",
        )
        path = _validate_relative_path(record["path"])
        if path == PurePosixPath("handoff.json") or path in expected:
            raise HandoffError(
                f"browser runtime manifest repeats a file: {path.as_posix()}"
            )
        size = record["bytes"]
        sha256 = record["sha256"]
        if (
            not _is_integer(size)
            or size < 0
            or size > MAX_FILE_BYTES
            or not isinstance(sha256, str)
            or not SHA256_RE.fullmatch(sha256)
            or record["mode"] != "0644"
        ):
            raise HandoffError(
                f"browser runtime file record is invalid: {path.as_posix()}"
            )
        expected[path] = record
        declared_total += size
    if declared_total != manifest["total_bytes"]:
        raise HandoffError("browser runtime manifest byte total differs")

    declared_paths = set(expected)
    if not REQUIRED_FIXED_FILES.issubset(declared_paths):
        raise HandoffError("browser runtime manifest omits a required source")
    if not REQUIRED_DIST_FILES.issubset(declared_paths):
        raise HandoffError("browser runtime manifest omits a required dist file")
    permitted_fixed = REQUIRED_FIXED_FILES
    for path in declared_paths:
        if path in permitted_fixed:
            continue
        if path == DIST_PREFIX or DIST_PREFIX not in path.parents:
            raise HandoffError(
                f"browser runtime manifest declares an unexpected file: {path}"
            )

    actual_files, actual_directories = _scan_tree(root)
    expected_files = declared_paths | {PurePosixPath("handoff.json")}
    if set(actual_files) != expected_files:
        raise HandoffError("browser runtime handoff inventory differs")
    expected_directories = _expected_directories(expected_files)
    if actual_directories != expected_directories:
        raise HandoffError("browser runtime handoff directory layout differs")

    actual_total = 0
    for path, record in expected.items():
        details = actual_files[path]
        actual_mode = stat.S_IMODE(details.st_mode)
        actual_total += details.st_size
        if (
            actual_mode != PAYLOAD_MODE
            or details.st_size != record["bytes"]
            or _sha256(root / path.as_posix()) != record["sha256"]
        ):
            raise HandoffError(
                f"browser runtime member differs: {path.as_posix()}"
            )
    if actual_total != manifest["total_bytes"]:
        raise HandoffError("browser runtime handoff byte total differs")

    _validate_package(root)
    _validate_public_fixture(
        (root / FIXTURE_DESTINATION.as_posix()).read_bytes()
    )


def _create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--dist", required=True, type=Path)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--product-kandelo-ref", required=True)
    parser.add_argument("--runtime-source-ref", required=True)
    parser.add_argument("--out", required=True, type=Path)
    return parser


def _verify_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--product-kandelo-ref", required=True)
    parser.add_argument("--runtime-source-ref", required=True)
    return parser


def main(arguments: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("create", "verify"))
    namespace, remaining = parser.parse_known_args(arguments)
    try:
        if namespace.operation == "create":
            options = _create_parser().parse_args(remaining)
            create_handoff(
                source_root=options.source_root,
                dist=options.dist,
                fixture=options.fixture,
                product_kandelo_ref=options.product_kandelo_ref,
                runtime_source_ref=options.runtime_source_ref,
                output=options.out,
            )
            print("create-homebrew-browser-proof-runtime-handoff.sh: ok")
        else:
            options = _verify_parser().parse_args(remaining)
            verify_handoff(
                root=options.root,
                product_kandelo_ref=options.product_kandelo_ref,
                runtime_source_ref=options.runtime_source_ref,
            )
            print("verify-homebrew-browser-proof-runtime-handoff.sh: ok")
    except HandoffError as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
