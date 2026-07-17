#!/usr/bin/env python3
"""Compose and validate deterministic Homebrew-native OCI bottle layouts."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import pathlib
import posixpath
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from typing import Any, BinaryIO, NoReturn


OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip"
FORMULA_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
PKG_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
OCI_TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
TAP_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
CANONICAL_UINT = re.compile(r"^(0|[1-9][0-9]*)$")
OCI_REMOTE = re.compile(
    r"^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$"
)
MAXIMUM_OCI_TAG = "z" * 128


def publication_limits() -> tuple[int, int, int, int]:
    script = pathlib.Path(__file__).with_name("homebrew-publication-limits.sh")
    names = (
        "HOMEBREW_MAX_MANIFEST_BYTES",
        "HOMEBREW_MAX_BOTTLE_JSON_BYTES",
        "HOMEBREW_MAX_BOTTLE_BYTES",
        "HOMEBREW_MAX_EXPANDED_BOTTLE_BYTES",
    )
    command = 'set -euo pipefail; source "$1"; printf "%s\\n" ' + " ".join(
        f'"${{{name}}}"' for name in names
    )
    result = subprocess.run(
        ["bash", "-c", command, "homebrew-publication-limits", str(script)],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
    )
    values = result.stdout.decode("ascii", errors="strict").splitlines()
    if result.returncode != 0 or len(values) != len(names):
        detail = result.stderr.decode("utf-8", errors="replace")[:4096]
        raise RuntimeError(f"cannot load Homebrew publication limits: {detail}")
    if any(CANONICAL_UINT.fullmatch(value) is None or int(value, 10) < 1 for value in values):
        raise RuntimeError("Homebrew publication limits are not positive canonical integers")
    parsed = tuple(int(value, 10) for value in values)
    return parsed[0], parsed[1], parsed[2], parsed[3]


(
    MAX_MANIFEST_BYTES,
    MAX_JSON,
    MAX_BOTTLE_BYTES,
    MAX_EXPANDED_BOTTLE_BYTES,
) = publication_limits()
MAX_ARCHIVE_ENTRIES = 200_000
MAX_ARCHIVE_PATH_BYTES = 4_096
MAX_FORMULA_BYTES = 1024 * 1024
MAX_RECEIPT_BYTES = 16 * 1024 * 1024
MAX_TAB_BYTES = 1024 * 1024
MAX_LINK_DEPTH = 256
MAX_ANNOTATION_BYTES = 1024 * 1024
MAX_SUPPORT_FILES = 4_096
MAX_SUPPORT_BYTES = 64 * 1024 * 1024


class LayoutError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise LayoutError(message)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{label} must be a non-empty string")
    if "\0" in value or pattern is not None and pattern.fullmatch(value) is None:
        fail(f"{label} has an invalid value: {value!r}")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} must be an integer >= {minimum}")
    return value


def require_decimal_string(value: Any, label: str, minimum: int = 0) -> int:
    text = require_string(value, label, CANONICAL_UINT)
    number = int(text, 10)
    if number < minimum:
        fail(f"{label} must be a canonical decimal integer >= {minimum}")
    return number


def require_bounded_json(value: Any, label: str, depth: int = 0) -> None:
    if depth > 16:
        fail(f"{label} exceeds the maximum nesting depth")
    if value is None or isinstance(value, (bool, int, str)):
        if isinstance(value, str) and ("\0" in value or len(value.encode("utf-8")) > MAX_TAB_BYTES):
            fail(f"{label} contains an invalid string")
        return
    if isinstance(value, list):
        if len(value) > 512:
            fail(f"{label} contains too many array values")
        for index, child in enumerate(value):
            require_bounded_json(child, f"{label}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 128:
            fail(f"{label} contains too many object fields")
        for key, child in value.items():
            require_string(key, f"{label} field name")
            require_bounded_json(child, f"{label}.{key}", depth + 1)
        return
    fail(f"{label} contains an unsupported JSON value")


def regular_file(path: pathlib.Path, label: str, maximum: int | None = None) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a regular non-symlink file: {path}")
    if maximum is not None and metadata.st_size > maximum:
        fail(f"{label} exceeds {maximum} bytes")
    return path


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{label} does not exist: {path}")
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a real directory: {path}")
    return path


def load_json(path: pathlib.Path, label: str, maximum: int = MAX_JSON) -> Any:
    regular_file(path, label, maximum)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid UTF-8 JSON: {error}")


def canonical_json(document: Any) -> bytes:
    payload = json.dumps(
        document, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    if len(payload) > MAX_JSON:
        fail(f"OCI JSON exceeds {MAX_JSON} bytes")
    return payload


def write_json(path: pathlib.Path, document: Any, *, canonical: bool = False) -> None:
    payload = canonical_json(document) if canonical else (
        json.dumps(document, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        fail(f"refusing to replace symlink output: {path}")
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def prepare_output_directory(path: pathlib.Path) -> pathlib.Path:
    if path.exists() or path.is_symlink():
        real_directory(path, "OCI layout output")
        if any(path.iterdir()):
            fail(f"OCI layout output must be empty: {path}")
    else:
        path.mkdir(parents=True)
    return path.resolve()


def validate_arguments(args: argparse.Namespace) -> None:
    require_string(args.formula, "formula", FORMULA_NAME)
    if args.arch not in ("wasm32", "wasm64"):
        fail(f"unsupported architecture: {args.arch}")
    require_int(args.abi, "ABI", 1)
    require_string(args.tap_repository, "tap repository", TAP_REPOSITORY)
    selected_tap_name(args)
    require_string(args.tap_commit, "tap commit", COMMIT)
    require_string(args.kandelo_commit, "Kandelo commit", COMMIT)
    expected_root = f"https://ghcr.io/v2/{args.tap_repository.lower()}"
    if args.bottle_root_url != expected_root:
        fail(f"bottle root URL must be {expected_root}")


def normalized_identity(value: str) -> str:
    return value.lower()


def tap_name_for_repository(repository_value: str) -> str:
    repository = normalized_identity(repository_value)
    require_string(repository, "tap repository", TAP_REPOSITORY)
    owner, repository_name = repository.split("/", 1)
    if repository == "automattic/kandelo-homebrew":
        return repository
    if not repository_name.startswith("homebrew-") or repository_name == "homebrew-":
        fail("third-party tap repositories must use owner/homebrew-name")
    tap_name = f"{owner}/{repository_name.removeprefix('homebrew-')}"
    if tap_name == "automattic/kandelo-homebrew":
        fail("the protected first-party tap name cannot be derived from another repository")
    return tap_name


def selected_tap_name(args: argparse.Namespace) -> str:
    repository = normalized_identity(args.tap_repository)
    expected = tap_name_for_repository(repository)
    requested = getattr(args, "tap_name", None)
    if requested is None:
        if repository != "automattic/kandelo-homebrew":
            fail("tap name is required when repository and Homebrew identities may differ")
        requested = args.tap_repository
    require_string(requested, "tap name", TAP_REPOSITORY)
    selected = normalized_identity(requested)
    if selected != expected:
        fail("tap name does not match the tap repository")
    return selected


def formula_revision(pkg_version: str) -> int:
    match = re.search(r"_([1-9][0-9]*)$", pkg_version)
    return int(match.group(1), 10) if match else 0


def top_reference(pkg_version: str, rebuild: int) -> str:
    value = f"{pkg_version}-{rebuild}" if rebuild else pkg_version
    require_string(value, "Homebrew top reference", OCI_TAG)
    return value


def child_reference(pkg_version: str, tag: str, rebuild: int) -> str:
    value = f"{pkg_version}.{tag}"
    if rebuild:
        value += f".{rebuild}"
    require_string(value, "Homebrew child reference", OCI_TAG)
    return value


def canonical_bottle(args: argparse.Namespace) -> dict[str, Any]:
    document = load_json(pathlib.Path(args.bottle_json), "canonical bottle JSON")
    if not isinstance(document, dict) or len(document) != 1:
        fail("canonical bottle JSON must contain exactly one Formula")
    key, record = next(iter(document.items()))
    if key != args.formula:
        fail("canonical bottle JSON Formula key does not match")
    record = exact_keys(record, {"formula", "bottle"}, "canonical bottle record")
    formula = exact_keys(
        record["formula"], {"name", "path", "pkg_version"}, "canonical Formula"
    )
    bottle = exact_keys(
        record["bottle"], {"root_url", "cellar", "rebuild", "tags"}, "canonical bottle"
    )
    version = require_string(formula["pkg_version"], "Formula pkg_version", PKG_VERSION)
    if formula["name"] != args.formula:
        fail("canonical Formula name does not match")
    if bottle["root_url"] != args.bottle_root_url:
        fail("canonical bottle root URL does not match")
    if bottle["cellar"] not in (
        "any",
        "any_skip_relocation",
        "/home/linuxbrew/.linuxbrew/Cellar",
    ):
        fail("canonical bottle cellar is invalid")
    rebuild = require_int(bottle["rebuild"], "bottle rebuild")
    tag_name = f"{args.arch}_kandelo"
    tags = bottle["tags"]
    if not isinstance(tags, dict) or set(tags) != {tag_name}:
        fail(f"canonical bottle JSON must contain only {tag_name}")
    tag = exact_keys(tags[tag_name], {"sha256"}, f"canonical {tag_name} tag")
    digest = require_string(tag["sha256"], "bottle digest", SHA256)
    archive = regular_file(
        pathlib.Path(args.bottle), "bottle archive", MAX_BOTTLE_BYTES
    )
    if sha256_file(archive) != digest:
        fail("bottle archive digest does not match canonical bottle JSON")
    return {
        "archive": archive,
        "bytes": archive.stat().st_size,
        "cellar": bottle["cellar"],
        "digest": digest,
        "formula_path": formula["path"],
        "pkg_version": version,
        "rebuild": rebuild,
        "tag": tag_name,
    }


def formula_identity_for_path(path: pathlib.Path, kandelo_root: pathlib.Path) -> str:
    regular_file(path, "tap Formula source", MAX_FORMULA_BYTES)
    script = regular_file(
        kandelo_root / "scripts/homebrew-formula-source-digest.rb",
        "Formula source identity tool",
        MAX_FORMULA_BYTES,
    )
    result = subprocess.run(
        ["ruby", str(script), "--identity-excluding-bottle", str(path)],
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[:4096]
        fail(f"cannot compute tap Formula source identity: {detail}")
    identity = result.stdout.decode("ascii", errors="strict").strip()
    return require_string(identity, "tap Formula source identity", SHA256)


def source_closure(
    *,
    tap_root: pathlib.Path,
    kandelo_root: pathlib.Path,
    tap_name: str,
    formula: str,
    expected_formula_identity: str | None = None,
    expected_formula_mode: str | None = None,
) -> dict[str, str]:
    tap_root = real_directory(tap_root, "tap source root")
    kandelo_root = real_directory(kandelo_root, "Kandelo source root")
    require_string(tap_name, "tap name", TAP_REPOSITORY)
    require_string(formula, "formula", FORMULA_NAME)
    formula_path = tap_root / "Formula" / f"{formula}.rb"
    tap_identity = formula_identity_for_path(formula_path, kandelo_root)
    if expected_formula_identity is not None and tap_identity != expected_formula_identity:
        fail("tap Formula source identity differs from the archived bottle Formula")
    try:
        formula_source = formula_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        fail(f"tap Formula source is not UTF-8: {error}")
    owner, repository = normalized_identity(tap_name).split("/", 1)
    require_line = (
        f'require (Tap.fetch("{owner}", "{repository}").path/'
        '"Kandelo/formula_support/kandelo_formula_support").to_s'
    )
    marker = "Kandelo/formula_support/kandelo_formula_support"
    entries: list[dict[str, Any]] = []
    if marker in formula_source:
        if formula_source.splitlines().count(require_line) != 1:
            fail("Formula support require is not canonical")
        if (
            formula_source.count("Tap.fetch") != 1
            or formula_source.count("KandeloFormulaSupport") != 1
            or "require_relative" in formula_source
        ):
            fail("Formula support reference is not a bounded canonical closure")
        if formula_source.splitlines().count("  include KandeloFormulaSupport") != 1:
            fail("Formula support include is not canonical")
        support_root = real_directory(
            tap_root / "Kandelo/formula_support", "Formula support source root"
        )
        total = 0
        for index, path in enumerate(sorted(support_root.rglob("*"))):
            if index >= MAX_SUPPORT_FILES:
                fail(f"Formula support closure exceeds {MAX_SUPPORT_FILES} entries")
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode) and not path.is_symlink():
                entries.append(
                    {
                        "mode": "040000",
                        "path": path.relative_to(tap_root).as_posix(),
                    }
                )
                continue
            if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
                fail(f"Formula support closure contains a non-regular path: {path}")
            total += metadata.st_size
            if total > MAX_SUPPORT_BYTES:
                fail(f"Formula support closure exceeds {MAX_SUPPORT_BYTES} bytes")
            relative = path.relative_to(tap_root).as_posix()
            entries.append(
                {
                    "mode": "100755" if metadata.st_mode & 0o111 else "100644",
                    "path": relative,
                    "sha256": sha256_file(path),
                }
            )
        if not any(
            entry["path"] == "Kandelo/formula_support/kandelo_formula_support.rb"
            for entry in entries
        ):
            fail("Formula support closure lacks kandelo_formula_support.rb")
    elif any(token in formula_source for token in ("Tap.fetch", "require_relative", "KandeloFormulaSupport")):
        fail("Formula has an unsupported local source reference")
    formula_mode = "100755" if formula_path.stat().st_mode & 0o111 else "100644"
    if expected_formula_mode is not None and formula_mode != expected_formula_mode:
        fail("tap Formula mode differs from the archived bottle Formula")
    closure = {
        "formula_identity_sha256": tap_identity,
        "formula_mode": formula_mode,
        "support": entries,
    }
    return {
        "formula_identity_sha256": tap_identity,
        "formula_mode": formula_mode,
        "source_closure_sha256": sha256_bytes(canonical_json(closure)),
    }


def normalize_archive_path(value: str, label: str) -> str:
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        fail(f"{label} is not UTF-8")
    while value.startswith("./"):
        value = value[2:]
    value = value.rstrip("/")
    if (
        not value
        or len(encoded) > MAX_ARCHIVE_PATH_BYTES
        or value.startswith("/")
        or "\\" in value
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        fail(f"{label} is not a safe relative POSIX path: {value!r}")
    return value


def require_payload_path(path: str, root: str, label: str) -> str:
    if path != root and not path.startswith(f"{root}/"):
        fail(f"{label} escapes bottle payload {root!r}: {path!r}")
    return path


@dataclass(frozen=True)
class ArchiveEntry:
    path: str
    kind: str
    mode: int
    size: int
    member: tarfile.TarInfo
    target: str | None


class BottleMetadata:
    def __init__(self, archive: pathlib.Path, formula: str, version: str, kandelo_root: pathlib.Path):
        self.archive_path = archive
        self.formula = formula
        self.version = version
        self.payload_root = f"{formula}/{version}"
        self.kandelo_root = kandelo_root
        self.entries: dict[str, ArchiveEntry] = {}
        self.archive: tarfile.TarFile | None = None

    def inspect(self) -> dict[str, Any]:
        try:
            self.archive = tarfile.open(self.archive_path, mode="r:gz")
        except (OSError, tarfile.TarError) as error:
            fail(f"cannot open bottle archive: {error}")
        try:
            self._inventory()
            self._validate_ancestors()
            self._validate_links()
            formula_bytes = self._required_regular(f".brew/{self.formula}.rb", MAX_FORMULA_BYTES)
            formula_entry = self.entries[
                f"{self.payload_root}/.brew/{self.formula}.rb"
            ]
            receipt_bytes = self._required_regular("INSTALL_RECEIPT.json", MAX_RECEIPT_BYTES)
            tab = self._tab(receipt_bytes)
            identity = self._formula_identity(formula_bytes)
            paths = self._path_executables()
            installed_size = sum(
                entry.size
                for entry in self.entries.values()
                if entry.path.startswith(f"{self.payload_root}/") and entry.kind == "regular"
            )
        finally:
            self.archive.close()
            self.archive = None
        diff = hashlib.sha256()
        decompressed_bytes = 0
        try:
            with gzip.open(self.archive_path, "rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    decompressed_bytes += len(chunk)
                    if decompressed_bytes > MAX_EXPANDED_BOTTLE_BYTES:
                        fail(
                            "decompressed bottle exceeds "
                            f"{MAX_EXPANDED_BOTTLE_BYTES} bytes"
                        )
                    diff.update(chunk)
        except (OSError, EOFError) as error:
            fail(f"cannot hash decompressed bottle tar: {error}")
        return {
            "diff_id": diff.hexdigest(),
            "formula_source_identity_sha256": identity,
            "formula_source_sha256": sha256_bytes(formula_bytes),
            "formula_source_mode": (
                "100755" if formula_entry.mode & 0o111 else "100644"
            ),
            "installed_size": installed_size,
            "path_exec_files": paths,
            "tab": tab,
        }

    def _inventory(self) -> None:
        assert self.archive is not None
        total = 0
        for index, member in enumerate(self.archive):
            if index >= MAX_ARCHIVE_ENTRIES:
                fail(f"bottle archive exceeds {MAX_ARCHIVE_ENTRIES} entries")
            path = normalize_archive_path(member.name, f"archive entry {index}")
            if path in self.entries:
                fail(f"bottle archive repeats path {path!r}")
            if path not in (self.formula, self.payload_root):
                require_payload_path(path, self.payload_root, f"archive entry {index}")
            if member.isdir():
                kind = "directory"
            elif member.isfile():
                kind = "regular"
            elif member.issym():
                kind = "symlink"
            elif member.islnk():
                kind = "hardlink"
            else:
                fail(f"archive entry {path!r} has an unsupported type")
            if path in (self.formula, self.payload_root) and kind != "directory":
                fail(f"bottle archive root {path!r} is not a directory")
            if member.size < 0 or member.mode < 0 or member.mode > 0o7777:
                fail(f"archive entry {path!r} has invalid metadata")
            if kind != "regular" and member.size != 0:
                fail(f"archive {kind} {path!r} unexpectedly contains data")
            total += member.size
            if total > MAX_EXPANDED_BOTTLE_BYTES:
                fail(
                    "bottle archive declares more than "
                    f"{MAX_EXPANDED_BOTTLE_BYTES} bytes"
                )
            target = None
            if kind in ("symlink", "hardlink"):
                target = self._normalize_link(member.linkname, path, hard=kind == "hardlink")
            self.entries[path] = ArchiveEntry(path, kind, member.mode, member.size, member, target)
        if not self.entries:
            fail("bottle archive is empty")

    def _normalize_link(self, value: str, source: str, *, hard: bool) -> str:
        if not value or value.startswith("/") or "\\" in value or "\0" in value:
            fail(f"archive link {source!r} has an unsafe target")
        if hard:
            while value.startswith("./"):
                value = value[2:]
            resolved = posixpath.normpath(value)
        else:
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), value))
        if resolved in ("", ".", "..") or resolved.startswith("../") or resolved.startswith("/"):
            fail(f"archive link {source!r} escapes the archive")
        return require_payload_path(resolved, self.payload_root, f"archive link {source!r}")

    def _validate_ancestors(self) -> None:
        for path in self.entries:
            parts = path.split("/")
            for index in range(1, len(parts)):
                ancestor = self.entries.get("/".join(parts[:index]))
                if ancestor is not None and ancestor.kind != "directory":
                    fail(f"archive entry {path!r} has a non-directory ancestor")

    def _resolve(self, path: str, trail: tuple[str, ...] = ()) -> ArchiveEntry:
        require_payload_path(path, self.payload_root, "resolved archive path")
        if path in trail or len(trail) >= MAX_LINK_DEPTH:
            fail(f"bottle archive contains a link cycle at {path!r}")
        parts = path.split("/")
        for index in range(1, len(parts) + 1):
            prefix = "/".join(parts[:index])
            entry = self.entries.get(prefix)
            if entry is None:
                continue
            if entry.kind in ("symlink", "hardlink"):
                assert entry.target is not None
                replacement = entry.target
                if index < len(parts):
                    replacement = posixpath.normpath(
                        posixpath.join(replacement, *parts[index:])
                    )
                return self._resolve(replacement, (*trail, path))
            if index < len(parts) and entry.kind != "directory":
                fail(f"resolved archive path {path!r} traverses a non-directory")
        result = self.entries.get(path)
        if result is None:
            fail(f"bottle archive contains a dangling link to {path!r}")
        return result

    def _validate_links(self) -> None:
        for entry in self.entries.values():
            if entry.kind not in ("symlink", "hardlink"):
                continue
            resolved = self._resolve(entry.path)
            if entry.kind == "hardlink" and resolved.kind != "regular":
                fail(f"archive hardlink {entry.path!r} does not resolve to a file")

    def _required_regular(self, relative: str, maximum: int) -> bytes:
        path = f"{self.payload_root}/{relative}"
        entry = self.entries.get(path)
        if entry is None or entry.kind != "regular" or entry.size > maximum:
            fail(f"bottle payload requires bounded regular file {relative!r}")
        assert self.archive is not None
        stream = self.archive.extractfile(entry.member)
        if stream is None:
            fail(f"cannot read bottle payload file {relative!r}")
        with stream:
            payload = stream.read(maximum + 1)
        if len(payload) != entry.size or len(payload) > maximum:
            fail(f"bottle payload file {relative!r} has invalid size")
        return payload

    def _path_executables(self) -> list[str]:
        paths: list[str] = []
        prefix = f"{self.payload_root}/"
        for path in sorted(self.entries):
            if not path.startswith(prefix):
                continue
            relative = path.removeprefix(prefix)
            parts = relative.split("/")
            if len(parts) != 2 or parts[0] not in ("bin", "sbin"):
                continue
            resolved = self._resolve(path)
            if resolved.kind == "regular" and resolved.mode & 0o111:
                paths.append(relative)
        return paths

    def _formula_identity(self, formula_bytes: bytes) -> str:
        script = self.kandelo_root / "scripts/homebrew-formula-source-digest.rb"
        regular_file(script, "Formula source identity tool", MAX_FORMULA_BYTES)
        with tempfile.NamedTemporaryFile() as source:
            source.write(formula_bytes)
            source.flush()
            result = subprocess.run(
                ["ruby", str(script), "--identity-excluding-bottle", source.name],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=120,
            )
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace")[:4096]
            fail(f"cannot compute Formula source identity: {detail}")
        identity = result.stdout.decode("ascii", errors="strict").strip()
        require_string(identity, "Formula source identity", SHA256)
        return identity

    def _tab(self, receipt_bytes: bytes) -> dict[str, Any]:
        try:
            receipt = json.loads(receipt_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            fail(f"INSTALL_RECEIPT.json is not valid UTF-8 JSON: {error}")
        if not isinstance(receipt, dict):
            fail("INSTALL_RECEIPT.json must be an object")
        homebrew_version = require_string(receipt.get("homebrew_version"), "receipt homebrew_version")
        compiler = receipt.get("compiler", "")
        if compiler is None:
            compiler = ""
        if not isinstance(compiler, str):
            fail("receipt compiler must be a string")
        changed_files = receipt.get("changed_files")
        if changed_files is not None and not isinstance(changed_files, list):
            fail("receipt changed_files must be null or an array")
        source_modified_time = receipt.get("source_modified_time", 0)
        require_int(source_modified_time, "receipt source_modified_time")
        runtime_dependencies = receipt.get("runtime_dependencies")
        if not isinstance(runtime_dependencies, list) or len(runtime_dependencies) > 512:
            fail("receipt runtime_dependencies must be a bounded array")
        for index, dependency in enumerate(runtime_dependencies):
            if not isinstance(dependency, dict):
                fail(f"receipt runtime_dependencies[{index}] must be an object")
        arch = require_string(receipt.get("arch"), "receipt arch")
        built_on = receipt.get("built_on")
        if not isinstance(built_on, dict):
            fail("receipt built_on must be an object")
        tab: dict[str, Any] = {
            "homebrew_version": homebrew_version,
            "changed_files": changed_files,
            "source_modified_time": source_modified_time,
            "compiler": compiler,
            "runtime_dependencies": runtime_dependencies,
            "arch": arch,
            "built_on": built_on,
        }
        stdlib = receipt.get("stdlib")
        if stdlib not in (None, ""):
            tab["stdlib"] = require_string(stdlib, "receipt stdlib")
        source = receipt.get("source")
        if isinstance(source, dict) and source.get("scm_revision") not in (None, ""):
            tab["source"] = {
                "scm_revision": require_string(
                    source["scm_revision"], "receipt source.scm_revision"
                )
            }
        payload = canonical_json(tab)
        if len(payload) > MAX_TAB_BYTES:
            fail(f"Homebrew tab exceeds {MAX_TAB_BYTES} bytes")
        return validate_tab(tab)


def semantic_annotations(args: argparse.Namespace, bottle: dict[str, Any], metadata: dict[str, Any]) -> dict[str, str]:
    return {
        "dev.kandelo.homebrew.abi": str(args.abi),
        "dev.kandelo.homebrew.bottle_rebuild": str(bottle["rebuild"]),
        "dev.kandelo.homebrew.formula": args.formula,
        "dev.kandelo.homebrew.formula_revision": str(formula_revision(bottle["pkg_version"])),
        "dev.kandelo.homebrew.formula_source_identity_sha256": metadata[
            "formula_source_identity_sha256"
        ],
        "dev.kandelo.homebrew.source_closure_sha256": metadata["source_closure_sha256"],
        "dev.kandelo.homebrew.pkg_version": bottle["pkg_version"],
        "dev.kandelo.homebrew.tap_repository": normalized_identity(args.tap_repository),
    }


def descriptor_annotations(
    args: argparse.Namespace, bottle: dict[str, Any], metadata: dict[str, Any]
) -> dict[str, str]:
    annotations = semantic_annotations(args, bottle, metadata)
    annotations.update(
        {
            "org.opencontainers.image.ref.name": child_reference(
                bottle["pkg_version"], bottle["tag"], bottle["rebuild"]
            ),
            "sh.brew.bottle.digest": bottle["digest"],
            "sh.brew.bottle.installed_size": str(metadata["installed_size"]),
            "sh.brew.bottle.size": str(bottle["bytes"]),
            "sh.brew.path_exec_files": ",".join(metadata["path_exec_files"]),
            "sh.brew.tab": canonical_json(metadata["tab"]).decode("utf-8"),
        }
    )
    if sum(len(key.encode()) + len(value.encode()) for key, value in annotations.items()) > MAX_ANNOTATION_BYTES:
        fail("Homebrew descriptor annotations exceed their byte limit")
    return dict(sorted(annotations.items()))


def formula_annotations(
    args: argparse.Namespace, bottle: dict[str, Any], metadata: dict[str, Any]
) -> dict[str, str]:
    annotations = semantic_annotations(args, bottle, metadata)
    annotations.update(
        {
            "com.github.package.type": "homebrew_bottle",
            "org.opencontainers.image.ref.name": top_reference(
                bottle["pkg_version"], bottle["rebuild"]
            ),
            "org.opencontainers.image.source": (
                f"https://github.com/{normalized_identity(args.tap_repository)}"
            ),
            "org.opencontainers.image.title": f"{selected_tap_name(args)}/{args.formula}",
            "org.opencontainers.image.version": bottle["pkg_version"],
        }
    )
    return dict(sorted(annotations.items()))


def write_blob(layout: pathlib.Path, payload: bytes) -> dict[str, Any]:
    digest = sha256_bytes(payload)
    destination = layout / "blobs/sha256" / digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        regular_file(destination, "OCI blob")
        if destination.read_bytes() != payload:
            fail(f"OCI blob collision at sha256:{digest}")
    else:
        destination.write_bytes(payload)
    return {"digest": f"sha256:{digest}", "size": len(payload)}


def copy_blob(layout: pathlib.Path, source: pathlib.Path, digest: str) -> None:
    require_string(digest, "OCI blob digest", SHA256)
    source_path = regular_file(
        source / "blobs/sha256" / digest, "source OCI blob", MAX_BOTTLE_BYTES
    )
    if sha256_file(source_path) != digest:
        fail(f"source OCI blob sha256:{digest} has invalid bytes")
    destination = layout / "blobs/sha256" / digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if sha256_file(
            regular_file(destination, "destination OCI blob", MAX_BOTTLE_BYTES)
        ) != digest:
            fail(f"destination OCI blob sha256:{digest} conflicts")
    else:
        shutil.copyfile(source_path, destination)


def initialize_layout(path: pathlib.Path) -> pathlib.Path:
    layout = prepare_output_directory(path)
    write_json(layout / "oci-layout", {"imageLayoutVersion": "1.0.0"}, canonical=True)
    (layout / "blobs/sha256").mkdir(parents=True, exist_ok=True)
    return layout


def build_child(args: argparse.Namespace) -> None:
    validate_arguments(args)
    bottle = canonical_bottle(args)
    metadata = BottleMetadata(
        bottle["archive"], args.formula, bottle["pkg_version"], pathlib.Path(args.kandelo_root)
    ).inspect()
    closure = source_closure(
        tap_root=pathlib.Path(args.tap_root),
        kandelo_root=pathlib.Path(args.kandelo_root),
        tap_name=selected_tap_name(args),
        formula=args.formula,
        expected_formula_identity=metadata["formula_source_identity_sha256"],
        expected_formula_mode=metadata["formula_source_mode"],
    )
    metadata["source_closure_sha256"] = closure["source_closure_sha256"]
    layout = initialize_layout(pathlib.Path(args.out_layout))
    layer_path = layout / "blobs/sha256" / bottle["digest"]
    shutil.copyfile(bottle["archive"], layer_path)
    platform = {"architecture": "wasm", "os": "kandelo", "variant": args.arch}
    config = {
        **platform,
        "rootfs": {"diff_ids": [f"sha256:{metadata['diff_id']}"], "type": "layers"},
    }
    config_descriptor = write_blob(layout, canonical_json(config))
    config_descriptor["mediaType"] = OCI_CONFIG
    child_annotations = descriptor_annotations(args, bottle, metadata)
    manifest_annotations = formula_annotations(args, bottle, metadata) | child_annotations
    manifest = {
        "config": config_descriptor,
        "layers": [
            {
                "annotations": {
                    "org.opencontainers.image.title": bottle["archive"].name,
                },
                "digest": f"sha256:{bottle['digest']}",
                "mediaType": OCI_LAYER,
                "size": bottle["bytes"],
            }
        ],
        "mediaType": OCI_MANIFEST,
        "schemaVersion": 2,
        "annotations": dict(sorted(manifest_annotations.items())),
    }
    manifest_descriptor = write_blob(layout, canonical_json(manifest))
    manifest_descriptor.update(
        {
            "annotations": child_annotations,
            "mediaType": OCI_MANIFEST,
            "platform": platform,
        }
    )
    manifest_digest = manifest_descriptor["digest"].removeprefix("sha256:")
    transport_tag = f"sha256-{manifest_digest}"
    root_descriptor = {
        **manifest_descriptor,
        "annotations": {
            "dev.kandelo.homebrew.child_ref": child_annotations[
                "org.opencontainers.image.ref.name"
            ],
            "org.opencontainers.image.ref.name": transport_tag,
        },
    }
    write_json(
        layout / "index.json",
        {"manifests": [root_descriptor], "mediaType": OCI_INDEX, "schemaVersion": 2},
        canonical=True,
    )
    receipt = {
        "abi": args.abi,
        "arch": args.arch,
        "bottle": {
            "bytes": bottle["bytes"],
            "sha256": bottle["digest"],
            "url": f"{args.bottle_root_url}/{args.formula}/blobs/sha256:{bottle['digest']}",
        },
        "bottle_rebuild": bottle["rebuild"],
        "formula": args.formula,
        "formula_revision": formula_revision(bottle["pkg_version"]),
        "formula_source_identity_sha256": metadata["formula_source_identity_sha256"],
        "formula_source_sha256": metadata["formula_source_sha256"],
        "source_closure_sha256": metadata["source_closure_sha256"],
        "kandelo_commit": args.kandelo_commit,
        "kind": "child",
        "oci": {
            "config": config_descriptor,
            "diff_id": f"sha256:{metadata['diff_id']}",
            "homebrew_ref": child_annotations["org.opencontainers.image.ref.name"],
            "manifest": {
                "digest": manifest_descriptor["digest"],
                "size": manifest_descriptor["size"],
            },
            "platform": platform,
            "transport_tag": transport_tag,
        },
        "pkg_version": bottle["pkg_version"],
        "schema": 2,
        "tap_commit": args.tap_commit,
        "tap_name": selected_tap_name(args),
        "tap_repository": args.tap_repository,
        "top_ref": top_reference(bottle["pkg_version"], bottle["rebuild"]),
    }
    write_json(pathlib.Path(args.out_receipt), receipt)
    validate_child_layout(layout, receipt)


def digest_value(value: Any, label: str) -> str:
    value = require_string(value, label)
    if not value.startswith("sha256:") or SHA256.fullmatch(value[7:]) is None:
        fail(f"{label} must be a sha256 digest")
    return value[7:]


def read_blob(layout: pathlib.Path, descriptor: dict[str, Any], label: str) -> bytes:
    digest = digest_value(descriptor.get("digest"), f"{label} digest")
    size = require_int(descriptor.get("size"), f"{label} size", 1)
    path = regular_file(layout / "blobs/sha256" / digest, f"{label} blob", MAX_JSON)
    if path.stat().st_size != size or sha256_file(path) != digest:
        fail(f"{label} descriptor does not match its blob")
    return path.read_bytes()


def read_json_blob(layout: pathlib.Path, descriptor: dict[str, Any], label: str) -> Any:
    payload = read_blob(layout, descriptor, label)
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not valid UTF-8 JSON: {error}")
    if payload != canonical_json(document):
        fail(f"{label} is not canonical JSON")
    return document


def validate_tab(tab: Any) -> dict[str, Any]:
    if not isinstance(tab, dict):
        fail("Homebrew tab annotation must be an object")
    required = {
        "arch", "built_on", "changed_files", "compiler", "homebrew_version",
        "runtime_dependencies", "source_modified_time",
    }
    optional = {"source", "stdlib"}
    if not required <= set(tab) or not set(tab) <= required | optional:
        fail("Homebrew tab annotation has an unexpected schema")
    require_string(tab["homebrew_version"], "Homebrew tab homebrew_version")
    if not isinstance(tab["compiler"], str) or "\0" in tab["compiler"]:
        fail("Homebrew tab compiler must be a string")
    require_string(tab["arch"], "Homebrew tab arch")
    require_int(tab["source_modified_time"], "Homebrew tab source_modified_time")
    changed = tab["changed_files"]
    if changed is not None:
        if not isinstance(changed, list) or len(changed) > 4096:
            fail("Homebrew tab changed_files must be null or a bounded string array")
        for index, path in enumerate(changed):
            require_string(path, f"Homebrew tab changed_files[{index}]")
    dependencies = tab["runtime_dependencies"]
    if not isinstance(dependencies, list) or len(dependencies) > 512:
        fail("Homebrew tab runtime_dependencies must be a bounded array")
    dependency_keys = {
        "bottle_rebuild", "compatibility_version", "declared_directly", "full_name",
        "pkg_version", "revision", "version",
    }
    for index, dependency in enumerate(dependencies):
        if not isinstance(dependency, dict) or not {"full_name", "version"} <= set(dependency):
            fail(f"Homebrew tab runtime_dependencies[{index}] has an invalid schema")
        if not set(dependency) <= dependency_keys:
            fail(f"Homebrew tab runtime_dependencies[{index}] has unexpected fields")
        require_string(dependency["full_name"], f"Homebrew tab dependency {index} full_name")
        require_string(dependency["version"], f"Homebrew tab dependency {index} version")
        for key in ("pkg_version", "compatibility_version"):
            if key in dependency:
                require_string(dependency[key], f"Homebrew tab dependency {index} {key}")
        for key in ("revision", "bottle_rebuild"):
            if key in dependency:
                require_int(dependency[key], f"Homebrew tab dependency {index} {key}")
        if "declared_directly" in dependency and not isinstance(dependency["declared_directly"], bool):
            fail(f"Homebrew tab dependency {index} declared_directly must be boolean")
    built_on = tab["built_on"]
    built_on_keys = {
        "clt", "cpu_family", "glibc_version", "oldest_cpu_family", "os", "os_version",
        "preferred_perl", "xcode",
    }
    if not isinstance(built_on, dict) or not {"os", "os_version"} <= set(built_on):
        fail("Homebrew tab built_on has an invalid schema")
    if not set(built_on) <= built_on_keys:
        fail("Homebrew tab built_on has unexpected fields")
    for key, value in built_on.items():
        if value is not None:
            require_string(value, f"Homebrew tab built_on.{key}")
    if "stdlib" in tab:
        require_string(tab["stdlib"], "Homebrew tab stdlib")
    if "source" in tab:
        source = exact_keys(tab["source"], {"scm_revision"}, "Homebrew tab source")
        require_string(source["scm_revision"], "Homebrew tab source.scm_revision")
    require_bounded_json(tab, "Homebrew tab")
    if len(canonical_json(tab)) > MAX_TAB_BYTES:
        fail(f"Homebrew tab exceeds {MAX_TAB_BYTES} bytes")
    return tab


def load_receipt(path: pathlib.Path) -> dict[str, Any]:
    receipt = load_json(path, "OCI child receipt")
    root = exact_keys(
        receipt,
        {
            "abi", "arch", "bottle", "bottle_rebuild", "formula", "formula_revision",
            "formula_source_identity_sha256", "formula_source_sha256", "kandelo_commit",
            "kind", "oci", "pkg_version", "schema", "source_closure_sha256", "tap_commit",
            "tap_name", "tap_repository", "top_ref",
        },
        "OCI child receipt",
    )
    if root["schema"] != 2 or root["kind"] != "child":
        fail("OCI child receipt has an invalid schema")
    require_string(root["formula"], "receipt formula", FORMULA_NAME)
    if root["arch"] not in ("wasm32", "wasm64"):
        fail("OCI child receipt has an invalid architecture")
    require_int(root["abi"], "receipt ABI", 1)
    require_int(root["formula_revision"], "receipt Formula revision")
    require_int(root["bottle_rebuild"], "receipt bottle rebuild")
    require_string(root["pkg_version"], "receipt pkg_version", PKG_VERSION)
    if root["formula_revision"] != formula_revision(root["pkg_version"]):
        fail("receipt Formula revision does not match pkg_version")
    require_string(root["formula_source_sha256"], "receipt Formula sha256", SHA256)
    require_string(
        root["formula_source_identity_sha256"], "receipt Formula identity sha256", SHA256
    )
    require_string(root["source_closure_sha256"], "receipt source closure sha256", SHA256)
    receipt_repository = require_string(
        root["tap_repository"], "receipt tap repository", TAP_REPOSITORY
    )
    receipt_tap_name = require_string(root["tap_name"], "receipt tap name", TAP_REPOSITORY)
    if normalized_identity(receipt_tap_name) != tap_name_for_repository(receipt_repository):
        fail("OCI child receipt tap name does not match its repository")
    require_string(root["tap_commit"], "receipt tap commit", COMMIT)
    require_string(root["kandelo_commit"], "receipt Kandelo commit", COMMIT)
    bottle = exact_keys(root["bottle"], {"bytes", "sha256", "url"}, "receipt bottle")
    require_int(bottle["bytes"], "receipt bottle bytes", 1)
    require_string(bottle["sha256"], "receipt bottle sha256", SHA256)
    expected_url = (
        f"https://ghcr.io/v2/{root['tap_repository'].lower()}/"
        f"{root['formula']}/blobs/sha256:{bottle['sha256']}"
    )
    if bottle["url"] != expected_url:
        fail("receipt bottle URL does not match its repository and digest")
    oci = exact_keys(
        root["oci"],
        {"config", "diff_id", "homebrew_ref", "manifest", "platform", "transport_tag"},
        "receipt OCI child",
    )
    config = exact_keys(oci["config"], {"digest", "mediaType", "size"}, "receipt OCI config")
    if config["mediaType"] != OCI_CONFIG:
        fail("receipt OCI config media type is invalid")
    digest_value(config["digest"], "receipt OCI config digest")
    require_int(config["size"], "receipt OCI config size", 1)
    digest_value(oci["diff_id"], "receipt OCI diff_id")
    manifest = exact_keys(oci["manifest"], {"digest", "size"}, "receipt OCI manifest")
    digest_value(manifest["digest"], "receipt OCI manifest digest")
    require_int(manifest["size"], "receipt OCI manifest size", 1)
    platform = {"architecture": "wasm", "os": "kandelo", "variant": root["arch"]}
    if oci["platform"] != platform:
        fail("receipt OCI platform is invalid")
    expected_child = child_reference(
        root["pkg_version"], f"{root['arch']}_kandelo", root["bottle_rebuild"]
    )
    if oci["homebrew_ref"] != expected_child:
        fail("receipt Homebrew child ref is invalid")
    manifest_digest = digest_value(manifest["digest"], "receipt OCI manifest digest")
    if oci["transport_tag"] != f"sha256-{manifest_digest}":
        fail("receipt child transport tag is not content-derived")
    expected_top = top_reference(root["pkg_version"], root["bottle_rebuild"])
    if root["top_ref"] != expected_top:
        fail("receipt Homebrew top ref is invalid")
    return root


def load_layout_root(layout: pathlib.Path) -> dict[str, Any]:
    real_directory(layout, "OCI layout")
    if load_json(layout / "oci-layout", "OCI layout marker") != {"imageLayoutVersion": "1.0.0"}:
        fail("OCI layout marker is invalid")
    root = exact_keys(
        load_json(layout / "index.json", "OCI layout index"),
        {"manifests", "mediaType", "schemaVersion"},
        "OCI layout index",
    )
    if root["schemaVersion"] != 2 or root["mediaType"] != OCI_INDEX:
        fail("OCI layout index has invalid media type or schema")
    if not isinstance(root["manifests"], list) or len(root["manifests"]) != 1:
        fail("OCI layout index must contain exactly one root descriptor")
    return root["manifests"][0]


def expected_semantics(receipt: dict[str, Any]) -> dict[str, str]:
    return {
        "dev.kandelo.homebrew.abi": str(receipt["abi"]),
        "dev.kandelo.homebrew.bottle_rebuild": str(receipt["bottle_rebuild"]),
        "dev.kandelo.homebrew.formula": receipt["formula"],
        "dev.kandelo.homebrew.formula_revision": str(receipt["formula_revision"]),
        "dev.kandelo.homebrew.formula_source_identity_sha256": receipt[
            "formula_source_identity_sha256"
        ],
        "dev.kandelo.homebrew.source_closure_sha256": receipt["source_closure_sha256"],
        "dev.kandelo.homebrew.pkg_version": receipt["pkg_version"],
        "dev.kandelo.homebrew.tap_repository": normalized_identity(receipt["tap_repository"]),
    }


def expected_top_annotations(semantics: dict[str, str], top_ref: str) -> dict[str, str]:
    return dict(sorted({
        **semantics,
        "com.github.package.type": "homebrew_bottle",
        "org.opencontainers.image.ref.name": top_ref,
        "org.opencontainers.image.source": (
            f"https://github.com/{semantics['dev.kandelo.homebrew.tap_repository']}"
        ),
        "org.opencontainers.image.title": (
            f"{tap_name_for_repository(semantics['dev.kandelo.homebrew.tap_repository'])}/"
            f"{semantics['dev.kandelo.homebrew.formula']}"
        ),
        "org.opencontainers.image.version": semantics["dev.kandelo.homebrew.pkg_version"],
    }.items()))


def validate_manifest_descriptor(
    layout: pathlib.Path,
    descriptor: dict[str, Any],
    semantics: dict[str, str],
    *,
    expected_receipt: dict[str, Any] | None = None,
) -> dict[str, Any]:
    descriptor = exact_keys(
        descriptor,
        {"annotations", "digest", "mediaType", "platform", "size"},
        "Homebrew child descriptor",
    )
    if descriptor["mediaType"] != OCI_MANIFEST:
        fail("Homebrew child descriptor has the wrong media type")
    platform = descriptor["platform"]
    if platform not in (
        {"architecture": "wasm", "os": "kandelo", "variant": "wasm32"},
        {"architecture": "wasm", "os": "kandelo", "variant": "wasm64"},
    ):
        fail("Homebrew child descriptor has untruthful platform metadata")
    descriptor_annotation_keys = {
        *semantics.keys(),
        "org.opencontainers.image.ref.name",
        "sh.brew.bottle.digest",
        "sh.brew.bottle.installed_size",
        "sh.brew.bottle.size",
        "sh.brew.path_exec_files",
        "sh.brew.tab",
    }
    annotations = exact_keys(
        descriptor["annotations"], descriptor_annotation_keys,
        "Homebrew child descriptor annotations",
    )
    annotation_bytes = 0
    for key, value in annotations.items():
        if not isinstance(value, str) or "\0" in value:
            fail(f"Homebrew child descriptor annotation {key} must be a string")
        annotation_bytes += len(key.encode("utf-8")) + len(value.encode("utf-8"))
    if annotation_bytes > MAX_ANNOTATION_BYTES:
        fail("Homebrew child descriptor annotations exceed their byte limit")
    for key, value in semantics.items():
        if annotations.get(key) != value:
            fail(f"Homebrew child descriptor semantic annotation {key} does not match")
    ref = require_string(annotations.get("org.opencontainers.image.ref.name"), "child ref", OCI_TAG)
    expected_ref = child_reference(
        semantics["dev.kandelo.homebrew.pkg_version"],
        f"{platform['variant']}_kandelo",
        int(semantics["dev.kandelo.homebrew.bottle_rebuild"], 10),
    )
    if ref != expected_ref:
        fail("Homebrew child descriptor ref does not match its platform")
    bottle_sha = require_string(
        annotations.get("sh.brew.bottle.digest"), "Homebrew bottle digest", SHA256
    )
    bottle_size = require_decimal_string(
        annotations.get("sh.brew.bottle.size"), "bottle size", 1
    )
    if bottle_size > MAX_BOTTLE_BYTES:
        fail(f"bottle size exceeds {MAX_BOTTLE_BYTES} bytes")
    require_decimal_string(
        annotations.get("sh.brew.bottle.installed_size"), "installed size"
    )
    executable_text = annotations["sh.brew.path_exec_files"]
    if executable_text:
        executable_paths = executable_text.split(",")
        if len(executable_paths) > 4096 or len(set(executable_paths)) != len(executable_paths):
            fail("Homebrew path executable annotation is not a bounded unique list")
        if executable_paths != sorted(executable_paths):
            fail("Homebrew path executable annotation is not deterministically ordered")
        for path in executable_paths:
            normalized = normalize_archive_path(path, "Homebrew path executable")
            parts = normalized.split("/")
            if normalized != path or len(parts) != 2 or parts[0] not in ("bin", "sbin"):
                fail("Homebrew path executable annotation contains an invalid path")
    tab_text = require_string(annotations.get("sh.brew.tab"), "Homebrew tab")
    try:
        tab = json.loads(tab_text)
    except json.JSONDecodeError as error:
        fail(f"Homebrew tab annotation is invalid: {error}")
    if tab_text.encode("utf-8") != canonical_json(tab):
        fail("Homebrew tab annotation is not canonical JSON")
    validate_tab(tab)
    manifest = exact_keys(
        read_json_blob(layout, descriptor, "child manifest"),
        {"annotations", "config", "layers", "mediaType", "schemaVersion"},
        "OCI child manifest",
    )
    if manifest["schemaVersion"] != 2 or manifest["mediaType"] != OCI_MANIFEST:
        fail("OCI child manifest media type or schema is invalid")
    expected_manifest_annotations = {
        **annotations,
        "com.github.package.type": "homebrew_bottle",
        "org.opencontainers.image.source": (
            "https://github.com/"
            f"{semantics['dev.kandelo.homebrew.tap_repository']}"
        ),
        "org.opencontainers.image.title": (
            f"{tap_name_for_repository(semantics['dev.kandelo.homebrew.tap_repository'])}/"
            f"{semantics['dev.kandelo.homebrew.formula']}"
        ),
        "org.opencontainers.image.version": semantics["dev.kandelo.homebrew.pkg_version"],
    }
    if manifest["annotations"] != dict(sorted(expected_manifest_annotations.items())):
        fail("OCI child manifest annotations do not match the exact Formula schema")
    config_descriptor = exact_keys(
        manifest["config"], {"digest", "mediaType", "size"}, "OCI child config descriptor"
    )
    if config_descriptor["mediaType"] != OCI_CONFIG:
        fail("OCI child config has the wrong media type")
    config = exact_keys(
        read_json_blob(layout, config_descriptor, "child config"),
        {"architecture", "os", "rootfs", "variant"},
        "OCI child config",
    )
    if {key: config[key] for key in ("architecture", "os", "variant")} != platform:
        fail("OCI child config platform differs from its descriptor")
    rootfs = exact_keys(config["rootfs"], {"diff_ids", "type"}, "OCI child rootfs")
    if rootfs["type"] != "layers" or not isinstance(rootfs["diff_ids"], list) or len(rootfs["diff_ids"]) != 1:
        fail("OCI child config rootfs is invalid")
    diff_id = digest_value(rootfs["diff_ids"][0], "OCI child diff_id")
    layers = manifest["layers"]
    if not isinstance(layers, list) or len(layers) != 1:
        fail("OCI child manifest must contain exactly one layer")
    layer = exact_keys(
        layers[0], {"annotations", "digest", "mediaType", "size"}, "OCI bottle layer"
    )
    layer_annotations = exact_keys(
        layer["annotations"], {"org.opencontainers.image.title"},
        "OCI bottle layer annotations",
    )
    layer_title = require_string(
        layer_annotations["org.opencontainers.image.title"], "OCI bottle layer title"
    )
    if pathlib.PurePosixPath(layer_title).name != layer_title or len(layer_title.encode()) > 255:
        fail("OCI bottle layer title must be a bounded file name")
    if layer["mediaType"] != OCI_LAYER or digest_value(layer["digest"], "layer digest") != bottle_sha:
        fail("OCI bottle layer media type or digest is invalid")
    if layer["size"] != bottle_size:
        fail("OCI bottle layer size does not match Homebrew metadata")
    layer_path = regular_file(
        layout / "blobs/sha256" / bottle_sha, "OCI bottle layer", MAX_BOTTLE_BYTES
    )
    if layer_path.stat().st_size != bottle_size or sha256_file(layer_path) != bottle_sha:
        fail("OCI bottle layer bytes do not match the Formula digest")
    decompressed = hashlib.sha256()
    decompressed_bytes = 0
    try:
        with gzip.open(layer_path, "rb") as stream:
            while chunk := stream.read(1024 * 1024):
                decompressed_bytes += len(chunk)
                if decompressed_bytes > MAX_EXPANDED_BOTTLE_BYTES:
                    fail(
                        "decompressed OCI bottle exceeds "
                        f"{MAX_EXPANDED_BOTTLE_BYTES} bytes"
                    )
                decompressed.update(chunk)
    except (OSError, EOFError) as error:
        fail(f"cannot hash decompressed OCI bottle tar: {error}")
    if decompressed.hexdigest() != diff_id:
        fail("OCI child config diff_id does not match the decompressed bottle tar")
    if expected_receipt is not None:
        if platform["variant"] != expected_receipt["arch"]:
            fail("OCI child platform does not match receipt architecture")
        if bottle_sha != expected_receipt["bottle"]["sha256"] or bottle_size != expected_receipt["bottle"]["bytes"]:
            fail("OCI child bottle does not match receipt")
        if descriptor["digest"] != expected_receipt["oci"]["manifest"]["digest"]:
            fail("OCI child manifest does not match receipt")
    return {
        "arch": platform["variant"],
        "bottle_sha256": bottle_sha,
        "descriptor": descriptor,
        "homebrew_ref": ref,
        "manifest_digest": descriptor["digest"],
    }


def validate_child_layout(layout: pathlib.Path, receipt: dict[str, Any]) -> dict[str, Any]:
    receipt = load_receipt(pathlib.Path(receipt)) if isinstance(receipt, (str, pathlib.Path)) else receipt
    root = load_layout_root(layout)
    root = exact_keys(
        root, {"annotations", "digest", "mediaType", "platform", "size"}, "child layout root"
    )
    transport = receipt["oci"]["transport_tag"]
    if root["annotations"] != {
        "dev.kandelo.homebrew.child_ref": receipt["oci"]["homebrew_ref"],
        "org.opencontainers.image.ref.name": transport,
    }:
        fail("child layout root annotations do not match its transport receipt")
    expected_transport = f"sha256-{digest_value(root['digest'], 'child root digest')}"
    if transport != expected_transport:
        fail("child transport tag is not content-derived from the manifest digest")
    manifest = read_json_blob(layout, root, "child transport manifest")
    manifest_annotations = manifest.get("annotations") if isinstance(manifest, dict) else None
    if not isinstance(manifest_annotations, dict):
        fail("child transport manifest lacks Homebrew annotations")
    annotation_keys = {
        *expected_semantics(receipt).keys(),
        "org.opencontainers.image.ref.name",
        "sh.brew.bottle.digest",
        "sh.brew.bottle.installed_size",
        "sh.brew.bottle.size",
        "sh.brew.path_exec_files",
        "sh.brew.tab",
    }
    annotations = {
        key: manifest_annotations[key]
        for key in sorted(annotation_keys)
        if key in manifest_annotations
    }
    descriptor = {
        "annotations": annotations,
        "digest": root["digest"],
        "mediaType": root["mediaType"],
        "platform": root["platform"],
        "size": root["size"],
    }
    return validate_manifest_descriptor(
        layout, descriptor, expected_semantics(receipt), expected_receipt=receipt
    )


def merge_index(args: argparse.Namespace) -> None:
    if not args.child_layout or len(args.child_layout) != len(args.child_receipt):
        fail("merge-index requires matching --child-layout and --child-receipt arguments")
    selected: list[tuple[pathlib.Path, dict[str, Any], dict[str, Any]]] = []
    for layout_name, receipt_name in zip(args.child_layout, args.child_receipt, strict=True):
        layout = pathlib.Path(layout_name)
        receipt = load_receipt(pathlib.Path(receipt_name))
        selected.append((layout, receipt, validate_child_layout(layout, receipt)))
    first = selected[0][1]
    semantics = expected_semantics(first)
    for _layout, receipt, _child in selected[1:]:
        if expected_semantics(receipt) != semantics:
            fail("selected OCI children do not belong to one Formula publication identity")
        if receipt["top_ref"] != first["top_ref"]:
            fail("selected OCI children disagree on the Homebrew top reference")
    selected_refs = [child["homebrew_ref"] for _layout, _receipt, child in selected]
    if len(set(selected_refs)) != len(selected_refs):
        fail("selected OCI children contain duplicate Homebrew refs")
    output = initialize_layout(pathlib.Path(args.out_layout))
    children: dict[str, tuple[pathlib.Path, dict[str, Any]]] = {}
    previous_top_digest: str | None = None
    if args.existing_layout:
        existing_layout = pathlib.Path(args.existing_layout)
        root = load_layout_root(existing_layout)
        root = exact_keys(
            root, {"annotations", "digest", "mediaType", "size"}, "existing top root"
        )
        if root["mediaType"] != OCI_INDEX:
            fail("existing Homebrew top reference is not an OCI image index")
        previous_top_digest = root["digest"]
        if root["annotations"] != {"org.opencontainers.image.ref.name": first["top_ref"]}:
            fail("existing Homebrew top root ref does not match")
        top = exact_keys(
            read_json_blob(existing_layout, root, "existing top index"),
            {"annotations", "manifests", "mediaType", "schemaVersion"},
            "existing Homebrew top index",
        )
        if top["mediaType"] != OCI_INDEX or top["schemaVersion"] != 2:
            fail("existing Homebrew top index media type or schema is invalid")
        if top["annotations"] != expected_top_annotations(semantics, first["top_ref"]):
            fail("existing Homebrew top index belongs to a stale Formula identity")
        if not isinstance(top["manifests"], list):
            fail("existing Homebrew top index lacks child manifests")
        for descriptor in top["manifests"]:
            validated = validate_manifest_descriptor(existing_layout, descriptor, semantics)
            ref = validated["homebrew_ref"]
            if ref in children:
                fail(f"existing Homebrew top index repeats child ref {ref}")
            children[ref] = (existing_layout, descriptor)
    for layout, _receipt, child in selected:
        ref = child["homebrew_ref"]
        existing = children.get(ref)
        if existing is not None and existing[1]["digest"] != child["descriptor"]["digest"]:
            fail(f"Homebrew child ref {ref} already names different bytes; bump bottle rebuild")
        children[ref] = (layout, child["descriptor"])
    variants = [descriptor["platform"]["variant"] for _source, descriptor in children.values()]
    if len(set(variants)) != len(variants) or any(value not in ("wasm32", "wasm64") for value in variants):
        fail("Homebrew top index contains duplicate or unsupported Kandelo variants")
    descriptors: list[dict[str, Any]] = []
    for ref in sorted(children):
        source, descriptor = children[ref]
        manifest_digest = digest_value(descriptor["digest"], "child manifest digest")
        manifest = read_json_blob(source, descriptor, "merged child manifest")
        config = manifest["config"]
        layer = manifest["layers"][0]
        for digest in (
            manifest_digest,
            digest_value(config["digest"], "child config digest"),
            digest_value(layer["digest"], "child layer digest"),
        ):
            copy_blob(output, source, digest)
        descriptors.append(descriptor)
    top_annotations = expected_top_annotations(semantics, first["top_ref"])
    top = {
        "annotations": top_annotations,
        "manifests": descriptors,
        "mediaType": OCI_INDEX,
        "schemaVersion": 2,
    }
    top_descriptor = write_blob(output, canonical_json(top))
    top_descriptor.update(
        {
            "annotations": {"org.opencontainers.image.ref.name": first["top_ref"]},
            "mediaType": OCI_INDEX,
        }
    )
    write_json(
        output / "index.json",
        {"manifests": [top_descriptor], "mediaType": OCI_INDEX, "schemaVersion": 2},
        canonical=True,
    )
    receipt = {
        "abi": first["abi"],
        "children": [
            {
                "arch": descriptor["platform"]["variant"],
                "bottle_sha256": descriptor["annotations"]["sh.brew.bottle.digest"],
                "homebrew_ref": descriptor["annotations"]["org.opencontainers.image.ref.name"],
                "manifest_digest": descriptor["digest"],
            }
            for descriptor in descriptors
        ],
        "formula": first["formula"],
        "formula_revision": first["formula_revision"],
        "formula_source_identity_sha256": first["formula_source_identity_sha256"],
        "source_closure_sha256": first["source_closure_sha256"],
        "kind": "index",
        "pkg_version": first["pkg_version"],
        "bottle_rebuild": first["bottle_rebuild"],
        "schema": 2,
        "tap_name": first["tap_name"],
        "tap_repository": first["tap_repository"],
        "top": {
            "digest": top_descriptor["digest"],
            "previous_digest": previous_top_digest,
            "ref": first["top_ref"],
            "size": top_descriptor["size"],
        },
    }
    write_json(pathlib.Path(args.out_receipt), receipt)
    validate_index_layout(output, receipt)


def validate_index_receipt(receipt: Any) -> dict[str, Any]:
    root = exact_keys(
        receipt,
        {
            "abi", "bottle_rebuild", "children", "formula", "formula_revision",
            "formula_source_identity_sha256", "kind", "pkg_version", "schema",
            "source_closure_sha256", "tap_name", "tap_repository", "top",
        },
        "OCI index receipt",
    )
    if root["schema"] != 2 or root["kind"] != "index":
        fail("OCI index receipt has an invalid schema")
    require_int(root["abi"], "OCI index receipt ABI", 1)
    formula = require_string(root["formula"], "OCI index receipt formula", FORMULA_NAME)
    revision = require_int(root["formula_revision"], "OCI index receipt Formula revision")
    rebuild = require_int(root["bottle_rebuild"], "OCI index receipt bottle rebuild")
    pkg_version = require_string(root["pkg_version"], "OCI index receipt pkg_version", PKG_VERSION)
    if revision != formula_revision(pkg_version):
        fail("OCI index receipt Formula revision does not match pkg_version")
    require_string(
        root["formula_source_identity_sha256"],
        "OCI index receipt Formula identity sha256", SHA256,
    )
    require_string(
        root["source_closure_sha256"], "OCI index receipt source closure sha256", SHA256
    )
    receipt_repository = require_string(
        root["tap_repository"], "OCI index receipt tap repository", TAP_REPOSITORY
    )
    receipt_tap_name = require_string(
        root["tap_name"], "OCI index receipt tap name", TAP_REPOSITORY
    )
    if normalized_identity(receipt_tap_name) != tap_name_for_repository(receipt_repository):
        fail("OCI index receipt tap name does not match its repository")
    children = root["children"]
    if not isinstance(children, list) or not 1 <= len(children) <= 2:
        fail("OCI index receipt must contain one or two children")
    child_refs: list[str] = []
    child_arches: list[str] = []
    for index, child in enumerate(children):
        child = exact_keys(
            child, {"arch", "bottle_sha256", "homebrew_ref", "manifest_digest"},
            f"OCI index receipt child {index}",
        )
        arch = child["arch"]
        if arch not in ("wasm32", "wasm64"):
            fail(f"OCI index receipt child {index} has an invalid architecture")
        require_string(
            child["bottle_sha256"], f"OCI index receipt child {index} bottle sha256", SHA256
        )
        ref = require_string(
            child["homebrew_ref"], f"OCI index receipt child {index} Homebrew ref", OCI_TAG
        )
        expected_ref = child_reference(pkg_version, f"{arch}_kandelo", rebuild)
        if ref != expected_ref:
            fail(f"OCI index receipt child {index} Homebrew ref is invalid")
        digest_value(
            child["manifest_digest"], f"OCI index receipt child {index} manifest digest"
        )
        child_refs.append(ref)
        child_arches.append(arch)
    if child_refs != sorted(child_refs) or len(set(child_refs)) != len(child_refs):
        fail("OCI index receipt children are not uniquely and deterministically ordered")
    if len(set(child_arches)) != len(child_arches):
        fail("OCI index receipt repeats a Kandelo architecture")
    top = exact_keys(root["top"], {"digest", "previous_digest", "ref", "size"}, "OCI top receipt")
    digest_value(top["digest"], "OCI top receipt digest")
    if top["previous_digest"] is not None:
        digest_value(top["previous_digest"], "OCI previous top digest")
    top_ref = require_string(top["ref"], "OCI top receipt ref", OCI_TAG)
    if top_ref != top_reference(pkg_version, rebuild):
        fail("OCI top receipt ref does not match pkg_version and rebuild")
    require_int(top["size"], "OCI top receipt size", 1)
    return root


def validate_index_layout(layout: pathlib.Path, receipt: dict[str, Any]) -> None:
    receipt = validate_index_receipt(receipt)
    root = exact_keys(
        load_layout_root(layout), {"annotations", "digest", "mediaType", "size"}, "top root"
    )
    if root["mediaType"] != OCI_INDEX or root["annotations"] != {
        "org.opencontainers.image.ref.name": receipt["top"]["ref"]
    }:
        fail("OCI top root descriptor is invalid")
    if root["digest"] != receipt["top"]["digest"] or root["size"] != receipt["top"]["size"]:
        fail("OCI top root descriptor does not match its receipt")
    top = exact_keys(
        read_json_blob(layout, root, "top index"),
        {"annotations", "manifests", "mediaType", "schemaVersion"},
        "Homebrew top index",
    )
    if top["mediaType"] != OCI_INDEX or top["schemaVersion"] != 2:
        fail("Homebrew top index media type or schema is invalid")
    semantics = {
        "dev.kandelo.homebrew.abi": str(receipt["abi"]),
        "dev.kandelo.homebrew.bottle_rebuild": str(receipt["bottle_rebuild"]),
        "dev.kandelo.homebrew.formula": receipt["formula"],
        "dev.kandelo.homebrew.formula_revision": str(receipt["formula_revision"]),
        "dev.kandelo.homebrew.formula_source_identity_sha256": receipt[
            "formula_source_identity_sha256"
        ],
        "dev.kandelo.homebrew.source_closure_sha256": receipt["source_closure_sha256"],
        "dev.kandelo.homebrew.pkg_version": receipt["pkg_version"],
        "dev.kandelo.homebrew.tap_repository": normalized_identity(receipt["tap_repository"]),
    }
    if top["annotations"] != expected_top_annotations(semantics, receipt["top"]["ref"]):
        fail("Homebrew top index semantic identity does not match receipt")
    if not isinstance(top["manifests"], list) or not 1 <= len(top["manifests"]) <= 2:
        fail("Homebrew top index must contain one or two child manifests")
    validated = [validate_manifest_descriptor(layout, descriptor, semantics) for descriptor in top["manifests"]]
    summary = [
        {
            "arch": item["arch"],
            "bottle_sha256": item["bottle_sha256"],
            "homebrew_ref": item["homebrew_ref"],
            "manifest_digest": item["manifest_digest"],
        }
        for item in validated
    ]
    if summary != receipt["children"]:
        fail("Homebrew top index child set does not match receipt")


def validate_child_command(args: argparse.Namespace) -> None:
    validate_child_layout(pathlib.Path(args.layout), load_receipt(pathlib.Path(args.receipt)))


def validate_child_receipt_command(args: argparse.Namespace) -> None:
    load_receipt(pathlib.Path(args.receipt))


def source_closure_command(args: argparse.Namespace) -> None:
    closure = source_closure(
        tap_root=pathlib.Path(args.tap_root),
        kandelo_root=pathlib.Path(args.kandelo_root),
        tap_name=selected_tap_name(args),
        formula=args.formula,
    )
    write_json(
        pathlib.Path(args.out),
        {
            "formula": args.formula,
            **closure,
            "schema": 2,
            "tap_name": selected_tap_name(args),
            "tap_repository": normalized_identity(args.tap_repository),
        },
    )


def validate_index_command(args: argparse.Namespace) -> None:
    receipt = validate_index_receipt(load_json(pathlib.Path(args.receipt), "OCI index receipt"))
    validate_index_layout(pathlib.Path(args.layout), receipt)


def validate_index_receipt_command(args: argparse.Namespace) -> None:
    validate_index_receipt(load_json(pathlib.Path(args.receipt), "OCI index receipt"))


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def run_bounded_command(
    *,
    command: list[str],
    output: pathlib.Path,
    maximum_stdout: int,
    maximum_stderr: int,
    timeout: int,
    label: str = "anonymous registry",
) -> tuple[int, str]:
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    assert process.stdout is not None and process.stderr is not None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    stdout_bytes = 0
    stderr = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with output.open("wb") as stdout:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    fail(f"bounded command timed out after {timeout} seconds")
                for key, _events in selector.select(min(remaining, 1.0)):
                    chunk = os.read(key.fd, 64 * 1024)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == "stdout":
                        stdout_bytes += len(chunk)
                        if stdout_bytes > maximum_stdout:
                            fail(f"{label} response exceeds {maximum_stdout} bytes")
                        stdout.write(chunk)
                    else:
                        if len(stderr) + len(chunk) > maximum_stderr:
                            fail(f"{label} error response exceeds {maximum_stderr} bytes")
                        stderr.extend(chunk)
        return_code = process.wait(timeout=max(1, int(deadline - time.monotonic()) + 1))
    except BaseException:
        terminate_process_group(process)
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
    return return_code, stderr.decode("utf-8", errors="replace")


def command_error_detail(error: str) -> str:
    return error[:4096]


def run_oras_fetch(
    *,
    registry_config: pathlib.Path,
    target: str,
    output: pathlib.Path,
    maximum: int,
    descriptor: bool = False,
) -> tuple[int, str]:
    command = ["oras", "manifest", "fetch"]
    if descriptor:
        command.append("--descriptor")
    command.extend(["--registry-config", str(registry_config), target])
    return run_bounded_command(
        command=command,
        output=output,
        maximum_stdout=maximum,
        maximum_stderr=MAX_MANIFEST_BYTES,
        timeout=180,
    )


def run_oras_blob_descriptor_fetch(
    *, registry_config: pathlib.Path, target: str, output: pathlib.Path
) -> tuple[int, str]:
    return run_bounded_command(
        command=[
            "oras", "blob", "fetch", "--descriptor", "--registry-config",
            str(registry_config), target,
        ],
        output=output,
        maximum_stdout=MAX_MANIFEST_BYTES,
        maximum_stderr=MAX_MANIFEST_BYTES,
        timeout=180,
    )


def classify_registry_error(error: str, *, target: str, kind: str) -> str | None:
    message = error.strip()
    authentication_errors = {
        "Error response from registry: authentication required",
        "Error response from registry: denied: requested access to the resource is denied",
        "Error response from registry: unauthorized: authentication required",
    }
    if message in authentication_errors:
        return "auth-required"
    if kind == "manifest" and message in {
        f'Error response from registry: failed to find "{target}": {target}: not found',
        "Error response from registry: manifest unknown",
        "Error response from registry: manifest unknown: manifest unknown",
        "Error response from registry: name unknown: repository name not known to registry",
    }:
        return "missing"
    if kind == "repository" and message == (
        "Error response from registry: name unknown: repository name not known to registry"
    ):
        return "missing"
    return None


def run_oras_repository_probe(
    *, registry_config: pathlib.Path, remote: str, output: pathlib.Path
) -> tuple[int, str]:
    return run_bounded_command(
        command=[
            "oras", "repo", "tags", "--last", MAXIMUM_OCI_TAG, "--format", "json",
            "--registry-config", str(registry_config), remote,
        ],
        output=output,
        maximum_stdout=MAX_MANIFEST_BYTES,
        maximum_stderr=MAX_MANIFEST_BYTES,
        timeout=180,
        label="registry repository probe",
    )


def registry_probe(args: argparse.Namespace) -> None:
    remote = require_string(args.remote, "registry probe remote", OCI_REMOTE)
    reference = require_string(args.reference, "registry probe reference", OCI_TAG)
    registry_config = regular_file(
        pathlib.Path(args.registry_config), "registry probe ORAS config", MAX_MANIFEST_BYTES
    )
    for name in (
        "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN",
        "HOMEBREW_GITHUB_PACKAGES_TOKEN", "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    ):
        if os.environ.get(name):
            fail(f"registry probe received {name}")

    with tempfile.TemporaryDirectory(prefix="homebrew-registry-probe-") as temporary_name:
        output = pathlib.Path(temporary_name) / "response.json"
        if args.kind == "manifest":
            target = f"{remote}:{reference}"
            status, error = run_oras_fetch(
                registry_config=registry_config,
                target=target,
                output=output,
                maximum=MAX_MANIFEST_BYTES,
                descriptor=True,
            )
        else:
            target = remote
            status, error = run_oras_repository_probe(
                registry_config=registry_config, remote=remote, output=output
            )

        if status != 0:
            result = classify_registry_error(error, target=target, kind=args.kind)
            if result is None:
                fail(
                    f"could not classify {args.kind} registry probe: "
                    f"{command_error_detail(error)}"
                )
            write_json(
                pathlib.Path(args.out_result),
                {"digest": None, "kind": args.kind, "schema": 1, "status": result},
            )
            return

        if args.kind == "manifest":
            descriptor = exact_keys(
                load_json(output, "registry probe descriptor", MAX_MANIFEST_BYTES),
                {"digest", "mediaType", "size"},
                "registry probe descriptor",
            )
            if descriptor["mediaType"] not in (OCI_MANIFEST, OCI_INDEX):
                fail("registry probe descriptor has an unsupported media type")
            digest = digest_value(descriptor["digest"], "registry probe descriptor digest")
            require_int(descriptor["size"], "registry probe descriptor size", 1)
            result_digest: str | None = f"sha256:{digest}"
        else:
            tags = exact_keys(
                load_json(output, "registry repository probe", MAX_MANIFEST_BYTES),
                {"tags"},
                "registry repository probe",
            )["tags"]
            if not isinstance(tags, list):
                fail("registry repository probe tags must be an array")
            if tags != []:
                fail("registry returned tags after the maximal legal OCI tag")
            result_digest = None
        write_json(
            pathlib.Path(args.out_result),
            {"digest": result_digest, "kind": args.kind, "schema": 1, "status": "present"},
        )


def remote_descriptor(
    value: Any, label: str, media_type: str, maximum: int
) -> tuple[dict[str, Any], str, int]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    require_bounded_json(value, label)
    if value.get("mediaType") != media_type:
        fail(f"{label} has the wrong media type")
    digest = digest_value(value.get("digest"), f"{label} digest")
    size = require_int(value.get("size"), f"{label} size", 1)
    if size > maximum:
        fail(f"{label} exceeds {maximum} bytes")
    return value, digest, size


def resolve_remote_blob_descriptor(
    *,
    registry_config: pathlib.Path,
    remote: str,
    digest: str,
    declared_size: int,
    maximum: int,
    label: str,
    temporary: pathlib.Path,
) -> None:
    output = temporary / f"{label.replace(' ', '-')}-{digest}-descriptor.json"
    status, error = run_oras_blob_descriptor_fetch(
        registry_config=registry_config,
        target=f"{remote}@sha256:{digest}",
        output=output,
    )
    if status != 0:
        fail(f"cannot resolve digest-pinned {label}: {command_error_detail(error)}")
    descriptor = load_json(output, f"resolved {label}", MAX_MANIFEST_BYTES)
    if not isinstance(descriptor, dict):
        fail(f"resolved {label} must be an object")
    require_bounded_json(descriptor, f"resolved {label}")
    resolved_digest = digest_value(
        descriptor.get("digest"), f"resolved {label} digest"
    )
    resolved_size = require_int(
        descriptor.get("size"), f"resolved {label} size", 1
    )
    if resolved_size > maximum:
        fail(f"resolved {label} exceeds {maximum} bytes")
    if resolved_digest != digest or resolved_size != declared_size:
        fail(f"resolved {label} does not match its manifest descriptor")


def fetch_remote_json(
    *,
    registry_config: pathlib.Path,
    remote: str,
    digest: str,
    size: int,
    maximum: int,
    label: str,
    temporary: pathlib.Path,
) -> Any:
    if size > maximum:
        fail(f"{label} exceeds {maximum} bytes")
    output = temporary / f"{label.replace(' ', '-')}-{digest}.json"
    status, error = run_oras_fetch(
        registry_config=registry_config,
        target=f"{remote}@sha256:{digest}",
        output=output,
        maximum=size,
    )
    if status != 0:
        fail(f"cannot fetch digest-pinned {label}: {command_error_detail(error)}")
    payload = output.read_bytes()
    if len(payload) != size or sha256_bytes(payload) != digest:
        fail(f"digest-pinned {label} does not match its descriptor")
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error_value:
        fail(f"{label} is not valid UTF-8 JSON: {error_value}")
    if payload != canonical_json(document):
        fail(f"{label} is not canonical JSON")
    require_bounded_json(document, label)
    return document


def validate_remote_index_graph(
    *,
    registry_config: pathlib.Path,
    remote: str,
    descriptor: dict[str, Any],
    temporary: pathlib.Path,
) -> tuple[str, int]:
    _descriptor, top_digest, top_size = remote_descriptor(
        descriptor, "public top descriptor", OCI_INDEX, MAX_JSON
    )
    top = exact_keys(
        fetch_remote_json(
            registry_config=registry_config,
            remote=remote,
            digest=top_digest,
            size=top_size,
            maximum=MAX_JSON,
            label="public top index",
            temporary=temporary,
        ),
        {"annotations", "manifests", "mediaType", "schemaVersion"},
        "public top index",
    )
    if top["mediaType"] != OCI_INDEX or top["schemaVersion"] != 2:
        fail("public top index has the wrong media type or schema")
    manifests = top["manifests"]
    if not isinstance(manifests, list) or not 1 <= len(manifests) <= 2:
        fail("public top index must contain one or two child manifests")

    child_digests: set[str] = set()
    variants: set[str] = set()
    for index, value in enumerate(manifests):
        child = exact_keys(
            value,
            {"annotations", "digest", "mediaType", "platform", "size"},
            f"public child descriptor {index}",
        )
        _child, child_digest, child_size = remote_descriptor(
            child, f"public child descriptor {index}", OCI_MANIFEST, MAX_JSON
        )
        if child_digest in child_digests:
            fail("public top index repeats a child manifest digest")
        child_digests.add(child_digest)
        platform = child["platform"]
        if platform not in (
            {"architecture": "wasm", "os": "kandelo", "variant": "wasm32"},
            {"architecture": "wasm", "os": "kandelo", "variant": "wasm64"},
        ):
            fail(f"public child descriptor {index} has invalid platform metadata")
        if platform["variant"] in variants:
            fail("public top index repeats a Kandelo architecture")
        variants.add(platform["variant"])

        manifest = exact_keys(
            fetch_remote_json(
                registry_config=registry_config,
                remote=remote,
                digest=child_digest,
                size=child_size,
                maximum=MAX_JSON,
                label=f"public child manifest {index}",
                temporary=temporary,
            ),
            {"annotations", "config", "layers", "mediaType", "schemaVersion"},
            f"public child manifest {index}",
        )
        if manifest["mediaType"] != OCI_MANIFEST or manifest["schemaVersion"] != 2:
            fail(f"public child manifest {index} has the wrong media type or schema")
        config = exact_keys(
            manifest["config"],
            {"digest", "mediaType", "size"},
            f"public child config descriptor {index}",
        )
        _config, config_digest, config_size = remote_descriptor(
            config, f"public child config descriptor {index}", OCI_CONFIG, MAX_JSON
        )
        config_document = exact_keys(
            fetch_remote_json(
                registry_config=registry_config,
                remote=remote,
                digest=config_digest,
                size=config_size,
                maximum=MAX_JSON,
                label=f"public child config {index}",
                temporary=temporary,
            ),
            {"architecture", "os", "rootfs", "variant"},
            f"public child config {index}",
        )
        if {key: config_document[key] for key in ("architecture", "os", "variant")} != platform:
            fail(f"public child config {index} does not match its platform")
        rootfs = exact_keys(
            config_document["rootfs"], {"diff_ids", "type"},
            f"public child config rootfs {index}",
        )
        if (
            rootfs["type"] != "layers"
            or not isinstance(rootfs["diff_ids"], list)
            or len(rootfs["diff_ids"]) != 1
        ):
            fail(f"public child config rootfs {index} is invalid")
        digest_value(rootfs["diff_ids"][0], f"public child config diff_id {index}")

        layers = manifest["layers"]
        if not isinstance(layers, list) or len(layers) != 1:
            fail(f"public child manifest {index} must contain exactly one layer")
        layer = exact_keys(
            layers[0],
            {"annotations", "digest", "mediaType", "size"},
            f"public bottle layer descriptor {index}",
        )
        _layer, layer_digest, layer_size = remote_descriptor(
            layer, f"public bottle layer descriptor {index}", OCI_LAYER,
            MAX_BOTTLE_BYTES,
        )
        resolve_remote_blob_descriptor(
            registry_config=registry_config,
            remote=remote,
            digest=layer_digest,
            declared_size=layer_size,
            maximum=MAX_BOTTLE_BYTES,
            label=f"public bottle layer {index}",
            temporary=temporary,
        )
    return top_digest, top_size


def import_public_index(args: argparse.Namespace) -> None:
    remote = require_string(args.remote, "public OCI remote", OCI_REMOTE)
    reference = require_string(args.reference, "public OCI reference", OCI_TAG)
    registry_config = pathlib.Path(args.registry_config)
    if load_json(registry_config, "anonymous ORAS registry config", MAX_MANIFEST_BYTES) != {
        "auths": {}
    }:
        fail("anonymous ORAS registry config must contain only an empty auths object")
    for name in (
        "GH_TOKEN", "GITHUB_TOKEN", "HOMEBREW_GITHUB_API_TOKEN",
        "HOMEBREW_GITHUB_PACKAGES_TOKEN", "HOMEBREW_DOCKER_REGISTRY_TOKEN",
    ):
        if os.environ.get(name):
            fail(f"anonymous public-index import received {name}")
    output_layout = pathlib.Path(args.out_layout)
    if output_layout.exists() or output_layout.is_symlink():
        fail(f"public-index output layout already exists: {output_layout}")
    output_layout.parent.mkdir(parents=True, exist_ok=True)
    output_result = pathlib.Path(args.out_result)

    with tempfile.TemporaryDirectory(prefix="homebrew-public-index-") as temporary_name:
        temporary = pathlib.Path(temporary_name)
        descriptor_path = temporary / "descriptor.json"
        status, error = run_oras_fetch(
            registry_config=registry_config,
            target=f"{remote}:{reference}",
            output=descriptor_path,
            maximum=MAX_MANIFEST_BYTES,
            descriptor=True,
        )
        if status != 0:
            result = classify_registry_error(
                error, target=f"{remote}:{reference}", kind="manifest"
            )
            if result == "missing":
                write_json(output_result, {"schema": 1, "status": "missing"})
                return
            if result == "auth-required":
                fail(
                    f"{remote}:{reference} is not anonymously readable; "
                    "an authorized owner must make the GHCR package public"
                )
            fail(
                "could not classify anonymous Homebrew index import: "
                f"{command_error_detail(error)}"
            )
        descriptor = load_json(
            descriptor_path, "public top descriptor", MAX_MANIFEST_BYTES
        )
        top_digest, top_size = validate_remote_index_graph(
            registry_config=registry_config,
            remote=remote,
            descriptor=descriptor,
            temporary=temporary,
        )
        confirmed_path = temporary / "confirmed-descriptor.json"
        confirmed_status, confirmed_error = run_oras_fetch(
            registry_config=registry_config,
            target=f"{remote}:{reference}",
            output=confirmed_path,
            maximum=MAX_MANIFEST_BYTES,
            descriptor=True,
        )
        if confirmed_status != 0:
            fail(
                "public top reference changed during descriptor validation: "
                f"{command_error_detail(confirmed_error)}"
            )
        _confirmed, confirmed_digest, confirmed_size = remote_descriptor(
            load_json(
                confirmed_path, "confirmed public top descriptor", MAX_MANIFEST_BYTES
            ),
            "confirmed public top descriptor",
            OCI_INDEX,
            MAX_JSON,
        )
        if confirmed_digest != top_digest or confirmed_size != top_size:
            fail("public top reference changed during descriptor validation")

    result = subprocess.run(
        [
            "oras", "cp", "--from-registry-config", str(registry_config),
            "--to-oci-layout", f"{remote}@sha256:{top_digest}",
            f"{output_layout}:{reference}",
        ],
        check=False,
        stdin=subprocess.DEVNULL,
        timeout=1800,
    )
    if result.returncode != 0:
        fail("digest-pinned anonymous Homebrew index copy failed")
    root = exact_keys(
        load_layout_root(output_layout),
        {"annotations", "digest", "mediaType", "size"},
        "imported public top descriptor",
    )
    if (
        root["mediaType"] != OCI_INDEX
        or root["digest"] != f"sha256:{top_digest}"
        or root["size"] != top_size
        or root["annotations"] != {"org.opencontainers.image.ref.name": reference}
    ):
        fail("digest-pinned imported layout does not match the validated top descriptor")
    write_json(
        output_result,
        {
            "digest": f"sha256:{top_digest}",
            "layout": str(output_layout),
            "schema": 1,
            "status": "present",
        },
    )


def validate_publication_receipt_command(args: argparse.Namespace) -> None:
    formula = require_string(args.formula, "publication Formula", FORMULA_NAME)
    tap_repository = require_string(
        args.tap_repository, "publication tap repository", TAP_REPOSITORY
    )
    tap_name = selected_tap_name(args)
    layout_path = pathlib.Path(args.layout_receipt)
    if args.kind == "child":
        layout = load_receipt(layout_path)
        expected_reference = layout["oci"]["transport_tag"]
        expected_digest = layout["oci"]["manifest"]["digest"]
        expected_previous = None
    else:
        layout = validate_index_receipt(
            load_json(layout_path, "OCI index receipt", MAX_RECEIPT_BYTES)
        )
        expected_reference = layout["top"]["ref"]
        expected_digest = layout["top"]["digest"]
        expected_previous = layout["top"]["previous_digest"]
    if (
        layout["formula"] != formula
        or normalized_identity(layout["tap_repository"]) != normalized_identity(tap_repository)
        or normalized_identity(layout["tap_name"]) != tap_name
    ):
        fail("publication layout identity does not match the requested Formula and tap")

    receipt = exact_keys(
        load_json(pathlib.Path(args.receipt), "OCI publication receipt", MAX_RECEIPT_BYTES),
        {
            "formula", "kind", "layout", "layout_receipt_sha256", "publication",
            "schema", "tap_name", "tap_repository",
        },
        "OCI publication receipt",
    )
    if receipt["schema"] != 3 or receipt["kind"] != args.kind:
        fail("OCI publication receipt has an invalid schema or kind")
    receipt_formula = require_string(
        receipt["formula"], "OCI publication receipt Formula", FORMULA_NAME
    )
    receipt_tap = require_string(
        receipt["tap_repository"], "OCI publication receipt tap repository", TAP_REPOSITORY
    )
    receipt_tap_name = require_string(
        receipt["tap_name"], "OCI publication receipt tap name", TAP_REPOSITORY
    )
    if (
        receipt_formula != formula
        or normalized_identity(receipt_tap) != normalized_identity(tap_repository)
        or normalized_identity(receipt_tap_name) != tap_name
    ):
        fail("OCI publication receipt identity does not match the requested Formula and tap")
    if receipt["layout"] != layout:
        fail("OCI publication receipt does not embed the exact layout receipt")
    # Match `jq -cS`, the receipt hash producer used by the transport script.
    layout_sha256 = sha256_bytes(canonical_json(layout) + b"\n")
    if receipt["layout_receipt_sha256"] != layout_sha256:
        fail("OCI publication receipt layout hash does not match its canonical layout receipt")

    publication = exact_keys(
        receipt["publication"],
        {
            "digest", "previous_digest", "public_readback_digest", "reference", "remote",
            "status",
        },
        "OCI publication result",
    )
    expected_remote = f"ghcr.io/{normalized_identity(tap_repository)}/{formula}"
    if publication["remote"] != expected_remote:
        fail("OCI publication receipt remote is invalid")
    if publication["reference"] != expected_reference:
        fail("OCI publication receipt reference does not match the layout")
    if publication["digest"] != expected_digest:
        fail("OCI publication receipt digest does not match the layout")
    if publication["previous_digest"] != expected_previous:
        fail("OCI publication receipt previous digest does not match the layout")
    if args.allow_dry_run:
        if (
            publication["status"] != "dry-run"
            or publication["public_readback_digest"] is not None
        ):
            fail("dry-run publication receipt contains public publication evidence")
    elif publication["status"] not in ("uploaded", "already-present") or publication[
        "public_readback_digest"
    ] != expected_digest:
        fail("publication receipt lacks exact anonymous public readback evidence")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    child = commands.add_parser("build-child")
    for flag in (
        "formula", "arch", "tap-repository", "tap-commit", "kandelo-commit",
        "bottle-root-url", "bottle", "bottle-json", "kandelo-root", "tap-root",
        "out-layout", "out-receipt",
    ):
        child.add_argument(f"--{flag}", required=True)
    child.add_argument("--tap-name")
    child.add_argument("--abi", type=int, required=True)
    child.set_defaults(handler=build_child)
    merge = commands.add_parser("merge-index")
    merge.add_argument("--child-layout", action="append", default=[])
    merge.add_argument("--child-receipt", action="append", default=[])
    merge.add_argument("--existing-layout")
    merge.add_argument("--out-layout", required=True)
    merge.add_argument("--out-receipt", required=True)
    merge.set_defaults(handler=merge_index)
    validate_child = commands.add_parser("validate-child")
    validate_child.add_argument("--layout", required=True)
    validate_child.add_argument("--receipt", required=True)
    validate_child.set_defaults(handler=validate_child_command)
    validate_child_receipt = commands.add_parser("validate-child-receipt")
    validate_child_receipt.add_argument("--receipt", required=True)
    validate_child_receipt.set_defaults(handler=validate_child_receipt_command)
    closure = commands.add_parser("source-closure")
    for flag in ("tap-root", "kandelo-root", "tap-repository", "formula", "out"):
        closure.add_argument(f"--{flag}", required=True)
    closure.add_argument("--tap-name")
    closure.set_defaults(handler=source_closure_command)
    validate_index = commands.add_parser("validate-index")
    validate_index.add_argument("--layout", required=True)
    validate_index.add_argument("--receipt", required=True)
    validate_index.set_defaults(handler=validate_index_command)
    validate_index_receipt = commands.add_parser("validate-index-receipt")
    validate_index_receipt.add_argument("--receipt", required=True)
    validate_index_receipt.set_defaults(handler=validate_index_receipt_command)
    import_index = commands.add_parser("import-public-index")
    for flag in (
        "remote", "reference", "registry-config", "out-layout", "out-result",
    ):
        import_index.add_argument(f"--{flag}", required=True)
    import_index.set_defaults(handler=import_public_index)
    probe_registry = commands.add_parser("probe-registry")
    probe_registry.add_argument("--kind", choices=("manifest", "repository"), required=True)
    for flag in ("remote", "reference", "registry-config", "out-result"):
        probe_registry.add_argument(f"--{flag}", required=True)
    probe_registry.set_defaults(handler=registry_probe)
    validate_publication_receipt = commands.add_parser("validate-publication-receipt")
    validate_publication_receipt.add_argument("--receipt", required=True)
    validate_publication_receipt.add_argument("--layout-receipt", required=True)
    validate_publication_receipt.add_argument("--kind", choices=("child", "index"), required=True)
    validate_publication_receipt.add_argument("--formula", required=True)
    validate_publication_receipt.add_argument("--tap-repository", required=True)
    validate_publication_receipt.add_argument("--tap-name")
    validate_publication_receipt.add_argument("--allow-dry-run", action="store_true")
    validate_publication_receipt.set_defaults(handler=validate_publication_receipt_command)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (
        KeyError, LayoutError, OSError, subprocess.SubprocessError, tarfile.TarError,
        TypeError, ValueError,
    ) as error:
        print(f"homebrew-oci-layout.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
