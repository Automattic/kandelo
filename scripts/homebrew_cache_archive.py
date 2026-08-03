"""Bounded evidence for an exact Homebrew bottle archive.

Homebrew's progress renderer is not an artifact-selection API.  These helpers
bind provenance to the regular archive bytes Homebrew retained instead of to
optional human-readable download lines.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import stat
from typing import Any


MAX_BOTTLE_BYTES = 2_147_483_648


class CacheArchiveError(RuntimeError):
    pass


def _fail(message: str) -> None:
    raise CacheArchiveError(message)


def _stable_file_identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_gid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _hash_stable_regular_archive(path: pathlib.Path) -> dict[str, Any]:
    try:
        before_path = path.lstat()
    except FileNotFoundError:
        _fail(f"Homebrew bottle archive does not exist: {path}")
    if not stat.S_ISREG(before_path.st_mode) or path.is_symlink():
        _fail("Homebrew bottle archive must be a regular non-symlink file")
    if before_path.st_nlink != 1:
        _fail("Homebrew bottle archive must be single-linked")
    if before_path.st_size <= 0 or before_path.st_size > MAX_BOTTLE_BYTES:
        _fail(f"Homebrew bottle archive must contain 1-{MAX_BOTTLE_BYTES} bytes")

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except (OSError, RuntimeError) as error:
        _fail(f"could not open Homebrew bottle archive safely: {error}")
    digest = hashlib.sha256()
    try:
        before_fd = os.fstat(descriptor)
        if _stable_file_identity(before_fd) != _stable_file_identity(before_path):
            _fail("Homebrew bottle archive changed before hashing")
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after_fd = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        after_path = path.lstat()
    except FileNotFoundError:
        _fail("Homebrew bottle archive disappeared while hashing")
    identity = _stable_file_identity(before_path)
    if (
        _stable_file_identity(before_fd) != identity
        or _stable_file_identity(after_fd) != identity
        or _stable_file_identity(after_path) != identity
    ):
        _fail("Homebrew bottle archive changed while hashing")
    return {
        "bytes": before_path.st_size,
        "cache_basename": path.name,
        "sha256": digest.hexdigest(),
    }


def expected_cache_basename(bottle_url: str, bottle_filename: str) -> str:
    url_sha256 = hashlib.sha256(bottle_url.encode("utf-8")).hexdigest()
    return f"{url_sha256}--{bottle_filename}"


def hash_exact_cached_archive(
    cache_root: pathlib.Path,
    reported_path: str,
    bottle_url: str,
    *,
    bottle_filename: str | None = None,
    bottle_sha256: str | None = None,
    bottle_bytes: int | None = None,
) -> dict[str, Any]:
    if (
        not cache_root.is_absolute()
        or cache_root.is_symlink()
        or not cache_root.is_dir()
    ):
        _fail("Homebrew cache root must be a real absolute directory")
    try:
        resolved_cache = cache_root.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        _fail(f"could not resolve Homebrew cache root: {error}")
    # WHY: checking only the final component would let a caller present the
    # same mutable cache through a symlinked ancestor. Evidence records must
    # name the one canonical tree whose containment and ownership were checked.
    if resolved_cache != cache_root:
        _fail("Homebrew cache root must use its canonical path")
    downloads = cache_root / "downloads"
    try:
        resolved_downloads = downloads.resolve(strict=True)
    except OSError as error:
        _fail(f"could not resolve Homebrew downloads cache: {error}")
    if (
        downloads.is_symlink()
        or not downloads.is_dir()
        or resolved_downloads != downloads
    ):
        _fail("Homebrew downloads cache must be one real contained directory")

    lines = reported_path.splitlines()
    if len(lines) != 1 or not lines[0] or lines[0].strip() != lines[0]:
        _fail("brew --cache must report exactly one canonical path")
    if any(ord(character) < 0x20 for character in lines[0]):
        _fail("brew --cache reported a path with a control character")
    archive = pathlib.Path(lines[0])
    if not archive.is_absolute() or archive.parent != resolved_downloads:
        _fail("brew --cache reported a path outside the downloads cache")

    url_sha256 = hashlib.sha256(bottle_url.encode("utf-8")).hexdigest()
    expected_prefix = f"{url_sha256}--"
    basename = archive.name
    if bottle_filename is None:
        canonical_name = basename.startswith(expected_prefix) and basename.endswith(
            ".tar.gz"
        )
    else:
        canonical_name = basename == expected_cache_basename(
            bottle_url, bottle_filename
        )
    if (
        not canonical_name
        or len(basename.encode("utf-8")) > 1_024
        or "/" in basename
        or "\\" in basename
    ):
        _fail("brew --cache reported a non-canonical bottle cache name")

    archive_record = _hash_stable_regular_archive(archive)
    validate_archive_record(
        archive_record,
        bottle_url,
        bottle_filename=bottle_filename,
        bottle_sha256=bottle_sha256,
        bottle_bytes=bottle_bytes,
    )
    return archive_record


def hash_exact_local_archive(
    path: pathlib.Path,
    bottle_filename: str,
    bottle_sha256: str,
    bottle_bytes: int,
) -> dict[str, Any]:
    if not path.is_absolute() or path.name != bottle_filename:
        _fail("local bottle input does not use the canonical Homebrew filename")
    archive_record = _hash_stable_regular_archive(path)
    validate_archive_record(
        archive_record,
        "",
        bottle_filename=bottle_filename,
        bottle_sha256=bottle_sha256,
        bottle_bytes=bottle_bytes,
        local=True,
    )
    return archive_record


def validate_archive_record(
    archive: Any,
    bottle_url: str,
    *,
    bottle_filename: str | None = None,
    bottle_sha256: str | None = None,
    bottle_bytes: int | None = None,
    local: bool = False,
) -> dict[str, Any]:
    if not isinstance(archive, dict) or set(archive) != {
        "bytes",
        "cache_basename",
        "sha256",
    }:
        _fail("Homebrew bottle archive evidence has an invalid shape")
    byte_count = archive["bytes"]
    if (
        not isinstance(byte_count, int)
        or isinstance(byte_count, bool)
        or byte_count <= 0
        or byte_count > MAX_BOTTLE_BYTES
    ):
        _fail("Homebrew bottle archive evidence has an invalid byte count")
    digest = archive["sha256"]
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        _fail("Homebrew bottle archive evidence has an invalid digest")
    basename = archive["cache_basename"]
    if (
        not isinstance(basename, str)
        or not basename
        or len(basename.encode("utf-8")) > 1_024
        or "/" in basename
        or "\\" in basename
    ):
        _fail("Homebrew bottle archive evidence has an invalid cache name")
    if bottle_filename is not None:
        expected_basename = (
            bottle_filename
            if local
            else expected_cache_basename(bottle_url, bottle_filename)
        )
        if basename != expected_basename:
            _fail("Homebrew bottle archive evidence has the wrong canonical name")
    if bottle_sha256 is not None and digest != bottle_sha256:
        _fail("Homebrew bottle archive digest differs from the selected bottle")
    if bottle_bytes is not None and byte_count != bottle_bytes:
        _fail("Homebrew bottle archive byte count differs from the selected bottle")
    return archive
