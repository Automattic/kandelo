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
import tomllib
from pathlib import Path
from typing import Any


HEX_40 = re.compile(r"^[0-9a-f]{40}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
PACKAGE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ARCH = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ASSET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.zst$")
CANONICAL_BINARY_TAG = re.compile(r"^binaries-abi-v[1-9][0-9]*$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
IDENTITY_FORMAT = "kandelo-package-generation-identity-v1"
MANIFEST_FORMAT = "kandelo-package-generation-v1"
SINGLE_ROOT_PROJECTION_SCHEMA = 1
ROOT_SET_PROJECTION_SCHEMA = 2
BROWSER_INPUTS_ROOT_SET = "browser-inputs"
SOURCE_IDENTITY_ALGORITHM = "kandelo-program-packages-v2-manifest-closure-v1"
PROGRAM_ARCHIVE_DISPOSITION = "program-archive"
LIBRARY_ARCHIVE_DISPOSITION = "library-archive"
SOURCE_ONLY_DISPOSITION = "source-only"
MAIN_SOURCE_EVIDENCE_FORMAT = "kandelo-main-package-activation-v1"
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_ARCHIVES = 256
MAX_ROOTS_BYTES = 64 * 1024
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


def mapping_field(value: Any, key: str, context: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get(key), dict):
        fail(f"{context} must contain object field {key!r}")
    return value[key]


def validate_main_source_evidence(value: Any) -> dict[str, Any]:
    evidence = exact_keys(
        value,
        {
            "format",
            "repository",
            "tag",
            "release_id",
            "tag_sha",
            "default_ref",
            "package_source_sha",
            "tree_sha",
        },
        "main package activation evidence",
    )
    if evidence["format"] != MAIN_SOURCE_EVIDENCE_FORMAT:
        fail("main package activation evidence format is unsupported")
    if evidence["default_ref"] != "main":
        fail("main package activation evidence must name refs/heads/main")
    return {
        "format": MAIN_SOURCE_EVIDENCE_FORMAT,
        "repository": text_matching(
            evidence["repository"], REPOSITORY, "main activation repository"
        ),
        "tag": text_matching(
            evidence["tag"], CANONICAL_BINARY_TAG, "canonical binary tag"
        ),
        "release_id": integer(
            evidence["release_id"], "canonical binary release id", minimum=1
        ),
        "tag_sha": text_matching(
            evidence["tag_sha"], HEX_40, "canonical binary tag SHA"
        ),
        "default_ref": "main",
        "package_source_sha": text_matching(
            evidence["package_source_sha"], HEX_40, "main package source SHA"
        ),
        "tree_sha": text_matching(
            evidence["tree_sha"], HEX_40, "main package source tree SHA"
        ),
    }


def derive_main_source_evidence(
    *,
    repository: str,
    source_tag: str,
    default_ref: str,
    package_source_sha: str,
    release: Any,
    tag_ref: Any,
    default_ref_value: Any,
    source_commit: Any,
) -> dict[str, Any]:
    text_matching(repository, REPOSITORY, "repository")
    text_matching(source_tag, CANONICAL_BINARY_TAG, "canonical binary tag")
    if default_ref != "main":
        fail("durable generation source ref must be refs/heads/main")
    text_matching(package_source_sha, HEX_40, "main package source SHA")
    if (
        not isinstance(release, dict)
        or release.get("tag_name") != source_tag
        or release.get("draft") is not False
        or release.get("prerelease") is not False
    ):
        fail("canonical binary release identity is malformed")
    release_id = integer(
        release.get("id"), "canonical binary release id", minimum=1
    )
    tag_object = mapping_field(tag_ref, "object", "canonical binary tag")
    tag_sha = text_matching(
        tag_object.get("sha"), HEX_40, "canonical binary tag SHA"
    )
    if (
        not isinstance(tag_ref, dict)
        or tag_ref.get("ref") != f"refs/tags/{source_tag}"
        or tag_object.get("type") != "commit"
    ):
        fail("canonical binary tag is not a direct commit reference")
    default_object = mapping_field(
        default_ref_value, "object", "default branch reference"
    )
    if (
        not isinstance(default_ref_value, dict)
        or default_ref_value.get("ref") != f"refs/heads/{default_ref}"
        or default_object.get("type") != "commit"
        or default_object.get("sha") != package_source_sha
    ):
        fail("default branch does not point at the package source SHA")
    source_tree = mapping_field(source_commit, "tree", "main package source commit")
    if (
        not isinstance(source_commit, dict)
        or source_commit.get("sha") != package_source_sha
    ):
        fail("main package source commit metadata differs from the default ref")
    tree_sha = text_matching(
        source_tree.get("sha"), HEX_40, "main package source tree SHA"
    )
    return validate_main_source_evidence(
        {
            "format": MAIN_SOURCE_EVIDENCE_FORMAT,
            "repository": repository,
            "tag": source_tag,
            "release_id": release_id,
            "tag_sha": tag_sha,
            "default_ref": default_ref,
            "package_source_sha": package_source_sha,
            "tree_sha": tree_sha,
        }
    )


def validate_projection_entries(value: Any, arch: str) -> list[dict[str, str]]:
    entries = value
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
    return normalized


def validate_projection(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("package projection must be an object")
    schema = value.get("schema")
    if isinstance(schema, bool) or not isinstance(schema, int):
        fail("package projection schema must be an integer")
    if schema == SINGLE_ROOT_PROJECTION_SCHEMA:
        projection = exact_keys(
            value,
            {"schema", "root_package", "arch", "entries"},
            "package projection",
        )
        root = text_matching(projection["root_package"], PACKAGE, "projection root")
        arch = text_matching(projection["arch"], ARCH, "projection arch")
        normalized = validate_projection_entries(projection["entries"], arch)
        identities = {(entry["package"], entry["arch"]) for entry in normalized}
        if (root, arch) not in identities:
            fail("projection does not contain its root package")
        # WHY: schema 1 is retained verbatim so already published rootfs
        # generations keep the same canonical bytes, identity, and tag.
        return {
            "schema": SINGLE_ROOT_PROJECTION_SCHEMA,
            "root_package": root,
            "arch": arch,
            "entries": normalized,
        }
    if schema != ROOT_SET_PROJECTION_SCHEMA:
        fail("package projection schema is unsupported")
    projection = exact_keys(
        value,
        {
            "schema",
            "identity_algorithm",
            "root_set",
            "roots",
            "arch",
            "closure",
        },
        "package projection",
    )
    if projection["identity_algorithm"] != SOURCE_IDENTITY_ALGORITHM:
        fail("package projection source identity algorithm is unsupported")
    if projection["root_set"] != BROWSER_INPUTS_ROOT_SET:
        fail("package projection root set is unsupported")
    roots = projection["roots"]
    if not isinstance(roots, list) or len(roots) < 1 or len(roots) > MAX_ARCHIVES:
        fail(f"package projection must contain 1..{MAX_ARCHIVES} roots")
    normalized_roots = [
        text_matching(root, PACKAGE, f"projection root {index}")
        for index, root in enumerate(roots)
    ]
    if len(normalized_roots) != len(set(normalized_roots)):
        fail("package projection contains duplicate roots")
    if normalized_roots != sorted(normalized_roots):
        fail("package projection roots must be sorted")
    arch = text_matching(projection["arch"], ARCH, "projection arch")
    raw_closure = projection["closure"]
    if (
        not isinstance(raw_closure, list)
        or len(raw_closure) < 1
        or len(raw_closure) > MAX_ARCHIVES
    ):
        fail(f"package projection must contain 1..{MAX_ARCHIVES} closure identities")
    normalized_closure: list[dict[str, str]] = []
    for index, raw in enumerate(raw_closure):
        entry = exact_keys(
            raw,
            {
                "package",
                "arch",
                "kind",
                "disposition",
                "manifest_sha256",
                "cache_key_sha",
            },
            f"projection closure identity {index}",
        )
        package = text_matching(entry["package"], PACKAGE, "closure package")
        entry_arch = text_matching(entry["arch"], ARCH, "closure arch")
        if entry_arch != arch:
            fail("projection closure identities must use the selected architecture")
        kind = entry["kind"]
        disposition = entry["disposition"]
        expected_disposition = {
            "program": PROGRAM_ARCHIVE_DISPOSITION,
            "library": LIBRARY_ARCHIVE_DISPOSITION,
            "source": SOURCE_ONLY_DISPOSITION,
        }.get(kind)
        if disposition != expected_disposition:
            fail("projection closure kind and disposition disagree")
        normalized_closure.append(
            {
                "package": package,
                "arch": entry_arch,
                "kind": kind,
                "disposition": disposition,
                "manifest_sha256": text_matching(
                    entry["manifest_sha256"], HEX_64, "closure manifest digest"
                ),
                "cache_key_sha": text_matching(
                    entry["cache_key_sha"], HEX_64, "closure cache key"
                ),
            }
        )
    if normalized_closure != sorted(
        normalized_closure, key=lambda item: (item["package"], item["arch"])
    ):
        fail("projection closure identities must be sorted")
    identities = [
        (entry["package"], entry["arch"]) for entry in normalized_closure
    ]
    if len(identities) != len(set(identities)):
        fail("projection contains duplicate closure identities")
    closure_by_identity = {
        (entry["package"], entry["arch"]): entry for entry in normalized_closure
    }
    missing_roots = []
    for root in normalized_roots:
        entry = closure_by_identity.get((root, arch))
        if (
            entry is None
            or entry["kind"] != "program"
            or entry["disposition"] != PROGRAM_ARCHIVE_DISPOSITION
        ):
            missing_roots.append(root)
    if missing_roots:
        fail(f"projection does not contain its roots: {missing_roots}")
    return {
        "schema": ROOT_SET_PROJECTION_SCHEMA,
        "identity_algorithm": SOURCE_IDENTITY_ALGORITHM,
        "root_set": BROWSER_INPUTS_ROOT_SET,
        "roots": normalized_roots,
        "arch": arch,
        "closure": normalized_closure,
    }


def projection_entries(projection: dict[str, Any]) -> list[dict[str, str]]:
    if projection["schema"] == SINGLE_ROOT_PROJECTION_SCHEMA:
        return projection["entries"]
    return [
        {
            "package": entry["package"],
            "arch": entry["arch"],
            "manifest_sha256": entry["manifest_sha256"],
            "cache_key_sha": entry["cache_key_sha"],
        }
        for entry in projection["closure"]
        if entry["disposition"] != SOURCE_ONLY_DISPOSITION
    ]


def program_package_entries(
    program_packages: Any, root: str, arch: str
) -> list[dict[str, str]]:
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
    identities = [(entry["package"], entry["arch"]) for entry in entries]
    if len(identities) != len(set(identities)):
        fail(f"program package {root} contains a duplicate dependency identity")
    return entries


def select_projection(program_packages: Any, root: str, arch: str) -> dict[str, Any]:
    entries = program_package_entries(program_packages, root, arch)
    projection = {
        "schema": SINGLE_ROOT_PROJECTION_SCHEMA,
        "root_package": root,
        "arch": arch,
        "entries": sorted(entries, key=lambda item: (item["package"], item["arch"])),
    }
    return validate_projection(projection)


def read_roots(path: Path) -> list[str]:
    regular_file(path, "root set")
    if path.stat().st_size > MAX_ROOTS_BYTES:
        fail(f"root set exceeds the {MAX_ROOTS_BYTES}-byte input limit")
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8")
    except (OSError, UnicodeError) as error:
        fail(f"cannot read root set from {path}: {error}")
    roots = text.splitlines()
    canonical = "".join(f"{root}\n" for root in roots).encode("utf-8")
    if raw != canonical:
        fail("root set must be canonical newline-delimited UTF-8")
    if len(roots) < 1 or len(roots) > MAX_ARCHIVES:
        fail(f"root set must contain 1..{MAX_ARCHIVES} roots")
    normalized = [
        text_matching(root, PACKAGE, f"root set entry {index}")
        for index, root in enumerate(roots)
    ]
    if len(normalized) != len(set(normalized)):
        fail("root set contains duplicate roots")
    if normalized != sorted(normalized):
        fail("root set roots must be sorted")
    return normalized


def select_root_set_projection(
    program_packages: Any,
    full_expected: Any,
    registry_root: Path,
    root_set: str,
    roots: list[str],
    arch: str,
) -> dict[str, Any]:
    if root_set != BROWSER_INPUTS_ROOT_SET:
        fail("package projection root set is unsupported")
    entries_by_identity: dict[tuple[str, str], dict[str, str]] = {}
    for root in roots:
        for entry in program_package_entries(program_packages, root, arch):
            identity = (entry["package"], entry["arch"])
            previous = entries_by_identity.get(identity)
            if previous is not None and previous != entry:
                # WHY: shared dependencies are safe to deduplicate only when
                # every selected root names the exact same manifest/cache pair.
                fail(
                    "selected roots disagree on package identity for "
                    f"{entry['package']} {entry['arch']}"
                )
            entries_by_identity[identity] = entry
    identities = program_packages.get("identities")
    if not isinstance(identities, dict):
        fail("program-packages.json lacks authoritative package identities")
    if not isinstance(full_expected, dict) or not isinstance(
        full_expected.get("entries"), list
    ):
        fail("expected ledger entries must be an array")
    expected_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    selected_identities = set(entries_by_identity)
    for raw in full_expected["entries"]:
        if not isinstance(raw, dict):
            fail("expected ledger entries must be objects")
        identity = (raw.get("package"), raw.get("arch"))
        if identity not in selected_identities:
            continue
        if identity in expected_by_identity:
            fail("expected ledger contains a duplicate selected package")
        expected_by_identity[identity] = raw

    closure: list[dict[str, str]] = []
    for identity, entry in sorted(entries_by_identity.items()):
        package, entry_arch = identity
        contextual = identities.get(package)
        if not isinstance(contextual, dict):
            fail(f"program-packages.json lacks contextual identity for {package}")
        contextual_cache_keys = contextual.get("cacheKeys")
        if (
            contextual.get("manifestSha256") != entry["manifest_sha256"]
            or not isinstance(contextual_cache_keys, dict)
            or contextual_cache_keys.get(entry_arch) != entry["cache_key_sha"]
        ):
            fail(
                "program-packages.json contextual identity differs for "
                f"{package} {entry_arch}"
            )
        manifest_path = registry_root / package / "package.toml"
        regular_file(manifest_path, "selected package manifest")
        if manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            fail(f"selected package manifest exceeds the input limit: {manifest_path}")
        if sha256_file(manifest_path) != entry["manifest_sha256"]:
            fail(f"selected package manifest digest differs for {package}")
        try:
            manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
            fail(f"cannot read package metadata for {package}: {error}")
        if manifest.get("name") != package:
            fail(f"selected package metadata names another package: {package}")
        kind = manifest.get("kind")
        expected_entry = expected_by_identity.get(identity)
        if kind == "source":
            if expected_entry is not None:
                fail(f"source-only package unexpectedly has an archive: {package}")
            disposition = SOURCE_ONLY_DISPOSITION
        elif kind == "program":
            if expected_entry is None or expected_entry.get("kind") != kind:
                fail(
                    "materializable program is missing from the expected ledger: "
                    f"{package}"
                )
            disposition = PROGRAM_ARCHIVE_DISPOSITION
        elif kind == "library":
            if expected_entry is None or expected_entry.get("kind") != kind:
                fail(
                    "materializable library is missing from the expected ledger: "
                    f"{package}"
                )
            disposition = LIBRARY_ARCHIVE_DISPOSITION
        else:
            fail(f"selected package has unsupported kind: {package}")
        closure.append(
            {
                **entry,
                "kind": kind,
                "disposition": disposition,
            }
        )
    projection = {
        "schema": ROOT_SET_PROJECTION_SCHEMA,
        "identity_algorithm": SOURCE_IDENTITY_ALGORITHM,
        "root_set": root_set,
        "roots": roots,
        "arch": arch,
        # WHY: source-only dependency identities still affect program cache
        # provenance, but they cannot be invented as release assets. One typed
        # closure keeps them content-bound while making the archive subset
        # explicit and mechanically derivable.
        "closure": closure,
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
        for entry in projection_entries(projection)
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
    arch: str,
    abi_version: int,
    *,
    root: str | None = None,
    root_set: str | None = None,
    roots_path: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if (root is None) == (root_set is None):
        fail("exactly one root package or root set must be selected")
    program_packages = read_json(program_packages_path)
    full_expected = read_json(full_expected_path)
    if root is not None:
        if roots_path is not None:
            fail("a single-root selection must not provide a roots file")
        projection = select_projection(program_packages, root, arch)
    else:
        if roots_path is None:
            fail("a root-set selection requires a roots file")
        if root_set is None:
            fail("a root-set selection requires a root-set name")
        projection = select_root_set_projection(
            program_packages,
            full_expected,
            program_packages_path.parent,
            root_set,
            read_roots(roots_path),
            arch,
        )
    expected = select_expected(full_expected, projection, abi_version)
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
        for entry in projection_entries(projection)
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


def projection_label(projection: dict[str, Any]) -> str:
    if projection["schema"] == SINGLE_ROOT_PROJECTION_SCHEMA:
        return projection["root_package"]
    return projection["root_set"]


def source_activation_tag(identity: dict[str, Any]) -> str:
    return identity["source_activation"]["evidence"]["tag"]


def generation_tag(identity: dict[str, Any], digest: str) -> str:
    projection = identity["projection"]
    return (
        f"package-generation-{projection_label(projection)}-{projection['arch']}"
        f"-abi-v{identity['abi_version']}-sha256-{digest}"
    )


def release_fields(identity: dict[str, Any], tag: str) -> dict[str, Any]:
    projection = identity["projection"]
    title = (
        f"Package generation: {projection_label(projection)} {projection['arch']}, "
        f"ABI {identity['abi_version']}"
    )
    source_line = (
        "Activated main source: "
        f"`{identity['source_activation']['evidence']['package_source_sha']}`\n"
    )
    body = (
        "Durable Kandelo package generation.\n\n"
        f"Package source: `{identity['package_source_sha']}`\n"
        f"Activated package release: `{source_activation_tag(identity)}`\n"
        f"{source_line}"
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
    if not isinstance(value, dict) or not isinstance(value.get("projection"), dict):
        fail("generation identity must contain a package projection")
    identity_keys = {
        "format",
        "repository",
        "package_source_sha",
        "abi_version",
        "projection",
        "expected_ledger",
        "validated_snapshot",
        "source_activation",
        "localized_index",
        "archives",
    }
    identity_keys.add("authority_sha")
    identity = exact_keys(value, identity_keys, "generation identity")
    if identity["format"] != IDENTITY_FORMAT:
        fail("generation identity format is unsupported")
    text_matching(identity["repository"], REPOSITORY, "generation repository")
    text_matching(identity["package_source_sha"], HEX_40, "package source SHA")
    abi_version = integer(identity["abi_version"], "generation ABI", minimum=1)
    projection = validate_projection(identity["projection"])
    authority_sha = text_matching(
        identity["authority_sha"], HEX_40, "workflow authority SHA"
    )
    if authority_sha != identity["package_source_sha"]:
        fail("workflow authority SHA differs from the activated main source")
    expected = select_expected(identity["expected_ledger"], projection, abi_version)
    if expected != identity["expected_ledger"]:
        fail("generation expected ledger is not canonical")
    source = exact_keys(
        identity["source_activation"],
        {"evidence", "index_sha256", "index_bytes"},
        "source package release identity",
    )
    evidence = validate_main_source_evidence(source["evidence"])
    if (
        evidence != source["evidence"]
        or evidence["repository"] != identity["repository"]
        or evidence["package_source_sha"] != identity["package_source_sha"]
    ):
        fail("main activation evidence differs from the generation source")
    source_tag = evidence["tag"]
    text_matching(source["index_sha256"], HEX_64, "source index digest")
    integer(
        source["index_bytes"],
        "source index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    if source_tag != f"binaries-abi-v{abi_version}":
        fail("source package release tag differs from the generation ABI")
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
        source_tag,
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
        args.arch,
        args.expected_abi,
        root=args.root_package,
        root_set=args.root_set,
        roots_path=args.roots_file,
    )
    write_json(args.projection_out, projection)
    write_json(args.expected_out, expected)


def command_main_source_evidence(args: argparse.Namespace) -> None:
    evidence = derive_main_source_evidence(
        repository=args.repository,
        source_tag=args.source_tag,
        default_ref=args.default_ref,
        package_source_sha=args.package_source_sha,
        release=read_json(args.release, max_bytes=MAX_MANIFEST_BYTES),
        tag_ref=read_json(args.tag_ref, max_bytes=MAX_MANIFEST_BYTES),
        default_ref_value=read_json(
            args.default_ref_value, max_bytes=MAX_MANIFEST_BYTES
        ),
        source_commit=read_json(args.source_commit, max_bytes=MAX_MANIFEST_BYTES),
    )
    write_json(args.output, evidence)


def command_prepare(args: argparse.Namespace) -> None:
    repository = text_matching(args.repository, REPOSITORY, "repository")
    package_source_sha = text_matching(
        args.package_source_sha, HEX_40, "package source SHA"
    )
    source_tag = text_matching(
        args.source_tag, CANONICAL_BINARY_TAG, "canonical binary tag"
    )
    if args.output_dir.exists() or args.output_dir.is_symlink():
        fail(f"output already exists: {args.output_dir}")
    projection = validate_projection(read_json(args.projection))
    if args.source_evidence is None:
        fail("a durable generation requires main activation evidence")
    source_evidence = validate_main_source_evidence(read_json(args.source_evidence))
    if (
        source_evidence["repository"] != repository
        or source_evidence["tag"] != source_tag
        or source_evidence["package_source_sha"] != package_source_sha
    ):
        fail("main activation evidence does not bind the generation inputs")
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
    regular_file(args.source_index, "activated source index")
    regular_file(args.localized_index, "localized minimal index")
    if args.source_index.stat().st_size > MAX_INDEX_BYTES:
        fail("activated source index exceeds the public-input size limit")
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
    source_activation = {
        "evidence": source_evidence,
        "index_sha256": sha256_file(args.source_index),
        "index_bytes": args.source_index.stat().st_size,
    }
    identity = {
        "format": IDENTITY_FORMAT,
        "repository": repository,
        "package_source_sha": package_source_sha,
        "abi_version": abi_version,
        "projection": projection,
        "expected_ledger": expected,
        "validated_snapshot": snapshot,
        "source_activation": source_activation,
        "localized_index": {
            "sha256": sha256_bytes(localized_bytes),
            "bytes": len(localized_bytes),
        },
        "archives": archives,
    }
    identity["authority_sha"] = text_matching(
        args.authority_sha, HEX_40, "workflow authority SHA"
    )
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
    selected_projection = validate_projection(read_json(args.consumer_projection))
    selected_expected_raw = read_json(args.consumer_expected_ledger)
    selected_expected = select_expected(
        selected_expected_raw, selected_projection, identity["abi_version"]
    )
    if selected_expected != selected_expected_raw:
        fail("consumer expected ledger is not canonical")
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
    selector = select.add_mutually_exclusive_group(required=True)
    selector.add_argument("--root-package")
    selector.add_argument("--root-set")
    select.add_argument("--roots-file", type=Path)
    select.add_argument("--arch", required=True)
    select.add_argument("--expected-abi", type=int, required=True)
    select.add_argument("--projection-out", type=Path, required=True)
    select.add_argument("--expected-out", type=Path, required=True)
    select.set_defaults(action=command_select)

    main_source_evidence = subcommands.add_parser("main-source-evidence")
    main_source_evidence.add_argument("--repository", required=True)
    main_source_evidence.add_argument("--source-tag", required=True)
    main_source_evidence.add_argument("--default-ref", required=True)
    main_source_evidence.add_argument("--package-source-sha", required=True)
    main_source_evidence.add_argument("--release", type=Path, required=True)
    main_source_evidence.add_argument("--tag-ref", type=Path, required=True)
    main_source_evidence.add_argument(
        "--default-ref-value", type=Path, required=True
    )
    main_source_evidence.add_argument(
        "--source-commit", type=Path, required=True
    )
    main_source_evidence.add_argument("--output", type=Path, required=True)
    main_source_evidence.set_defaults(action=command_main_source_evidence)

    prepare = subcommands.add_parser("prepare")
    prepare.add_argument("--repository", required=True)
    prepare.add_argument("--package-source-sha", required=True)
    prepare.add_argument("--source-tag", required=True)
    prepare.add_argument("--authority-sha")
    prepare.add_argument("--source-index", type=Path, required=True)
    prepare.add_argument("--source-evidence", type=Path)
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
    compare.add_argument("--consumer-projection", type=Path, required=True)
    compare.add_argument("--consumer-expected-ledger", type=Path, required=True)
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
