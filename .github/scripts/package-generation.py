#!/usr/bin/env python3
"""Build and validate durable, content-addressed package generations."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any


HEX_40 = re.compile(r"^[0-9a-f]{40}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
PACKAGE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ARCH = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ASSET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst$")
STAGING_TAG = re.compile(r"^pr-[1-9][0-9]*-staging$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
IDENTITY_FORMAT = "kandelo-package-generation-identity-v1"
MANIFEST_FORMAT = "kandelo-package-generation-v1"
PROJECTION_SCHEMA = 1
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_ARCHIVES = 256
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024


class ContractError(ValueError):
    """An input violates the durable package-generation contract."""


def fail(message: str) -> None:
    raise ContractError(message)


def object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON contains duplicate key {key!r}")
        result[key] = value
    return result


def read_json(path: Path, *, max_bytes: int | None = None) -> Any:
    if not path.is_file() or path.is_symlink():
        fail(f"{path} must be a regular file")
    if max_bytes is not None and path.stat().st_size > max_bytes:
        fail(f"{path} exceeds the {max_bytes}-byte input limit")
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=object_without_duplicate_keys,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read strict JSON from {path}: {error}")


def canonical_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def write_json(path: Path, value: Any) -> None:
    path.write_bytes(canonical_bytes(value))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path, context: str) -> None:
    if not path.is_file() or path.is_symlink():
        fail(f"{context} must be a regular file: {path}")


def exact_keys(value: Any, keys: set[str], context: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{context} must contain exactly {sorted(keys)}")
    return value


def integer(
    value: Any, context: str, *, minimum: int = 0, maximum: int | None = None
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        bounds = f">= {minimum}"
        if maximum is not None:
            bounds += f" and <= {maximum}"
        fail(f"{context} must be an integer {bounds}")
    return value


def text_matching(value: Any, pattern: re.Pattern[str], context: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        fail(f"{context} has an invalid value")
    return value


def validate_projection(value: Any) -> dict[str, Any]:
    projection = exact_keys(
        value,
        {"schema", "root_package", "arch", "entries"},
        "package projection",
    )
    if projection["schema"] != PROJECTION_SCHEMA:
        fail("package projection schema is unsupported")
    root = text_matching(projection["root_package"], PACKAGE, "projection root")
    arch = text_matching(projection["arch"], ARCH, "projection arch")
    entries = projection["entries"]
    if (
        not isinstance(entries, list)
        or len(entries) < 1
        or len(entries) > MAX_ARCHIVES
    ):
        fail(f"package projection must contain 1..{MAX_ARCHIVES} entries")
    normalized: list[dict[str, str]] = []
    for index, raw in enumerate(entries):
        entry = exact_keys(
            raw,
            {"package", "arch", "manifest_sha256", "cache_key_sha"},
            f"projection entry {index}",
        )
        package = text_matching(entry["package"], PACKAGE, "projection package")
        entry_arch = text_matching(entry["arch"], ARCH, "projection entry arch")
        manifest = text_matching(
            entry["manifest_sha256"], HEX_64, "projection manifest digest"
        )
        cache_key = text_matching(
            entry["cache_key_sha"], HEX_64, "projection cache key"
        )
        if entry_arch != arch:
            fail("projection entries must use the selected architecture")
        normalized.append(
            {
                "package": package,
                "arch": entry_arch,
                "manifest_sha256": manifest,
                "cache_key_sha": cache_key,
            }
        )
    if normalized != sorted(normalized, key=lambda item: (item["package"], item["arch"])):
        fail("projection entries must be sorted")
    identities = [(entry["package"], entry["arch"]) for entry in normalized]
    if len(identities) != len(set(identities)):
        fail("projection contains duplicate package identities")
    if (root, arch) not in set(identities):
        fail("projection does not contain its root package")
    return {
        "schema": PROJECTION_SCHEMA,
        "root_package": root,
        "arch": arch,
        "entries": normalized,
    }


def select_projection(program_packages: Any, root: str, arch: str) -> dict[str, Any]:
    text_matching(root, PACKAGE, "root package")
    text_matching(arch, ARCH, "architecture")
    if not isinstance(program_packages, dict):
        fail("program-packages.json must be an object")
    if program_packages.get("format") != "kandelo-program-packages-v2":
        fail("program-packages.json has an unsupported format")
    packages = program_packages.get("packages")
    if not isinstance(packages, dict) or root not in packages:
        fail(f"program-packages.json does not contain {root}")
    root_record = packages[root]
    if not isinstance(root_record, dict):
        fail(f"program package {root} must be an object")
    arches = root_record.get("arches")
    if not isinstance(arches, list) or arch not in arches:
        fail(f"program package {root} does not support {arch}")
    manifests = root_record.get("manifestSha256")
    cache_keys = root_record.get("cacheKeys")
    closures = root_record.get("dependencyClosures")
    root_manifest = text_matching(manifests, HEX_64, f"{root} manifest digest")
    if not isinstance(cache_keys, dict) or not isinstance(closures, dict):
        fail(f"program package {root} lacks cache keys or dependency closures")
    root_cache = text_matching(cache_keys.get(arch), HEX_64, f"{root} cache key")
    closure = closures.get(arch)
    if not isinstance(closure, list):
        fail(f"program package {root} lacks the {arch} dependency closure")
    entries: list[dict[str, str]] = []
    for index, raw in enumerate(closure):
        if not isinstance(raw, dict):
            fail(f"{root} dependency closure entry {index} must be an object")
        entries.append(
            {
                "package": text_matching(
                    raw.get("packageName"), PACKAGE, "closure package"
                ),
                "arch": arch,
                "manifest_sha256": text_matching(
                    raw.get("manifestSha256"), HEX_64, "closure manifest digest"
                ),
                "cache_key_sha": text_matching(
                    raw.get("cacheKey"), HEX_64, "closure cache key"
                ),
            }
        )
    entries.append(
        {
            "package": root,
            "arch": arch,
            "manifest_sha256": root_manifest,
            "cache_key_sha": root_cache,
        }
    )
    projection = {
        "schema": PROJECTION_SCHEMA,
        "root_package": root,
        "arch": arch,
        "entries": sorted(entries, key=lambda item: (item["package"], item["arch"])),
    }
    return validate_projection(projection)


def select_expected(
    full_expected: Any, projection: dict[str, Any], abi_version: int
) -> dict[str, Any]:
    if not isinstance(full_expected, dict):
        fail("expected ledger must be an object")
    if full_expected.get("abi_version") != abi_version:
        fail("expected ledger ABI differs from the selected ABI")
    raw_entries = full_expected.get("entries")
    if not isinstance(raw_entries, list):
        fail("expected ledger entries must be an array")
    wanted = {
        (entry["package"], entry["arch"]): entry["cache_key_sha"]
        for entry in projection["entries"]
    }
    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in raw_entries:
        if not isinstance(raw, dict):
            fail("expected ledger entries must be objects")
        package = raw.get("package")
        arch = raw.get("arch")
        if (package, arch) not in wanted:
            continue
        identity = (package, arch)
        if identity in seen:
            fail("expected ledger contains a duplicate selected package")
        seen.add(identity)
        if raw.get("cache_key_sha") != wanted[identity]:
            fail(f"expected ledger cache identity differs for {package} {arch}")
        selected.append(raw)
    if seen != set(wanted):
        missing = sorted(set(wanted) - seen)
        fail(f"expected ledger lacks selected package identities: {missing}")
    selected.sort(key=lambda item: (item["package"], item["arch"]))
    return {"abi_version": abi_version, "entries": selected}


def selection_from_files(
    program_packages_path: Path,
    full_expected_path: Path,
    root: str,
    arch: str,
    abi_version: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    projection = select_projection(read_json(program_packages_path), root, arch)
    expected = select_expected(read_json(full_expected_path), projection, abi_version)
    return projection, expected


def validate_snapshot(
    value: Any,
    projection: dict[str, Any],
    expected: dict[str, Any],
    source_tag: str,
    abi_version: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(value, dict):
        fail("validated staging snapshot must be an object")
    if (
        value.get("abi_version") != abi_version
        or value.get("release_tag") != source_tag
        or value.get("complete_current") is not True
    ):
        fail("validated staging snapshot does not bind the source tag and ABI")
    raw_entries = value.get("entries")
    if not isinstance(raw_entries, list):
        fail("validated staging snapshot entries must be an array")
    wanted = {
        (entry["package"], entry["arch"]): entry["cache_key_sha"]
        for entry in projection["entries"]
    }
    expected_keys = {
        (entry.get("package"), entry.get("arch"), entry.get("cache_key_sha"))
        for entry in expected["entries"]
    }
    if expected_keys != {
        (package, arch, cache) for (package, arch), cache in wanted.items()
    }:
        fail("expected ledger and package projection identities differ")
    seen: set[tuple[str, str]] = set()
    archives: list[dict[str, Any]] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            fail("snapshot entries must be objects")
        package = raw.get("package")
        arch = raw.get("arch")
        identity = (package, arch)
        if identity not in wanted or identity in seen:
            fail("snapshot has an unexpected or duplicate package identity")
        seen.add(identity)
        if raw.get("current") is not True or raw.get("cache_key_sha") != wanted[identity]:
            fail(f"snapshot is not exact-current for {package} {arch}")
        name = text_matching(raw.get("asset"), ASSET, "snapshot archive name")
        digest = text_matching(
            raw.get("archive_sha256"), HEX_64, "snapshot archive digest"
        )
        size = integer(
            raw.get("size"),
            "snapshot archive size",
            minimum=1,
            maximum=MAX_ARCHIVE_BYTES,
        )
        archives.append(
            {
                "package": package,
                "arch": arch,
                "name": name,
                "sha256": digest,
                "bytes": size,
            }
        )
    if seen != set(wanted):
        fail("snapshot does not contain the complete package projection")
    if sum(record["bytes"] for record in archives) > MAX_TOTAL_ARCHIVE_BYTES:
        fail("snapshot declares too many aggregate archive bytes")
    archives.sort(key=lambda item: item["name"])
    names = [item["name"] for item in archives]
    if len(names) != len(set(names)):
        fail("snapshot maps multiple packages to one archive name")
    return value, archives


def rewrite_localized_index(
    localized: bytes, archive_names: list[str], release_prefix: str
) -> bytes:
    try:
        text = localized.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"localized index is not UTF-8: {error}")
    if len(localized) > MAX_INDEX_BYTES:
        fail("localized index exceeds the public-input size limit")
    if re.search(r"^fallback_[A-Za-z0-9_]*\s*=", text, re.MULTILINE):
        fail("durable generation index must not contain fallback fields")
    pattern = re.compile(r'^archive_url = "([^"]+)"$', re.MULTILINE)
    found = pattern.findall(text)
    if sorted(found) != sorted(archive_names) or len(found) != len(archive_names):
        fail("localized index archive URLs do not exactly name the selected archives")
    for name in found:
        if ASSET.fullmatch(name) is None:
            fail("localized index contains a non-local archive URL")
    return pattern.sub(
        lambda match: f'archive_url = "{release_prefix}{match.group(1)}"', text
    ).encode("utf-8")


def recover_localized_index(
    remote: bytes, archive_names: list[str], release_prefix: str
) -> bytes:
    try:
        text = remote.decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"release index is not UTF-8: {error}")
    if len(remote) > MAX_INDEX_BYTES:
        fail("release index exceeds the public-input size limit")
    if re.search(r"^fallback_[A-Za-z0-9_]*\s*=", text, re.MULTILINE):
        fail("durable generation index must not contain fallback fields")
    pattern = re.compile(r'^archive_url = "([^"]+)"$', re.MULTILINE)
    found = pattern.findall(text)
    expected_urls = [release_prefix + name for name in archive_names]
    if sorted(found) != sorted(expected_urls) or len(found) != len(expected_urls):
        fail("release index does not use only the exact generation URLs")
    return pattern.sub(
        lambda match: f'archive_url = "{match.group(1)[len(release_prefix):]}"', text
    ).encode("utf-8")


def generation_tag(identity: dict[str, Any], digest: str) -> str:
    projection = identity["projection"]
    return (
        f"package-generation-{projection['root_package']}-{projection['arch']}"
        f"-abi-v{identity['abi_version']}-sha256-{digest}"
    )


def release_fields(identity: dict[str, Any], tag: str) -> dict[str, Any]:
    projection = identity["projection"]
    title = (
        f"Package generation: {projection['root_package']} {projection['arch']}, "
        f"ABI {identity['abi_version']}"
    )
    body = (
        "Durable Kandelo package generation.\n\n"
        f"Package source: `{identity['package_source_sha']}`\n"
        f"Source staging release: `{identity['source_staging']['tag']}`\n"
        f"Content identity: `{tag.rsplit('-sha256-', 1)[1]}`\n\n"
        "Consumers must validate `generation.json` and every asset; this "
        "prerelease is append-only by contract."
    )
    return {
        "title": title,
        "body": body,
        "target_commitish": identity["package_source_sha"],
        "prerelease": True,
    }


def validate_identity(value: Any) -> dict[str, Any]:
    identity = exact_keys(
        value,
        {
            "format",
            "repository",
            "package_source_sha",
            "abi_version",
            "projection",
            "expected_ledger",
            "validated_snapshot",
            "source_staging",
            "localized_index",
            "archives",
        },
        "generation identity",
    )
    if identity["format"] != IDENTITY_FORMAT:
        fail("generation identity format is unsupported")
    text_matching(identity["repository"], REPOSITORY, "generation repository")
    text_matching(identity["package_source_sha"], HEX_40, "package source SHA")
    abi_version = integer(identity["abi_version"], "generation ABI", minimum=1)
    projection = validate_projection(identity["projection"])
    expected = select_expected(identity["expected_ledger"], projection, abi_version)
    if expected != identity["expected_ledger"]:
        fail("generation expected ledger is not canonical")
    source = exact_keys(
        identity["source_staging"],
        {"tag", "index_sha256", "index_bytes"},
        "source staging identity",
    )
    text_matching(source["tag"], STAGING_TAG, "source staging tag")
    text_matching(source["index_sha256"], HEX_64, "source index digest")
    integer(
        source["index_bytes"],
        "source index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    localized = exact_keys(
        identity["localized_index"],
        {"sha256", "bytes"},
        "localized index identity",
    )
    text_matching(localized["sha256"], HEX_64, "localized index digest")
    integer(
        localized["bytes"],
        "localized index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    _, derived_archives = validate_snapshot(
        identity["validated_snapshot"],
        projection,
        expected,
        source["tag"],
        abi_version,
    )
    if identity["archives"] != derived_archives:
        fail("generation archives differ from the validated staging snapshot")
    return identity


def validate_manifest(value: Any) -> tuple[dict[str, Any], dict[str, Any], str]:
    manifest = exact_keys(
        value,
        {
            "format",
            "tag",
            "identity_sha256",
            "identity",
            "index",
            "release",
        },
        "generation manifest",
    )
    if manifest["format"] != MANIFEST_FORMAT:
        fail("generation manifest format is unsupported")
    identity = validate_identity(manifest["identity"])
    digest = sha256_bytes(canonical_bytes(identity))
    if manifest["identity_sha256"] != digest:
        fail("generation identity digest is incorrect")
    expected_tag = generation_tag(identity, digest)
    if manifest["tag"] != expected_tag:
        fail("generation tag is not derived from the exact content identity")
    index = exact_keys(manifest["index"], {"name", "sha256", "bytes"}, "release index")
    if index["name"] != "index.toml":
        fail("generation release index must be named index.toml")
    text_matching(index["sha256"], HEX_64, "release index digest")
    integer(
        index["bytes"],
        "release index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    if manifest["release"] != release_fields(identity, expected_tag):
        fail("generation release metadata is not derived from its identity")
    return manifest, identity, expected_tag


def command_select(args: argparse.Namespace) -> None:
    projection, expected = selection_from_files(
        args.program_packages,
        args.full_expected_ledger,
        args.root_package,
        args.arch,
        args.expected_abi,
    )
    write_json(args.projection_out, projection)
    write_json(args.expected_out, expected)


def command_prepare(args: argparse.Namespace) -> None:
    repository = text_matching(args.repository, REPOSITORY, "repository")
    package_source_sha = text_matching(
        args.package_source_sha, HEX_40, "package source SHA"
    )
    source_tag = text_matching(args.source_tag, STAGING_TAG, "source staging tag")
    if args.output_dir.exists() or args.output_dir.is_symlink():
        fail(f"output already exists: {args.output_dir}")
    projection = validate_projection(read_json(args.projection))
    expected_raw = read_json(args.expected_ledger)
    abi_version = integer(expected_raw.get("abi_version"), "expected ABI", minimum=1)
    expected = select_expected(expected_raw, projection, abi_version)
    if expected != expected_raw:
        fail("selected expected ledger is not canonical")
    snapshot, archives = validate_snapshot(
        read_json(args.snapshot),
        projection,
        expected,
        source_tag,
        abi_version,
    )
    regular_file(args.source_index, "source staging index")
    regular_file(args.localized_index, "localized minimal index")
    if args.source_index.stat().st_size > MAX_INDEX_BYTES:
        fail("source staging index exceeds the public-input size limit")
    localized_bytes = args.localized_index.read_bytes()
    archive_names = [record["name"] for record in archives]
    # Validate the local URL shape before deriving an identity from these bytes.
    rewrite_localized_index(localized_bytes, archive_names, "")
    for record in archives:
        archive = args.archives_dir / record["name"]
        regular_file(archive, "validated staging archive")
        if (
            archive.stat().st_size != record["bytes"]
            or sha256_file(archive) != record["sha256"]
        ):
            fail(f"validated archive bytes changed: {record['name']}")
    identity = {
        "format": IDENTITY_FORMAT,
        "repository": repository,
        "package_source_sha": package_source_sha,
        "abi_version": abi_version,
        "projection": projection,
        "expected_ledger": expected,
        "validated_snapshot": snapshot,
        "source_staging": {
            "tag": source_tag,
            "index_sha256": sha256_file(args.source_index),
            "index_bytes": args.source_index.stat().st_size,
        },
        "localized_index": {
            "sha256": sha256_bytes(localized_bytes),
            "bytes": len(localized_bytes),
        },
        "archives": archives,
    }
    validate_identity(identity)
    identity_digest = sha256_bytes(canonical_bytes(identity))
    tag = generation_tag(identity, identity_digest)
    release_prefix = (
        f"https://github.com/{repository}/releases/download/{tag}/"
    )
    remote_index = rewrite_localized_index(localized_bytes, archive_names, release_prefix)
    manifest = {
        "format": MANIFEST_FORMAT,
        "tag": tag,
        "identity_sha256": identity_digest,
        "identity": identity,
        "index": {
            "name": "index.toml",
            "sha256": sha256_bytes(remote_index),
            "bytes": len(remote_index),
        },
        "release": release_fields(identity, tag),
    }
    validate_manifest(manifest)
    temporary = args.output_dir.parent / f".{args.output_dir.name}.tmp-{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        fail(f"temporary output already exists: {temporary}")
    temporary.mkdir(parents=False)
    try:
        (temporary / "index.toml").write_bytes(remote_index)
        for record in archives:
            shutil.copyfile(
                args.archives_dir / record["name"], temporary / record["name"]
            )
        # WHY: generation.json is the seal. Publishers upload it last, after
        # every byte it transitively binds is already present and verified.
        write_json(temporary / "generation.json", manifest)
        os.replace(temporary, args.output_dir)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    print(tag)


def command_validate(args: argparse.Namespace) -> None:
    if not args.bundle.is_dir() or args.bundle.is_symlink():
        fail("generation bundle must be a regular directory")
    manifest_path = args.bundle / "generation.json"
    manifest_value = read_json(manifest_path, max_bytes=MAX_MANIFEST_BYTES)
    if manifest_path.read_bytes() != canonical_bytes(manifest_value):
        fail("generation.json is not canonical JSON")
    manifest, identity, tag = validate_manifest(manifest_value)
    if args.expected_tag is not None and tag != args.expected_tag:
        fail("generation tag differs from the exact requested tag")
    expected_names = {
        "generation.json",
        "index.toml",
        *(record["name"] for record in identity["archives"]),
    }
    actual_names = {entry.name for entry in args.bundle.iterdir()}
    if actual_names != expected_names:
        fail("generation bundle has a missing or unexpected asset")
    index_path = args.bundle / "index.toml"
    regular_file(index_path, "generation index")
    if (
        index_path.stat().st_size != manifest["index"]["bytes"]
        or sha256_file(index_path) != manifest["index"]["sha256"]
    ):
        fail("generation index differs from generation.json")
    release_prefix = (
        f"https://github.com/{identity['repository']}/releases/download/{tag}/"
    )
    archive_names = [record["name"] for record in identity["archives"]]
    localized = recover_localized_index(
        index_path.read_bytes(), archive_names, release_prefix
    )
    localized_identity = identity["localized_index"]
    if (
        len(localized) != localized_identity["bytes"]
        or sha256_bytes(localized) != localized_identity["sha256"]
    ):
        fail("generation index does not recover the content-bound local index")
    for record in identity["archives"]:
        archive = args.bundle / record["name"]
        regular_file(archive, "generation archive")
        if (
            archive.stat().st_size != record["bytes"]
            or sha256_file(archive) != record["sha256"]
        ):
            fail(f"generation archive differs from its identity: {record['name']}")
    if args.localized_index_out is not None:
        args.localized_index_out.write_bytes(localized)
    print(tag)


def command_compare_consumer(args: argparse.Namespace) -> None:
    manifest_value = read_json(
        args.generation_manifest, max_bytes=MAX_MANIFEST_BYTES
    )
    if args.generation_manifest.read_bytes() != canonical_bytes(manifest_value):
        fail("generation.json is not canonical JSON")
    _, identity, tag = validate_manifest(manifest_value)
    projection = identity["projection"]
    selected_projection, selected_expected = selection_from_files(
        args.program_packages,
        args.full_expected_ledger,
        projection["root_package"],
        projection["arch"],
        identity["abi_version"],
    )
    if selected_projection != projection:
        fail("consumer package projection differs from the generation source")
    if selected_expected != identity["expected_ledger"]:
        fail("consumer expected ledger differs from the generation source")
    print(tag)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)

    select = subcommands.add_parser("select")
    select.add_argument("--program-packages", type=Path, required=True)
    select.add_argument("--full-expected-ledger", type=Path, required=True)
    select.add_argument("--root-package", required=True)
    select.add_argument("--arch", required=True)
    select.add_argument("--expected-abi", type=int, required=True)
    select.add_argument("--projection-out", type=Path, required=True)
    select.add_argument("--expected-out", type=Path, required=True)
    select.set_defaults(action=command_select)

    prepare = subcommands.add_parser("prepare")
    prepare.add_argument("--repository", required=True)
    prepare.add_argument("--package-source-sha", required=True)
    prepare.add_argument("--source-tag", required=True)
    prepare.add_argument("--source-index", type=Path, required=True)
    prepare.add_argument("--projection", type=Path, required=True)
    prepare.add_argument("--expected-ledger", type=Path, required=True)
    prepare.add_argument("--snapshot", type=Path, required=True)
    prepare.add_argument("--localized-index", type=Path, required=True)
    prepare.add_argument("--archives-dir", type=Path, required=True)
    prepare.add_argument("--output-dir", type=Path, required=True)
    prepare.set_defaults(action=command_prepare)

    validate = subcommands.add_parser("validate")
    validate.add_argument("--bundle", type=Path, required=True)
    validate.add_argument("--expected-tag")
    validate.add_argument("--localized-index-out", type=Path)
    validate.set_defaults(action=command_validate)

    compare = subcommands.add_parser("compare-consumer")
    compare.add_argument("--generation-manifest", type=Path, required=True)
    compare.add_argument("--program-packages", type=Path, required=True)
    compare.add_argument("--full-expected-ledger", type=Path, required=True)
    compare.set_defaults(action=command_compare_consumer)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        args.action(args)
    except ContractError as error:
        print(f"package-generation: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
