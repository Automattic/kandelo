#!/usr/bin/env python3
"""Build and validate admitted or evidence-only package generations."""

from __future__ import annotations

import argparse
from collections import Counter
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
SUPPORTING_ASSET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CANONICAL_BINARY_TAG = re.compile(r"^binaries-abi-v[1-9][0-9]*$")
PR_STAGING_TAG = re.compile(r"^pr-[1-9][0-9]*-staging$")
STAGING_TAG = PR_STAGING_TAG
PRESERVED_TAG = re.compile(
    r"^preserved-package-generation-[a-z0-9][a-z0-9._-]*-"
    r"[a-z0-9][a-z0-9._-]*-abi-v[1-9][0-9]*-source-[0-9a-f]{40}-"
    r"sha256-[0-9a-f]{64}$"
)
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
IDENTITY_FORMAT = "kandelo-package-generation-identity-v1"
MANIFEST_FORMAT = "kandelo-package-generation-v1"
IDENTITY_FORMAT_V2 = "kandelo-package-generation-identity-v2"
MANIFEST_FORMAT_V2 = "kandelo-package-generation-v2"
PRESERVED_IDENTITY_FORMAT = "kandelo-preserved-pr-package-generation-identity-v1"
PRESERVED_MANIFEST_FORMAT = "kandelo-preserved-pr-package-generation-v1"
SOURCE_CAPTURE_FORMAT = "kandelo-preserved-pr-source-capture-v1"
PRESERVED_PRODUCER_EVIDENCE_FORMAT = (
    "kandelo-preserved-package-producer-release-v1"
)
SINGLE_ROOT_PROJECTION_SCHEMA = 1
ROOT_SET_PROJECTION_SCHEMA = 2
BROWSER_INPUTS_ROOT_SET = "browser-inputs"
SOURCE_IDENTITY_ALGORITHM = "kandelo-program-packages-v2-manifest-closure-v1"
PROGRAM_ARCHIVE_DISPOSITION = "program-archive"
LIBRARY_ARCHIVE_DISPOSITION = "library-archive"
SOURCE_ONLY_DISPOSITION = "source-only"
MAIN_SOURCE_EVIDENCE_FORMAT = "kandelo-main-package-activation-v1"
PRODUCER_RELEASE_EVIDENCE_FORMAT = "kandelo-package-producer-release-v1"
MAIN_VALIDATION_EVIDENCE_FORMAT = "kandelo-package-main-validation-v1"
IDENTICAL_GIT_TREE_METHOD = "identical-git-tree-v1"
IDENTICAL_PACKAGE_CACHE_PROJECTION_METHOD = (
    "identical-package-cache-projection-v1"
)
PACKAGE_CACHE_PROJECTION_EVIDENCE_FORMAT = (
    "kandelo-package-cache-projection-v1"
)
PACKAGE_CACHE_PROJECTION_POLICY = "selected-build-input-closure-v1"
SELECTED_BUILD_INPUT_CLOSURE_FORMAT = (
    "kandelo-selected-package-build-input-closure-v1"
)
# WHY: cache-projection validation is a deliberately one-shot bridge for the
# already-built #1097 staging closure. Binding both immutable inputs here keeps
# this narrower proof from silently becoming a general way to publish old
# package caches after unrelated future changes.
CACHE_PROJECTION_BRIDGE_PRODUCER_SHA = (
    "748c2609954d2809bbcbbcb642fa7d257fc0dbc6"
)
CACHE_PROJECTION_BRIDGE_SOURCE_TAG = "pr-1097-staging"
VALIDATION_METHODS = {
    IDENTICAL_GIT_TREE_METHOD,
    IDENTICAL_PACKAGE_CACHE_PROJECTION_METHOD,
}
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_ARCHIVES = 256
MAX_TREE_ENTRIES = 100_000
MAX_ROOTS_BYTES = 64 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024
MAX_SUPPORTING_ASSETS = 8
MAX_SUPPORTING_ASSET_BYTES = 256 * 1024 * 1024
MAX_ROOT_JOB_LOG_BYTES = 16 * 1024 * 1024
MAX_GITHUB_METADATA_BYTES = 32 * 1024 * 1024

# WHY: current authority computes the selected build-input closure for both
# trees, so unrelated host/runtime changes are irrelevant by construction.
# These two readers still define that compatibility decision; pinning their
# exact H→M transition prevents a later validator rewrite from reinterpreting
# the one-shot #1097 evidence.
#
# These validated-main blob IDs are provisional until this replay's exact tree
# is merged and read back from `main`. They already name the candidate bytes,
# so the final check should confirm them rather than substitute a commit-based
# approximation; any subsequent edit to either file requires new pins.
PACKAGE_CACHE_PROJECTION_PINNED_TRANSITIONS = {
    "tools/xtask/src/build_deps.rs": {
        "producer": "9c8930dd137fcb836756657c43288e76e55fce36",
        "validated_main": "d8a095c60ed3bb90831afc11ec586c21abd886ee",
    },
    "tools/xtask/src/staging_reuse.rs": {
        "producer": "66a19dfc1542ef4f33e6b2ca06e8a3b170959508",
        "validated_main": "76a582453e25c35258b98c63040b0d4478634dbb",
    },
}


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


def package_release_kind(tag: str) -> str:
    if CANONICAL_BINARY_TAG.fullmatch(tag) is not None:
        return "canonical"
    if PR_STAGING_TAG.fullmatch(tag) is not None:
        return "pr-staging"
    fail("package producer tag is neither canonical nor PR staging")


def validate_ordinary_producer_release_evidence(value: Any) -> dict[str, Any]:
    evidence = exact_keys(
        value,
        {
            "format",
            "repository",
            "tag",
            "release_id",
            "tag_sha",
            "producer_sha",
            "producer_tree_sha",
            "release_kind",
        },
        "package producer release evidence",
    )
    if evidence["format"] != PRODUCER_RELEASE_EVIDENCE_FORMAT:
        fail("package producer release evidence format is unsupported")
    tag = evidence["tag"]
    if not isinstance(tag, str):
        fail("package producer tag has an invalid value")
    release_kind = package_release_kind(tag)
    if evidence["release_kind"] != release_kind:
        fail("package producer release kind differs from its tag")
    producer_sha = text_matching(
        evidence["producer_sha"], HEX_40, "package producer SHA"
    )
    tag_sha = text_matching(
        evidence["tag_sha"], HEX_40, "package producer tag SHA"
    )
    return {
        "format": PRODUCER_RELEASE_EVIDENCE_FORMAT,
        "repository": text_matching(
            evidence["repository"], REPOSITORY, "package producer repository"
        ),
        "tag": tag,
        "release_id": integer(
            evidence["release_id"], "package producer release id", minimum=1
        ),
        "tag_sha": tag_sha,
        "producer_sha": producer_sha,
        "producer_tree_sha": text_matching(
            evidence["producer_tree_sha"], HEX_40, "package producer tree SHA"
        ),
        "release_kind": release_kind,
    }


def derive_producer_release_evidence(
    *,
    repository: str,
    source_tag: str,
    producer_sha: str,
    release: Any,
    tag_ref: Any,
    producer_commit: Any,
) -> dict[str, Any]:
    text_matching(repository, REPOSITORY, "repository")
    release_kind = package_release_kind(source_tag)
    text_matching(producer_sha, HEX_40, "package producer SHA")
    expected_prerelease = release_kind == "pr-staging"
    if (
        not isinstance(release, dict)
        or release.get("tag_name") != source_tag
        or release.get("draft") is not False
        or release.get("prerelease") is not expected_prerelease
    ):
        fail("package producer release identity is malformed")
    release_id = integer(
        release.get("id"), "package producer release id", minimum=1
    )
    tag_object = mapping_field(tag_ref, "object", "package producer tag")
    tag_sha = text_matching(
        tag_object.get("sha"), HEX_40, "package producer tag SHA"
    )
    if (
        not isinstance(tag_ref, dict)
        or tag_ref.get("ref") != f"refs/tags/{source_tag}"
        or tag_object.get("type") != "commit"
    ):
        fail("package producer release tag is not a direct commit reference")
    # WHY: a release tag is an asset locator, not proof of which checkout
    # produced each archive. Archive manifests establish the coherent producer
    # independently.
    if release.get("target_commitish") != tag_sha:
        fail("package producer release target differs from its direct tag")
    producer_tree = mapping_field(
        producer_commit, "tree", "package producer commit"
    )
    if (
        not isinstance(producer_commit, dict)
        or producer_commit.get("sha") != producer_sha
    ):
        fail("package producer commit metadata differs from the producer SHA")
    return validate_ordinary_producer_release_evidence(
        {
            "format": PRODUCER_RELEASE_EVIDENCE_FORMAT,
            "repository": repository,
            "tag": source_tag,
            "release_id": release_id,
            "tag_sha": tag_sha,
            "producer_sha": producer_sha,
            "producer_tree_sha": text_matching(
                producer_tree.get("sha"), HEX_40, "package producer tree SHA"
            ),
            "release_kind": release_kind,
        }
    )


def preserved_manifest_inventory(
    manifest: dict[str, Any],
    *,
    manifest_sha256: str,
    manifest_bytes: int,
) -> list[dict[str, Any]]:
    identity = manifest["identity"]
    return sorted(
        [
            {
                "name": "generation.json",
                "bytes": manifest_bytes,
                "sha256": manifest_sha256,
            },
            {
                "name": manifest["index"]["name"],
                "bytes": manifest["index"]["bytes"],
                "sha256": manifest["index"]["sha256"],
            },
            *[
                {
                    "name": record["name"],
                    "bytes": record["bytes"],
                    "sha256": record["sha256"],
                }
                for record in identity["archives"]
            ],
            *[
                {
                    "name": record["name"],
                    "bytes": record["bytes"],
                    "sha256": record["sha256"],
                }
                for record in identity["supporting_assets"]
            ],
        ],
        key=lambda record: record["name"],
    )


def validate_preserved_producer_release_evidence(
    value: Any,
) -> dict[str, Any]:
    evidence = exact_keys(
        value,
        {
            "format",
            "repository",
            "tag",
            "release_id",
            "tag_sha",
            "producer_sha",
            "producer_tree_sha",
            "release_kind",
            "manifest_sha256",
            "manifest_bytes",
            "preserved_manifest",
            "assets",
        },
        "preserved package producer evidence",
    )
    if evidence["format"] != PRESERVED_PRODUCER_EVIDENCE_FORMAT:
        fail("preserved package producer evidence format is unsupported")
    repository = text_matching(
        evidence["repository"], REPOSITORY, "preserved producer repository"
    )
    tag = text_matching(evidence["tag"], PRESERVED_TAG, "preserved producer tag")
    producer_sha = text_matching(
        evidence["producer_sha"], HEX_40, "preserved producer SHA"
    )
    tag_sha = text_matching(
        evidence["tag_sha"], HEX_40, "preserved producer tag SHA"
    )
    if tag_sha != producer_sha or evidence["release_kind"] != "preserved-evidence":
        fail("preserved producer tag must directly anchor its package source")
    manifest_sha256 = text_matching(
        evidence["manifest_sha256"], HEX_64, "preserved manifest digest"
    )
    manifest_bytes = integer(
        evidence["manifest_bytes"],
        "preserved manifest size",
        minimum=1,
        maximum=MAX_MANIFEST_BYTES,
    )
    manifest, identity, manifest_tag = validate_manifest(
        evidence["preserved_manifest"]
    )
    if (
        manifest["format"] != PRESERVED_MANIFEST_FORMAT
        or identity["format"] != PRESERVED_IDENTITY_FORMAT
        or identity["admission"] != "none"
        or identity["repository"] != repository
        or identity["package_source_sha"] != producer_sha
        or manifest_tag != tag
    ):
        fail("preserved manifest does not bind the producer release")
    manifest_body = canonical_bytes(manifest)
    if (
        len(manifest_body) != manifest_bytes
        or sha256_bytes(manifest_body) != manifest_sha256
    ):
        fail("preserved manifest bytes differ from producer evidence")

    assets = evidence["assets"]
    if not isinstance(assets, list):
        fail("preserved producer assets must be an array")
    normalized_assets: list[dict[str, Any]] = []
    for index, raw in enumerate(assets):
        record = exact_keys(
            raw,
            {"id", "name", "bytes", "sha256"},
            f"preserved producer asset {index}",
        )
        normalized_assets.append(
            {
                "id": integer(
                    record["id"], "preserved release asset ID", minimum=1
                ),
                "name": bounded_text(
                    record["name"], "preserved release asset name", maximum=256
                ),
                "bytes": integer(
                    record["bytes"],
                    "preserved release asset size",
                    minimum=1,
                    maximum=MAX_ARCHIVE_BYTES,
                ),
                "sha256": text_matching(
                    record["sha256"], HEX_64, "preserved release asset digest"
                ),
            }
        )
    if normalized_assets != sorted(
        normalized_assets, key=lambda record: record["name"]
    ):
        fail("preserved producer assets must be sorted")
    if len({record["id"] for record in normalized_assets}) != len(
        normalized_assets
    ):
        fail("preserved producer asset IDs must be unique")
    expected_inventory = preserved_manifest_inventory(
        manifest,
        manifest_sha256=manifest_sha256,
        manifest_bytes=manifest_bytes,
    )
    if [
        {
            "name": record["name"],
            "bytes": record["bytes"],
            "sha256": record["sha256"],
        }
        for record in normalized_assets
    ] != expected_inventory:
        fail("preserved producer release differs from its application seal")
    return {
        "format": PRESERVED_PRODUCER_EVIDENCE_FORMAT,
        "repository": repository,
        "tag": tag,
        "release_id": integer(
            evidence["release_id"], "preserved producer release ID", minimum=1
        ),
        "tag_sha": tag_sha,
        "producer_sha": producer_sha,
        "producer_tree_sha": text_matching(
            evidence["producer_tree_sha"], HEX_40, "preserved producer tree SHA"
        ),
        "release_kind": "preserved-evidence",
        "manifest_sha256": manifest_sha256,
        "manifest_bytes": manifest_bytes,
        "preserved_manifest": manifest,
        "assets": normalized_assets,
    }


def validate_producer_release_evidence(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("package producer evidence must be an object")
    if value.get("format") == PRODUCER_RELEASE_EVIDENCE_FORMAT:
        return validate_ordinary_producer_release_evidence(value)
    if value.get("format") == PRESERVED_PRODUCER_EVIDENCE_FORMAT:
        return validate_preserved_producer_release_evidence(value)
    fail("package producer release evidence format is unsupported")


def derive_preserved_producer_release_evidence(
    *,
    repository: str,
    source_tag: str,
    producer_sha: str,
    release: Any,
    tag_ref: Any,
    producer_commit: Any,
    preserved_manifest: Any,
    release_assets: Any,
) -> dict[str, Any]:
    repository = text_matching(repository, REPOSITORY, "repository")
    source_tag = text_matching(
        source_tag, PRESERVED_TAG, "preserved producer tag"
    )
    producer_sha = text_matching(
        producer_sha, HEX_40, "preserved package producer SHA"
    )
    manifest, identity, manifest_tag = validate_manifest(preserved_manifest)
    if (
        manifest["format"] != PRESERVED_MANIFEST_FORMAT
        or identity["admission"] != "none"
        or identity["repository"] != repository
        or identity["package_source_sha"] != producer_sha
        or manifest_tag != source_tag
    ):
        fail("preserved manifest differs from the requested producer")
    if (
        not isinstance(release, dict)
        or release.get("tag_name") != source_tag
        or release.get("target_commitish") != producer_sha
        or release.get("draft") is not False
        or release.get("prerelease") is not True
        or release.get("name") != manifest["release"]["title"]
        or release.get("body") != manifest["release"]["body"]
    ):
        fail("preserved producer release identity is malformed")
    release_id = integer(
        release.get("id"), "preserved producer release ID", minimum=1
    )
    tag_object = mapping_field(tag_ref, "object", "preserved producer tag")
    tag_sha = text_matching(
        tag_object.get("sha"), HEX_40, "preserved producer tag SHA"
    )
    if (
        not isinstance(tag_ref, dict)
        or tag_ref.get("ref") != f"refs/tags/{source_tag}"
        or tag_object.get("type") != "commit"
        or tag_sha != producer_sha
    ):
        fail("preserved producer tag does not directly anchor the package source")
    producer_tree = mapping_field(
        producer_commit, "tree", "preserved package producer commit"
    )
    if (
        not isinstance(producer_commit, dict)
        or producer_commit.get("sha") != producer_sha
    ):
        fail("preserved producer commit metadata differs from the producer SHA")

    manifest_body = canonical_bytes(manifest)
    manifest_sha256 = sha256_bytes(manifest_body)
    manifest_bytes = len(manifest_body)
    expected_inventory = preserved_manifest_inventory(
        manifest,
        manifest_sha256=manifest_sha256,
        manifest_bytes=manifest_bytes,
    )
    if not isinstance(release_assets, list):
        fail("preserved release assets must be an array")
    assets_by_name: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(release_assets):
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
            fail(f"preserved release asset {index} is malformed")
        name = raw["name"]
        if name in assets_by_name:
            fail(f"preserved release contains duplicate asset {name!r}")
        assets_by_name[name] = raw
    if set(assets_by_name) != {
        record["name"] for record in expected_inventory
    }:
        fail("preserved release asset names differ from its application seal")
    normalized_assets: list[dict[str, Any]] = []
    for wanted in expected_inventory:
        raw = assets_by_name[wanted["name"]]
        digest = raw.get("digest")
        if (
            raw.get("state") != "uploaded"
            or raw.get("size") != wanted["bytes"]
            or digest != f"sha256:{wanted['sha256']}"
        ):
            fail(
                "preserved release asset metadata differs from its application "
                f"seal: {wanted['name']}"
            )
        normalized_assets.append(
            {
                "id": integer(
                    raw.get("id"), "preserved release asset ID", minimum=1
                ),
                **wanted,
            }
        )
    return validate_preserved_producer_release_evidence(
        {
            "format": PRESERVED_PRODUCER_EVIDENCE_FORMAT,
            "repository": repository,
            "tag": source_tag,
            "release_id": release_id,
            "tag_sha": tag_sha,
            "producer_sha": producer_sha,
            "producer_tree_sha": text_matching(
                producer_tree.get("sha"), HEX_40, "preserved producer tree SHA"
            ),
            "release_kind": "preserved-evidence",
            "manifest_sha256": manifest_sha256,
            "manifest_bytes": manifest_bytes,
            "preserved_manifest": manifest,
            "assets": normalized_assets,
        }
    )


def validate_main_validation_evidence(value: Any) -> dict[str, Any]:
    evidence = exact_keys(
        value,
        {
            "format",
            "repository",
            "default_ref",
            "commit",
            "tree_sha",
            "abi_version",
            "abi_snapshot_sha256",
            "method",
        },
        "main package validation evidence",
    )
    if evidence["format"] != MAIN_VALIDATION_EVIDENCE_FORMAT:
        fail("main package validation evidence format is unsupported")
    if evidence["default_ref"] != "main":
        fail("main package validation evidence must name refs/heads/main")
    method = evidence["method"]
    if method not in VALIDATION_METHODS:
        fail("main package validation method is unsupported")
    return {
        "format": MAIN_VALIDATION_EVIDENCE_FORMAT,
        "repository": text_matching(
            evidence["repository"], REPOSITORY, "main validation repository"
        ),
        "default_ref": "main",
        "commit": text_matching(
            evidence["commit"], HEX_40, "validated main commit"
        ),
        "tree_sha": text_matching(
            evidence["tree_sha"], HEX_40, "validated main tree SHA"
        ),
        "abi_version": integer(
            evidence["abi_version"], "validated main ABI", minimum=1
        ),
        "abi_snapshot_sha256": text_matching(
            evidence["abi_snapshot_sha256"],
            HEX_64,
            "validated main ABI snapshot digest",
        ),
        "method": method,
    }


def derive_main_validation_evidence(
    *,
    repository: str,
    default_ref: str,
    validated_main_sha: str,
    abi_version: int,
    default_ref_value: Any,
    main_commit: Any,
    abi_snapshot_path: Path,
    method: str,
) -> dict[str, Any]:
    text_matching(repository, REPOSITORY, "repository")
    if default_ref != "main":
        fail("durable generation validation ref must be refs/heads/main")
    text_matching(validated_main_sha, HEX_40, "validated main commit")
    integer(abi_version, "validated main ABI", minimum=1)
    if method not in VALIDATION_METHODS:
        fail("main package validation method is unsupported")
    default_object = mapping_field(
        default_ref_value, "object", "default branch reference"
    )
    if (
        not isinstance(default_ref_value, dict)
        or default_ref_value.get("ref") != f"refs/heads/{default_ref}"
        or default_object.get("type") != "commit"
        or default_object.get("sha") != validated_main_sha
    ):
        fail("default branch does not point at the validated main commit")
    main_tree = mapping_field(main_commit, "tree", "validated main commit")
    if (
        not isinstance(main_commit, dict)
        or main_commit.get("sha") != validated_main_sha
    ):
        fail("validated main commit metadata differs from the default ref")
    snapshot = read_json(abi_snapshot_path, max_bytes=MAX_MANIFEST_BYTES)
    if (
        not isinstance(snapshot, dict)
        or snapshot.get("abi_version") != abi_version
    ):
        fail("validated main ABI snapshot differs from the selected ABI")
    return validate_main_validation_evidence(
        {
            "format": MAIN_VALIDATION_EVIDENCE_FORMAT,
            "repository": repository,
            "default_ref": default_ref,
            "commit": validated_main_sha,
            "tree_sha": text_matching(
                main_tree.get("sha"), HEX_40, "validated main tree SHA"
            ),
            "abi_version": abi_version,
            "abi_snapshot_sha256": sha256_file(abi_snapshot_path),
            "method": method,
        }
    )


def normalized_git_path(value: Any, context: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value.startswith("/")
        or "\\" in value
        or "\0" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        fail(f"{context} must be a normalized repository-relative path")
    return value


def validate_component_records(value: Any, context: str) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value or len(value) > 512:
        fail(f"{context} must contain 1..512 component records")
    records: list[dict[str, str]] = []
    for index, raw in enumerate(value):
        record = exact_keys(
            raw,
            {"label", "sha256"},
            f"{context} record {index}",
        )
        records.append(
            {
                "label": bounded_text(
                    record["label"],
                    f"{context} record {index} label",
                    maximum=1024,
                ),
                "sha256": text_matching(
                    record["sha256"],
                    HEX_64,
                    f"{context} record {index} digest",
                ),
            }
        )
    labels = [record["label"] for record in records]
    if len(labels) != len(set(labels)):
        fail(f"{context} contains duplicate labels")
    return records


def validate_selected_build_input_closure(value: Any) -> dict[str, Any]:
    closure = exact_keys(
        value,
        {
            "format",
            "abi_version",
            "arch",
            "global_toolchain_components",
            "fork_instrument",
            "packages",
        },
        "selected package build-input closure",
    )
    if closure["format"] != SELECTED_BUILD_INPUT_CLOSURE_FORMAT:
        fail("selected package build-input closure format is unsupported")
    abi_version = integer(
        closure["abi_version"], "selected build-input ABI", minimum=1
    )
    arch = text_matching(
        closure["arch"], ARCH, "selected build-input architecture"
    )
    global_components = validate_component_records(
        closure["global_toolchain_components"],
        "global toolchain components",
    )

    raw_packages = closure["packages"]
    if (
        not isinstance(raw_packages, list)
        or not raw_packages
        or len(raw_packages) > MAX_ARCHIVES
    ):
        fail(
            f"selected build-input closure must contain 1..{MAX_ARCHIVES} packages"
        )
    packages: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_packages):
        package = exact_keys(
            raw,
            {
                "package",
                "kind",
                "version",
                "revision",
                "manifest_sha256",
                "cache_key_sha",
                "build",
                "input_components",
                "direct_dependencies",
                "uses_fork_instrument",
            },
            f"selected build-input package {index}",
        )
        name = text_matching(
            package["package"], PACKAGE, f"selected build-input package {index} name"
        )
        kind = package["kind"]
        if kind not in {"library", "program"}:
            fail(f"selected build-input package {name!r} has unsupported kind")
        build = exact_keys(
            package["build"],
            {"script_path", "inputs", "git_inputs"},
            f"selected build-input package {name!r} build metadata",
        )
        script_path = normalized_git_path(
            build["script_path"],
            f"selected build-input package {name!r} script path",
        )
        raw_inputs = build["inputs"]
        if not isinstance(raw_inputs, list) or len(raw_inputs) > 512:
            fail(f"selected build-input package {name!r} has invalid input list")
        inputs = [
            normalized_git_path(
                item, f"selected build-input package {name!r} input {item!r}"
            )
            for item in raw_inputs
        ]
        if len(inputs) != len(set(inputs)):
            fail(f"selected build-input package {name!r} has duplicate inputs")
        raw_git_inputs = build["git_inputs"]
        if not isinstance(raw_git_inputs, list) or len(raw_git_inputs) > 64:
            fail(
                f"selected build-input package {name!r} has invalid Git input list"
            )
        git_inputs: list[dict[str, str]] = []
        for git_index, raw_git in enumerate(raw_git_inputs):
            git_input = exact_keys(
                raw_git,
                {"name", "repository", "commit"},
                f"selected build-input package {name!r} Git input {git_index}",
            )
            git_inputs.append(
                {
                    "name": text_matching(
                        git_input["name"],
                        PACKAGE,
                        f"selected build-input package {name!r} Git input name",
                    ),
                    "repository": bounded_text(
                        git_input["repository"],
                        f"selected build-input package {name!r} Git repository",
                        maximum=512,
                    ),
                    "commit": text_matching(
                        git_input["commit"],
                        HEX_40,
                        f"selected build-input package {name!r} Git commit",
                    ),
                }
            )
        if len({item["name"] for item in git_inputs}) != len(git_inputs):
            fail(f"selected build-input package {name!r} has duplicate Git inputs")

        raw_dependencies = package["direct_dependencies"]
        if not isinstance(raw_dependencies, list) or len(raw_dependencies) > MAX_ARCHIVES:
            fail(
                f"selected build-input package {name!r} has invalid dependency list"
            )
        dependencies: list[dict[str, str]] = []
        for dependency_index, raw_dependency in enumerate(raw_dependencies):
            dependency = exact_keys(
                raw_dependency,
                {"package", "version", "cache_key_sha"},
                f"selected build-input package {name!r} dependency {dependency_index}",
            )
            dependencies.append(
                {
                    "package": text_matching(
                        dependency["package"],
                        PACKAGE,
                        f"selected build-input package {name!r} dependency name",
                    ),
                    "version": bounded_text(
                        dependency["version"],
                        f"selected build-input package {name!r} dependency version",
                        maximum=256,
                    ),
                    "cache_key_sha": text_matching(
                        dependency["cache_key_sha"],
                        HEX_64,
                        f"selected build-input package {name!r} dependency cache key",
                    ),
                }
            )
        if dependencies != sorted(
            dependencies, key=lambda dependency: dependency["package"]
        ) or len({item["package"] for item in dependencies}) != len(dependencies):
            fail(
                f"selected build-input package {name!r} dependencies are not canonical"
            )
        uses_fork = package["uses_fork_instrument"]
        if not isinstance(uses_fork, bool):
            fail(
                f"selected build-input package {name!r} fork policy must be boolean"
            )
        packages.append(
            {
                "package": name,
                "kind": kind,
                "version": bounded_text(
                    package["version"],
                    f"selected build-input package {name!r} version",
                    maximum=256,
                ),
                "revision": integer(
                    package["revision"],
                    f"selected build-input package {name!r} revision",
                    minimum=1,
                ),
                "manifest_sha256": text_matching(
                    package["manifest_sha256"],
                    HEX_64,
                    f"selected build-input package {name!r} manifest digest",
                ),
                "cache_key_sha": text_matching(
                    package["cache_key_sha"],
                    HEX_64,
                    f"selected build-input package {name!r} cache key",
                ),
                "build": {
                    "script_path": script_path,
                    "inputs": inputs,
                    "git_inputs": git_inputs,
                },
                "input_components": validate_component_records(
                    package["input_components"],
                    f"selected build-input package {name!r} components",
                ),
                "direct_dependencies": dependencies,
                "uses_fork_instrument": uses_fork,
            }
        )
    if packages != sorted(packages, key=lambda package: package["package"]):
        fail("selected build-input packages must be sorted")
    names = [package["package"] for package in packages]
    if len(names) != len(set(names)):
        fail("selected build-input closure contains duplicate packages")
    fork = exact_keys(
        closure["fork_instrument"],
        {"users", "components"},
        "selected fork-instrument closure",
    )
    raw_users = fork["users"]
    if not isinstance(raw_users, list) or len(raw_users) > MAX_ARCHIVES:
        fail("selected fork-instrument users must be an array")
    users = [
        text_matching(user, PACKAGE, "selected fork-instrument user")
        for user in raw_users
    ]
    expected_users = [
        package["package"] for package in packages if package["uses_fork_instrument"]
    ]
    if users != expected_users:
        fail("selected fork-instrument users differ from package policies")
    if users:
        fork_components = validate_component_records(
            fork["components"], "fork-instrument components"
        )
    elif fork["components"] == []:
        fork_components = []
    else:
        fail("unused fork-instrument closure must have no components")
    return {
        "format": SELECTED_BUILD_INPUT_CLOSURE_FORMAT,
        "abi_version": abi_version,
        "arch": arch,
        "global_toolchain_components": global_components,
        "fork_instrument": {
            "users": users,
            "components": fork_components,
        },
        "packages": packages,
    }


def validate_git_leaf_identity(value: Any, context: str) -> dict[str, str]:
    entry = exact_keys(value, {"mode", "type", "sha"}, context)
    entry_type = entry["type"]
    allowed_modes = {
        "blob": {"100644", "100755", "120000"},
        "commit": {"160000"},
    }
    if entry_type not in allowed_modes or entry["mode"] not in allowed_modes[entry_type]:
        fail(f"{context} has an unsupported Git type or mode")
    return {
        "mode": entry["mode"],
        "type": entry_type,
        "sha": text_matching(entry["sha"], HEX_40, f"{context} object SHA"),
    }


def validate_recursive_git_tree(
    value: Any, *, expected_tree_sha: str, context: str
) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        fail(f"{context} must be a GitHub recursive tree object")
    if value.get("sha") != expected_tree_sha:
        fail(f"{context} does not identify the expected Git tree")
    if value.get("truncated") is not False:
        fail(f"{context} must be a complete, non-truncated recursive Git tree")
    entries = value.get("tree")
    if (
        not isinstance(entries, list)
        or len(entries) > MAX_TREE_ENTRIES
    ):
        fail(f"{context} contains too many Git tree entries")
    leaves: dict[str, dict[str, str]] = {}
    seen: set[str] = set()
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            fail(f"{context} entry {index} must be an object")
        path = normalized_git_path(raw.get("path"), f"{context} entry {index} path")
        if path in seen:
            fail(f"{context} contains duplicate Git path {path!r}")
        seen.add(path)
        entry_type = raw.get("type")
        mode = raw.get("mode")
        sha = text_matching(
            raw.get("sha"), HEX_40, f"{context} entry {index} object SHA"
        )
        if entry_type == "tree":
            if mode != "040000":
                fail(f"{context} entry {index} has an invalid tree mode")
            continue
        leaves[path] = validate_git_leaf_identity(
            {"mode": mode, "type": entry_type, "sha": sha},
            f"{context} entry {index}",
        )
    return leaves


def validate_cache_projection_evidence(value: Any) -> dict[str, Any]:
    evidence = exact_keys(
        value,
        {
            "format",
            "policy",
            "producer",
            "validated_main",
            "projection_sha256",
            "expected_ledger_sha256",
            "selected_build_inputs",
            "selected_build_inputs_sha256",
            "validator_transitions",
        },
        "package cache projection evidence",
    )
    if evidence["format"] != PACKAGE_CACHE_PROJECTION_EVIDENCE_FORMAT:
        fail("package cache projection evidence format is unsupported")
    if evidence["policy"] != PACKAGE_CACHE_PROJECTION_POLICY:
        fail("package cache projection evidence policy is unsupported")
    producer = exact_keys(
        evidence["producer"],
        {"commit", "tree_sha"},
        "cache projection producer",
    )
    validated_main = exact_keys(
        evidence["validated_main"],
        {"commit", "tree_sha"},
        "cache projection validated main",
    )
    normalized_producer = {
        "commit": text_matching(
            producer["commit"], HEX_40, "cache projection producer commit"
        ),
        "tree_sha": text_matching(
            producer["tree_sha"], HEX_40, "cache projection producer tree"
        ),
    }
    normalized_main = {
        "commit": text_matching(
            validated_main["commit"],
            HEX_40,
            "cache projection validated main commit",
        ),
        "tree_sha": text_matching(
            validated_main["tree_sha"],
            HEX_40,
            "cache projection validated main tree",
        ),
    }
    if normalized_producer["tree_sha"] == normalized_main["tree_sha"]:
        fail("cache projection compatibility requires distinct Git trees")

    selected_build_inputs = validate_selected_build_input_closure(
        evidence["selected_build_inputs"]
    )
    selected_build_inputs_sha256 = text_matching(
        evidence["selected_build_inputs_sha256"],
        HEX_64,
        "selected package build-input closure digest",
    )
    if selected_build_inputs_sha256 != sha256_bytes(
        canonical_bytes(selected_build_inputs)
    ):
        fail("selected package build-input closure digest is invalid")

    transitions = evidence["validator_transitions"]
    if not isinstance(transitions, list):
        fail("cache projection validator transitions must be an array")
    normalized_transitions: list[dict[str, Any]] = []
    for index, raw in enumerate(transitions):
        transition = exact_keys(
            raw,
            {"path", "producer", "validated_main"},
            f"cache projection validator transition {index}",
        )
        path = normalized_git_path(
            transition["path"],
            f"cache projection validator transition {index} path",
        )
        producer_leaf = validate_git_leaf_identity(
            transition["producer"],
            f"cache projection validator transition {index} producer",
        )
        main_leaf = validate_git_leaf_identity(
            transition["validated_main"],
            f"cache projection validator transition {index} validated main",
        )
        pinned = PACKAGE_CACHE_PROJECTION_PINNED_TRANSITIONS.get(path)
        if (
            pinned is None
            or producer_leaf
            != {"mode": "100644", "type": "blob", "sha": pinned["producer"]}
            or main_leaf
            != {
                "mode": "100644",
                "type": "blob",
                "sha": pinned["validated_main"],
            }
        ):
            fail(
                "cache projection compatibility requires the exact reviewed "
                f"validator transition for {path!r}"
            )
        normalized_transitions.append(
            {
                "path": path,
                "producer": producer_leaf,
                "validated_main": main_leaf,
            }
        )
    expected_paths = sorted(PACKAGE_CACHE_PROJECTION_PINNED_TRANSITIONS)
    if [transition["path"] for transition in normalized_transitions] != expected_paths:
        fail("cache projection evidence lacks the exact validator transitions")
    return {
        "format": PACKAGE_CACHE_PROJECTION_EVIDENCE_FORMAT,
        "policy": PACKAGE_CACHE_PROJECTION_POLICY,
        "producer": normalized_producer,
        "validated_main": normalized_main,
        "projection_sha256": text_matching(
            evidence["projection_sha256"],
            HEX_64,
            "cache projection digest",
        ),
        "expected_ledger_sha256": text_matching(
            evidence["expected_ledger_sha256"],
            HEX_64,
            "cache projection expected-ledger digest",
        ),
        "selected_build_inputs": selected_build_inputs,
        "selected_build_inputs_sha256": selected_build_inputs_sha256,
        "validator_transitions": normalized_transitions,
    }


def canonical_projection_and_expected(
    projection_path: Path, expected_path: Path, context: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    projection_raw = read_json(projection_path, max_bytes=MAX_MANIFEST_BYTES)
    projection = validate_projection(projection_raw)
    if projection != projection_raw:
        fail(f"{context} projection is not canonical")
    expected_raw = read_json(expected_path, max_bytes=MAX_MANIFEST_BYTES)
    if not isinstance(expected_raw, dict):
        fail(f"{context} expected ledger must be an object")
    abi_version = integer(
        expected_raw.get("abi_version"), f"{context} expected ABI", minimum=1
    )
    expected = select_expected(expected_raw, projection, abi_version)
    if expected != expected_raw:
        fail(f"{context} expected ledger is not canonical")
    return projection, expected


def validate_build_inputs_against_selection(
    closure: dict[str, Any],
    projection: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    if (
        closure["abi_version"] != expected["abi_version"]
        or closure["arch"] != projection["arch"]
    ):
        fail("selected build-input closure differs from the selected ABI or arch")
    # WHY: `projection_entries()` intentionally returns only materializable
    # records for archive selection. Compatibility evidence must additionally
    # see schema-2 source-only records so a recipe cannot change one of those
    # direct dependency identities without invalidating the proof.
    selected_projection_entries = (
        projection["entries"]
        if projection["schema"] == SINGLE_ROOT_PROJECTION_SCHEMA
        else projection["closure"]
    )
    projection_by_package = {
        entry["package"]: entry for entry in selected_projection_entries
    }
    expected_by_package = {
        entry["package"]: entry for entry in expected["entries"]
    }
    closure_by_package = {
        package["package"]: package for package in closure["packages"]
    }
    # WHY: a schema-2 root set binds source-only identities in its projection,
    # but those entries do not have archives or executable build scripts. The
    # component ledger covers exactly the materializable expected entries;
    # producer/main projection equality still binds every source-only manifest
    # and cache identity.
    materializable_projection = {
        name: entry
        for name, entry in projection_by_package.items()
        if entry.get("disposition") != SOURCE_ONLY_DISPOSITION
    }
    if (
        set(closure_by_package) != set(materializable_projection)
        or set(closure_by_package) != set(expected_by_package)
    ):
        fail("selected build-input closure differs from the package selection")
    for name, package in closure_by_package.items():
        projected = projection_by_package[name]
        wanted = expected_by_package[name]
        if (
            package["manifest_sha256"] != projected["manifest_sha256"]
            or package["cache_key_sha"] != projected["cache_key_sha"]
            or package["cache_key_sha"] != wanted["cache_key_sha"]
            or package["kind"] != wanted["kind"]
            or package["version"] != wanted["version"]
            or package["revision"] != wanted["revision"]
            or package["build"]["git_inputs"] != wanted["git_inputs"]
        ):
            fail(
                f"selected build-input package {name!r} differs from its projection"
            )
        if package["build"]["script_path"] not in package["build"]["inputs"]:
            fail(
                f"selected build-input package {name!r} does not declare its build script"
            )
        expected_component_labels = [
            *package["build"]["inputs"],
            *[
                f"git-input:{index}:{git_input['name']}"
                for index, git_input in enumerate(package["build"]["git_inputs"])
            ],
        ]
        if [
            component["label"] for component in package["input_components"]
        ] != expected_component_labels:
            fail(
                f"selected build-input package {name!r} component labels are incomplete"
            )
        for dependency in package["direct_dependencies"]:
            dependency_name = dependency["package"]
            selected_dependency = projection_by_package.get(dependency_name)
            if (
                selected_dependency is None
                or dependency["cache_key_sha"]
                != selected_dependency["cache_key_sha"]
            ):
                fail(
                    f"selected build-input package {name!r} dependency cache key differs"
                )
            if (
                selected_dependency.get("disposition")
                != SOURCE_ONLY_DISPOSITION
                and dependency_name not in closure_by_package
            ):
                fail(
                    "selected build-input closure omits materializable dependency "
                    f"{dependency_name!r} of {name!r}"
                )


def derive_cache_projection_evidence(
    *,
    producer_sha: str,
    producer_tree_sha: str,
    validated_main_sha: str,
    validated_main_tree_sha: str,
    producer_projection_path: Path,
    producer_expected_path: Path,
    main_projection_path: Path,
    main_expected_path: Path,
    producer_components_path: Path,
    main_components_path: Path,
    producer_tree_value: Any,
    main_tree_value: Any,
) -> dict[str, Any]:
    producer_sha = text_matching(
        producer_sha, HEX_40, "cache projection producer commit"
    )
    producer_tree_sha = text_matching(
        producer_tree_sha, HEX_40, "cache projection producer tree"
    )
    validated_main_sha = text_matching(
        validated_main_sha, HEX_40, "cache projection validated main commit"
    )
    validated_main_tree_sha = text_matching(
        validated_main_tree_sha,
        HEX_40,
        "cache projection validated main tree",
    )
    if producer_tree_sha == validated_main_tree_sha:
        fail("cache projection compatibility requires distinct Git trees")
    producer_projection, producer_expected = canonical_projection_and_expected(
        producer_projection_path, producer_expected_path, "producer"
    )
    main_projection, main_expected = canonical_projection_and_expected(
        main_projection_path, main_expected_path, "validated main"
    )
    if producer_projection != main_projection:
        fail("producer and validated main package projections differ")
    if producer_expected != main_expected:
        fail("producer and validated main expected ledgers differ")
    producer_components_raw = read_json(
        producer_components_path, max_bytes=MAX_MANIFEST_BYTES
    )
    producer_components = validate_selected_build_input_closure(
        producer_components_raw
    )
    if producer_components != producer_components_raw:
        fail("producer selected build-input closure is not canonical")
    main_components_raw = read_json(
        main_components_path, max_bytes=MAX_MANIFEST_BYTES
    )
    main_components = validate_selected_build_input_closure(main_components_raw)
    if main_components != main_components_raw:
        fail("validated-main selected build-input closure is not canonical")
    validate_build_inputs_against_selection(
        producer_components, producer_projection, producer_expected
    )
    validate_build_inputs_against_selection(
        main_components, main_projection, main_expected
    )
    if producer_components != main_components:
        fail("producer and validated main selected build-input closures differ")

    producer_leaves = validate_recursive_git_tree(
        producer_tree_value,
        expected_tree_sha=producer_tree_sha,
        context="producer recursive Git tree",
    )
    main_leaves = validate_recursive_git_tree(
        main_tree_value,
        expected_tree_sha=validated_main_tree_sha,
        context="validated-main recursive Git tree",
    )
    validator_transitions = []
    for path in sorted(PACKAGE_CACHE_PROJECTION_PINNED_TRANSITIONS):
        producer_leaf = producer_leaves.get(path)
        main_leaf = main_leaves.get(path)
        if producer_leaf is None or main_leaf is None:
            fail(f"cache projection validator path is absent: {path!r}")
        validator_transitions.append(
            {
                "path": path,
                "producer": producer_leaf,
                "validated_main": main_leaf,
            }
        )
    evidence = {
        "format": PACKAGE_CACHE_PROJECTION_EVIDENCE_FORMAT,
        "policy": PACKAGE_CACHE_PROJECTION_POLICY,
        "producer": {
            "commit": producer_sha,
            "tree_sha": producer_tree_sha,
        },
        "validated_main": {
            "commit": validated_main_sha,
            "tree_sha": validated_main_tree_sha,
        },
        "projection_sha256": sha256_bytes(canonical_bytes(main_projection)),
        "expected_ledger_sha256": sha256_bytes(canonical_bytes(main_expected)),
        "selected_build_inputs": main_components,
        "selected_build_inputs_sha256": sha256_bytes(
            canonical_bytes(main_components)
        ),
        "validator_transitions": validator_transitions,
    }
    return validate_cache_projection_evidence(evidence)


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


def validate_preserved_projection(value: Any) -> dict[str, Any]:
    projection = validate_projection(value)
    # WHY: preserved evidence is intentionally limited to one audited root
    # closure. A schema-2 root set has no single root_package and must fail as a
    # contract violation, not later through an incidental dictionary lookup.
    if projection["schema"] != SINGLE_ROOT_PROJECTION_SCHEMA:
        fail("preserved PR package generations require a schema-1 projection")
    return projection


def require_preservable_projection(projection: dict[str, Any]) -> dict[str, Any]:
    # Exact-tree admission also accepts only the already audited single-root
    # preserved closure. Keep one schema check for both entry points.
    return validate_preserved_projection(projection)


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


def bounded_text(value: Any, context: str, *, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        fail(
            f"{context} must be a non-empty string no longer than "
            f"{maximum} characters"
        )
    return value


def expected_archive_name(entry: dict[str, Any], abi_version: int) -> str:
    name = (
        f"{entry['package']}-{entry['version']}-rev{entry['revision']}"
        f"-abi{abi_version}-{entry['arch']}-{entry['cache_key_sha'][:8]}.tar.zst"
    )
    return text_matching(name, ASSET, "selected release archive name")


def selected_snapshot_from_release(
    expected: dict[str, Any],
    source_tag: str,
    release_assets: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(release_assets, list):
        fail("source release assets must be an array")
    assets_by_name: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(release_assets):
        if not isinstance(raw, dict):
            fail(f"source release asset {index} must be an object")
        name = raw.get("name")
        if not isinstance(name, str):
            fail(f"source release asset {index} lacks a name")
        if name in assets_by_name:
            fail(f"source release contains duplicate asset name {name!r}")
        assets_by_name[name] = raw

    selected_assets: list[dict[str, Any]] = []
    snapshot_entries: list[dict[str, Any]] = []
    abi_version = expected["abi_version"]
    for entry in expected["entries"]:
        name = expected_archive_name(entry, abi_version)
        raw = assets_by_name.get(name)
        if raw is None:
            fail(f"source release lacks selected archive {name}")
        asset_id = integer(raw.get("id"), f"{name} release asset ID", minimum=1)
        if raw.get("state") != "uploaded":
            fail(f"source release archive is not uploaded: {name}")
        size = integer(
            raw.get("size"),
            f"{name} release asset size",
            minimum=1,
            maximum=MAX_ARCHIVE_BYTES,
        )
        digest = raw.get("digest")
        if not isinstance(digest, str) or not digest.startswith("sha256:"):
            fail(f"source release archive lacks a SHA-256 digest: {name}")
        sha256 = text_matching(
            digest.removeprefix("sha256:"),
            HEX_64,
            f"{name} release asset digest",
        )
        selected_assets.append(
            {"id": asset_id, "name": name, "bytes": size, "sha256": sha256}
        )
        snapshot_entries.append(
            {
                "package": entry["package"],
                "kind": entry["kind"],
                "arch": entry["arch"],
                "version": entry["version"],
                "revision": entry["revision"],
                "cache_key_sha": entry["cache_key_sha"],
                "current": True,
                "asset": name,
                "archive_sha256": sha256,
                "size": size,
            }
        )
    selected_assets.sort(key=lambda item: item["name"])
    snapshot_entries.sort(key=lambda item: (item["package"], item["arch"]))
    snapshot = {
        "abi_version": abi_version,
        "release_tag": source_tag,
        "complete_current": True,
        "entries": snapshot_entries,
    }
    return snapshot, selected_assets


def validate_supporting_assets(value: Any) -> list[dict[str, Any]]:
    if (
        not isinstance(value, list)
        or len(value) < 1
        or len(value) > MAX_SUPPORTING_ASSETS
    ):
        fail(
            f"preserved generation must contain 1..{MAX_SUPPORTING_ASSETS} "
            "supporting assets"
        )
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        record = exact_keys(
            raw,
            {"name", "sha256", "bytes"},
            f"supporting asset {index}",
        )
        normalized.append(
            {
                "name": text_matching(
                    record["name"], SUPPORTING_ASSET, "supporting asset name"
                ),
                "sha256": text_matching(
                    record["sha256"], HEX_64, "supporting asset digest"
                ),
                "bytes": integer(
                    record["bytes"],
                    "supporting asset size",
                    minimum=1,
                    maximum=MAX_SUPPORTING_ASSET_BYTES,
                ),
            }
        )
    if normalized != sorted(normalized, key=lambda item: item["name"]):
        fail("supporting assets must be sorted")
    names = [item["name"] for item in normalized]
    if len(names) != len(set(names)) or any(
        name in {"generation.json", "index.toml"} or ASSET.fullmatch(name)
        for name in names
    ):
        fail("supporting asset names must be unique and not reserved")
    return normalized


def validate_source_capture(
    value: Any,
    *,
    repository: str,
    package_source_sha: str,
    source_tag: str,
    archives: list[dict[str, Any]],
    projection: dict[str, Any],
) -> dict[str, Any]:
    capture = exact_keys(
        value,
        {
            "format",
            "repository",
            "package_source_sha",
            "source_staging",
            "source_run",
        },
        "preserved source capture",
    )
    if capture["format"] != SOURCE_CAPTURE_FORMAT:
        fail("preserved source capture format is unsupported")
    if (
        capture["repository"] != repository
        or capture["package_source_sha"] != package_source_sha
    ):
        fail("preserved source capture belongs to another repository or source SHA")

    staging = exact_keys(
        capture["source_staging"],
        {
            "tag",
            "release_id",
            "observed_target_commitish",
            "observed_tag_object_sha",
            "selected_assets",
        },
        "preserved source staging identity",
    )
    if staging["tag"] != source_tag:
        fail("preserved source capture belongs to another staging tag")
    integer(staging["release_id"], "source staging release ID", minimum=1)
    bounded_text(
        staging["observed_target_commitish"],
        "observed source staging target",
        maximum=256,
    )
    text_matching(
        staging["observed_tag_object_sha"],
        HEX_40,
        "observed source staging tag object",
    )
    selected_assets = staging["selected_assets"]
    if not isinstance(selected_assets, list):
        fail("source staging selected assets must be an array")
    normalized_assets: list[dict[str, Any]] = []
    for index, raw in enumerate(selected_assets):
        record = exact_keys(
            raw,
            {"id", "name", "bytes", "sha256"},
            f"source staging selected asset {index}",
        )
        normalized_assets.append(
            {
                "id": integer(record["id"], "source release asset ID", minimum=1),
                "name": text_matching(
                    record["name"], ASSET, "source release asset name"
                ),
                "bytes": integer(
                    record["bytes"],
                    "source release asset size",
                    minimum=1,
                    maximum=MAX_ARCHIVE_BYTES,
                ),
                "sha256": text_matching(
                    record["sha256"], HEX_64, "source release asset digest"
                ),
            }
        )
    expected_archive_records = [
        {"name": item["name"], "bytes": item["bytes"], "sha256": item["sha256"]}
        for item in archives
    ]
    if [
        {"name": item["name"], "bytes": item["bytes"], "sha256": item["sha256"]}
        for item in normalized_assets
    ] != expected_archive_records:
        fail("source release selected assets differ from the preserved archives")
    if normalized_assets != sorted(normalized_assets, key=lambda item: item["name"]):
        fail("source release selected assets must be sorted")
    if len({item["id"] for item in normalized_assets}) != len(normalized_assets):
        fail("source release selected asset IDs must be unique")

    source_run = exact_keys(
        capture["source_run"],
        {
            "id",
            "attempt",
            "event",
            "workflow_path",
            "head_sha",
            "root_job",
            "selected_artifacts",
        },
        "preserved source run identity",
    )
    integer(source_run["id"], "source run ID", minimum=1)
    integer(source_run["attempt"], "source run attempt", minimum=1)
    if bounded_text(source_run["event"], "source run event", maximum=64) != (
        "pull_request"
    ):
        fail("preserved source run event must be pull_request")
    if source_run["workflow_path"] != ".github/workflows/staging-build.yml":
        fail("source run does not use staging-build.yml")
    if source_run["head_sha"] != package_source_sha:
        fail("source run head SHA differs from the package source")
    root_job = exact_keys(
        source_run["root_job"],
        {"id", "name", "log_sha256", "log_bytes"},
        "rootfs source job",
    )
    integer(root_job["id"], "rootfs source job ID", minimum=1)
    bounded_text(root_job["name"], "rootfs source job name", maximum=1024)
    text_matching(root_job["log_sha256"], HEX_64, "rootfs source job log digest")
    integer(
        root_job["log_bytes"],
        "rootfs source job log size",
        minimum=1,
        maximum=MAX_ROOT_JOB_LOG_BYTES,
    )
    selected_artifacts = source_run["selected_artifacts"]
    if not isinstance(selected_artifacts, list):
        fail("source run selected artifacts must be an array")
    normalized_run_artifacts: list[dict[str, Any]] = []
    for index, raw in enumerate(selected_artifacts):
        record = exact_keys(
            raw,
            {
                "id",
                "name",
                "bytes",
                "archive_name",
                "archive_bytes",
                "archive_sha256",
            },
            f"source run selected artifact {index}",
        )
        normalized_run_artifacts.append(
            {
                "id": integer(record["id"], "source run artifact ID", minimum=1),
                "name": bounded_text(
                    record["name"], "source run artifact name", maximum=256
                ),
                "bytes": integer(
                    record["bytes"],
                    "source run artifact size",
                    minimum=1,
                    maximum=MAX_ARCHIVE_BYTES,
                ),
                "archive_name": text_matching(
                    record["archive_name"], ASSET, "source run archive name"
                ),
                "archive_bytes": integer(
                    record["archive_bytes"],
                    "source run archive size",
                    minimum=1,
                    maximum=MAX_ARCHIVE_BYTES,
                ),
                "archive_sha256": text_matching(
                    record["archive_sha256"],
                    HEX_64,
                    "source run archive digest",
                ),
            }
        )
    if normalized_run_artifacts != sorted(
        normalized_run_artifacts, key=lambda item: item["name"]
    ):
        fail("source run selected artifacts must be sorted")
    if len({item["id"] for item in normalized_run_artifacts}) != len(
        normalized_run_artifacts
    ):
        fail("source run selected artifact IDs must be unique")
    expected_artifact_names = sorted(
        f"{entry['package']}-{entry['arch']}" for entry in projection["entries"]
    )
    if [item["name"] for item in normalized_run_artifacts] != expected_artifact_names:
        fail("source run artifacts differ from the selected package closure")
    run_archives = sorted(
        (
            item["archive_name"],
            item["archive_bytes"],
            item["archive_sha256"],
        )
        for item in normalized_run_artifacts
    )
    expected_archives = sorted(
        (item["name"], item["bytes"], item["sha256"]) for item in archives
    )
    if run_archives != expected_archives:
        fail("source run archive bytes differ from the selected staging archives")
    return capture


def projection_label(projection: dict[str, Any]) -> str:
    if projection["schema"] == SINGLE_ROOT_PROJECTION_SCHEMA:
        return projection["root_package"]
    return projection["root_set"]


def source_activation_tag(identity: dict[str, Any]) -> str:
    if identity["format"] == IDENTITY_FORMAT:
        return identity["source_activation"]["evidence"]["tag"]
    return identity["producer"]["evidence"]["tag"]


def generation_tag(identity: dict[str, Any], digest: str) -> str:
    projection = identity["projection"]
    if identity["format"] == PRESERVED_IDENTITY_FORMAT:
        return (
            f"preserved-package-generation-{projection['root_package']}"
            f"-{projection['arch']}-abi-v{identity['abi_version']}"
            f"-source-{identity['package_source_sha']}-sha256-{digest}"
        )
    return (
        f"package-generation-{projection_label(projection)}-{projection['arch']}"
        f"-abi-v{identity['abi_version']}-sha256-{digest}"
    )


def release_fields(identity: dict[str, Any], tag: str) -> dict[str, Any]:
    projection = identity["projection"]
    if identity["format"] == PRESERVED_IDENTITY_FORMAT:
        title = (
            f"Preserved PR package closure: {projection_label(projection)} "
            f"{projection['arch']}, ABI {identity['abi_version']}"
        )
        body = (
            "Application-sealed Kandelo PR package closure.\n\n"
            f"Package producer: `{identity['package_source_sha']}`\n"
            f"Trusted publisher authority: `{identity['authority_sha']}`\n"
            "Direct tag anchor: package producer\n"
            f"Source staging release: `{identity['source_capture']['source_staging']['tag']}`\n"
            f"Source workflow run: `{identity['source_capture']['source_run']['id']}`\n"
            f"Content identity: `{tag.rsplit('-sha256-', 1)[1]}`\n\n"
            "This prerelease preserves exact build evidence only. It does not "
            "claim that the producer is on main, ABI-compatible with main, or "
            "admitted for package resolution. Consumers must validate "
            "`generation.json` and every asset. `generation.json` is the "
            "application seal; GitHub release metadata is not treated as immutable."
        )
        # WHY: anchoring the direct tag at the producer keeps that exact source
        # object reachable after its PR staging ref is removed. The separately
        # recorded current-main authority says which reviewed publisher sealed
        # the bytes; it does not make the producer an ancestor of main or admit
        # this closure for package resolution.
        return {
            "title": title,
            "body": body,
            "target_commitish": identity["package_source_sha"],
            "prerelease": True,
        }
    title = (
        f"Package generation: {projection_label(projection)} {projection['arch']}, "
        f"ABI {identity['abi_version']}"
    )
    if identity["format"] == IDENTITY_FORMAT:
        target_commitish = identity["package_source_sha"]
        body = (
            "Durable Kandelo package generation.\n\n"
            f"Package source: `{identity['package_source_sha']}`\n"
            f"Activated package release: `{source_activation_tag(identity)}`\n"
            "Activated main source: "
            f"`{identity['source_activation']['evidence']['package_source_sha']}`\n"
            f"Content identity: `{tag.rsplit('-sha256-', 1)[1]}`\n\n"
            "Consumers must validate `generation.json` and every asset; this "
            "prerelease is append-only by contract."
        )
    else:
        producer_sha = identity["producer"]["evidence"]["producer_sha"]
        # WHY: archives must continue to identify the commit that built them,
        # while only reviewed current main is allowed to own the new public
        # generation tag and release.
        target_commitish = identity["validated_against_main"]["commit"]
        body = (
            "Durable Kandelo package generation.\n\n"
            f"Immutable package producer: `{producer_sha}`\n"
            f"Validated current main: `{target_commitish}`\n"
            "Validation method: "
            f"`{identity['validated_against_main']['method']}`\n"
            f"Activated package release: `{source_activation_tag(identity)}`\n"
            f"Content identity: `{tag.rsplit('-sha256-', 1)[1]}`\n\n"
            "Consumers must validate `generation.json` and every asset; this "
            "prerelease is append-only by contract."
        )
    return {
        "title": title,
        "body": body,
        "target_commitish": target_commitish,
        "prerelease": True,
    }


def validate_identity_v1(value: Any) -> dict[str, Any]:
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


def validate_identity_v2(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get("projection"), dict):
        fail("generation identity must contain a package projection")
    identity = exact_keys(
        value,
        {
            "format",
            "repository",
            "abi_version",
            "authority_sha",
            "producer",
            "validated_against_main",
            "cache_projection",
            "projection",
            "expected_ledger",
            "validated_snapshot",
            "localized_index",
            "archives",
        },
        "generation identity",
    )
    if identity["format"] != IDENTITY_FORMAT_V2:
        fail("generation identity format is unsupported")
    repository = text_matching(
        identity["repository"], REPOSITORY, "generation repository"
    )
    abi_version = integer(identity["abi_version"], "generation ABI", minimum=1)
    projection = validate_projection(identity["projection"])
    authority_sha = text_matching(
        identity["authority_sha"], HEX_40, "workflow authority SHA"
    )
    producer = exact_keys(
        identity["producer"],
        {"evidence", "index_sha256", "index_bytes"},
        "package producer identity",
    )
    producer_evidence = validate_producer_release_evidence(producer["evidence"])
    if (
        producer_evidence != producer["evidence"]
        or producer_evidence["repository"] != repository
    ):
        fail("package producer evidence differs from the generation source")
    text_matching(producer["index_sha256"], HEX_64, "producer index digest")
    integer(
        producer["index_bytes"],
        "producer index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    validation = validate_main_validation_evidence(
        identity["validated_against_main"]
    )
    if (
        validation != identity["validated_against_main"]
        or validation["repository"] != repository
        or validation["abi_version"] != abi_version
    ):
        fail("main validation evidence differs from the generation identity")
    if authority_sha != validation["commit"]:
        fail("workflow authority SHA differs from the validated main commit")
    if validation["method"] == IDENTICAL_GIT_TREE_METHOD:
        # WHY: commit ancestry does not prove that build inputs are equal. The
        # exact-tree method admits a distinct immutable producer only when Git
        # says its complete repository tree is byte-for-byte current main.
        if producer_evidence["producer_tree_sha"] != validation["tree_sha"]:
            fail("package producer tree differs from validated main")
        if identity["cache_projection"] is not None:
            fail("exact-tree generation must not carry cache projection evidence")
    else:
        # WHY: the PR release is mutable and therefore cannot be the admission
        # source. The separate preservation release binds its complete bytes,
        # same-run artifacts, and source log before this one-shot H→M proof.
        if producer_evidence["format"] != PRESERVED_PRODUCER_EVIDENCE_FORMAT:
            fail(
                "cache projection admission requires sealed preserved "
                "producer evidence"
            )
        bridge_source_tag = producer_evidence["preserved_manifest"]["identity"][
            "source_capture"
        ]["source_staging"]["tag"]
        if (
            producer_evidence["producer_sha"]
            != CACHE_PROJECTION_BRIDGE_PRODUCER_SHA
            or bridge_source_tag != CACHE_PROJECTION_BRIDGE_SOURCE_TAG
        ):
            fail(
                "cache projection compatibility is restricted to the "
                "retained PR #1097 staging producer"
            )
        cache_projection = validate_cache_projection_evidence(
            identity["cache_projection"]
        )
        if cache_projection != identity["cache_projection"]:
            fail("package cache projection evidence is not canonical")
        if cache_projection["producer"] != {
            "commit": producer_evidence["producer_sha"],
            "tree_sha": producer_evidence["producer_tree_sha"],
        }:
            fail("cache projection evidence differs from the package producer")
        if cache_projection["validated_main"] != {
            "commit": validation["commit"],
            "tree_sha": validation["tree_sha"],
        }:
            fail("cache projection evidence differs from validated main")
        if cache_projection["projection_sha256"] != sha256_bytes(
            canonical_bytes(projection)
        ):
            fail("cache projection evidence differs from the generation projection")
    source_tag = producer_evidence["tag"]
    if (
        producer_evidence["release_kind"] == "canonical"
        and source_tag != f"binaries-abi-v{abi_version}"
    ):
        fail("canonical producer release tag differs from the generation ABI")
    expected = select_expected(identity["expected_ledger"], projection, abi_version)
    if expected != identity["expected_ledger"]:
        fail("generation expected ledger is not canonical")
    if validation["method"] == IDENTICAL_PACKAGE_CACHE_PROJECTION_METHOD:
        validate_build_inputs_against_selection(
            cache_projection["selected_build_inputs"],
            projection,
            expected,
        )
    if producer_evidence["format"] == PRESERVED_PRODUCER_EVIDENCE_FORMAT:
        preserved = producer_evidence["preserved_manifest"]
        preserved_identity = preserved["identity"]
        preserved_archives = [
            {
                "package": record["package"],
                "arch": record["arch"],
                "name": record["name"],
                "sha256": record["sha256"],
                "bytes": record["bytes"],
            }
            for record in preserved_identity["archives"]
        ]
        if (
            preserved_identity["projection"] != projection
            or preserved_identity["expected_ledger"] != expected
            or preserved_identity["abi_version"] != abi_version
            or producer["index_sha256"] != preserved["index"]["sha256"]
            or producer["index_bytes"] != preserved["index"]["bytes"]
            or identity["archives"] != preserved_archives
        ):
            fail(
                "admitted package generation differs from the complete "
                "preserved producer seal"
            )
    if (
        validation["method"] == IDENTICAL_PACKAGE_CACHE_PROJECTION_METHOD
        and cache_projection["expected_ledger_sha256"]
        != sha256_bytes(canonical_bytes(expected))
    ):
        fail(
            "cache projection evidence differs from the generation expected ledger"
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
        source_tag,
        abi_version,
    )
    if identity["archives"] != derived_archives:
        fail("generation archives differ from the validated producer snapshot")
    return identity


def validate_preserved_identity(value: Any) -> dict[str, Any]:
    identity = exact_keys(
        value,
        {
            "format",
            "repository",
            "package_source_sha",
            "authority_sha",
            "admission",
            "abi_version",
            "projection",
            "expected_ledger",
            "validated_snapshot",
            "source_capture",
            "localized_index",
            "archives",
            "supporting_assets",
        },
        "preserved generation identity",
    )
    if identity["format"] != PRESERVED_IDENTITY_FORMAT:
        fail("preserved generation identity format is unsupported")
    repository = text_matching(
        identity["repository"], REPOSITORY, "preserved generation repository"
    )
    package_source_sha = text_matching(
        identity["package_source_sha"], HEX_40, "preserved package source SHA"
    )
    text_matching(identity["authority_sha"], HEX_40, "publisher authority SHA")
    if identity["admission"] != "none":
        fail("preserved PR package generations must not claim package admission")
    abi_version = integer(identity["abi_version"], "preserved ABI", minimum=1)
    projection = validate_preserved_projection(identity["projection"])
    expected = select_expected(identity["expected_ledger"], projection, abi_version)
    if expected != identity["expected_ledger"]:
        fail("preserved expected ledger is not canonical")
    snapshot = identity["validated_snapshot"]
    if not isinstance(snapshot, dict):
        fail("preserved validated snapshot must be an object")
    source_tag = snapshot.get("release_tag")
    text_matching(source_tag, STAGING_TAG, "preserved source staging tag")
    _, derived_archives = validate_snapshot(
        snapshot,
        projection,
        expected,
        source_tag,
        abi_version,
    )
    if identity["archives"] != derived_archives:
        fail("preserved archives differ from the validated source snapshot")
    localized = exact_keys(
        identity["localized_index"],
        {"sha256", "bytes"},
        "preserved localized index identity",
    )
    text_matching(localized["sha256"], HEX_64, "preserved localized index digest")
    integer(
        localized["bytes"],
        "preserved localized index size",
        minimum=1,
        maximum=MAX_INDEX_BYTES,
    )
    supporting = validate_supporting_assets(identity["supporting_assets"])
    if supporting != identity["supporting_assets"]:
        fail("preserved supporting assets are not canonical")
    capture = validate_source_capture(
        identity["source_capture"],
        repository=repository,
        package_source_sha=package_source_sha,
        source_tag=source_tag,
        archives=derived_archives,
        projection=projection,
    )
    log_assets = [
        item for item in supporting if item["name"] == "rootfs-job.log"
    ]
    root_job = capture["source_run"]["root_job"]
    if len(log_assets) != 1 or (
        log_assets[0]["sha256"] != root_job["log_sha256"]
        or log_assets[0]["bytes"] != root_job["log_bytes"]
    ):
        fail("rootfs-job.log must exactly preserve the source-run log evidence")
    return identity


def validate_identity(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("generation identity must be an object")
    # WHY: already-published v1 generations are immutable consumer inputs.
    # Their one SHA remains both producer and main; interpreting it through v2
    # would retroactively change a public content-addressed contract.
    if value.get("format") == IDENTITY_FORMAT:
        return validate_identity_v1(value)
    if value.get("format") == IDENTITY_FORMAT_V2:
        return validate_identity_v2(value)
    if value.get("format") == PRESERVED_IDENTITY_FORMAT:
        return validate_preserved_identity(value)
    fail("generation identity format is unsupported")


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
    if manifest["format"] not in {
        MANIFEST_FORMAT,
        MANIFEST_FORMAT_V2,
        PRESERVED_MANIFEST_FORMAT,
    }:
        fail("generation manifest format is unsupported")
    identity = validate_identity(manifest["identity"])
    expected_manifest_format = {
        IDENTITY_FORMAT: MANIFEST_FORMAT,
        IDENTITY_FORMAT_V2: MANIFEST_FORMAT_V2,
        PRESERVED_IDENTITY_FORMAT: PRESERVED_MANIFEST_FORMAT,
    }[identity["format"]]
    if manifest["format"] != expected_manifest_format:
        fail("generation manifest and identity formats do not correspond")
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


def command_select_source_assets(args: argparse.Namespace) -> None:
    source_tag = text_matching(args.source_tag, STAGING_TAG, "source staging tag")
    projection = validate_preserved_projection(read_json(args.projection))
    expected_raw = read_json(args.expected_ledger)
    abi_version = integer(expected_raw.get("abi_version"), "expected ABI", minimum=1)
    expected = select_expected(expected_raw, projection, abi_version)
    if expected != expected_raw:
        fail("selected expected ledger is not canonical")
    snapshot, selected_assets = selected_snapshot_from_release(
        expected,
        source_tag,
        read_json(args.release_assets, max_bytes=MAX_GITHUB_METADATA_BYTES),
    )
    # Reuse the ordinary snapshot validator so this selected-only path cannot
    # drift from durable generation identity rules.
    validate_snapshot(snapshot, projection, expected, source_tag, abi_version)
    write_json(args.snapshot_out, snapshot)
    write_json(args.selected_assets_out, selected_assets)


def one_archive_under(path: Path, context: str) -> Path:
    if not path.is_dir() or path.is_symlink():
        fail(f"{context} must be a regular directory: {path}")
    archives = [
        entry
        for entry in path.rglob("*.tar.zst")
        if entry.is_file() and not entry.is_symlink()
    ]
    if len(archives) != 1:
        fail(f"{context} must contain exactly one regular archive")
    return archives[0]


def log_content(line: str) -> str:
    return re.sub(
        r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\s?",
        "",
        line.rstrip("\r\n"),
    )


def verify_root_dependency_log(
    log_bytes: bytes,
    projection: dict[str, Any],
    expected: dict[str, Any],
) -> None:
    try:
        lines = [log_content(line) for line in log_bytes.decode("utf-8").splitlines()]
    except UnicodeDecodeError as error:
        fail(f"rootfs source job log is not UTF-8: {error}")
    root = projection["root_package"]
    arch = projection["arch"]
    selected_programs = sorted(
        f"{entry['package']}-{entry['arch']}"
        for entry in expected["entries"]
        if entry["package"] != root and entry["kind"] == "program"
    )
    selected_all = sorted(
        f"{entry['package']}-{entry['arch']}"
        for entry in projection["entries"]
        if entry["package"] != root
    )
    artifact_line = re.compile(r"^\s+([A-Za-z0-9._-]+-wasm(?:32|64))\s*$")
    dependency_headings = [
        index
        for index, line in enumerate(lines)
        if line.strip() == "selected program dependency artifacts:"
    ]
    if len(dependency_headings) != 1:
        fail(
            "rootfs source job log must contain exactly one selected-program "
            "dependency heading"
        )
    exact_blocks: list[list[str]] = []
    for index, line in enumerate(lines):
        if line.strip() != "selected program dependency artifacts:":
            continue
        block: list[str] = []
        for following in lines[index + 1 :]:
            match = artifact_line.fullmatch(following)
            if match is None:
                break
            block.append(match.group(1))
        if sorted(block) == selected_programs and len(block) == len(selected_programs):
            exact_blocks.append(block)
    if len(exact_blocks) != 1:
        fail(
            "rootfs source job log does not contain exactly one complete "
            "selected-program dependency block"
        )

    downloaded = Counter(
        match.group(1)
        for line in lines
        if (
            match := re.search(
                r"(?:^|\s)downloaded dependency artifact "
                r"([A-Za-z0-9._-]+-wasm(?:32|64))(?:\s|$)",
                line,
            )
        )
    )
    wrong_download_counts = {
        artifact: downloaded[artifact]
        for artifact in selected_all
        if downloaded[artifact] != 1
    }
    if wrong_download_counts:
        fail(
            "rootfs source job log must contain exactly one same-run download "
            f"for every selected dependency: {wrong_download_counts}"
        )
    for line in lines:
        if "continuing without overlay" not in line:
            continue
        if any(artifact in line for artifact in selected_all):
            fail("rootfs source job log used a fallback for a selected dependency")


def command_capture_source(args: argparse.Namespace) -> None:
    repository = text_matching(args.repository, REPOSITORY, "repository")
    package_source_sha = text_matching(
        args.package_source_sha, HEX_40, "package source SHA"
    )
    source_tag = text_matching(args.source_tag, STAGING_TAG, "source staging tag")
    projection = validate_preserved_projection(read_json(args.projection))
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
    derived_snapshot, selected_release_assets = selected_snapshot_from_release(
        expected,
        source_tag,
        read_json(args.release_assets, max_bytes=MAX_GITHUB_METADATA_BYTES),
    )
    if derived_snapshot != snapshot:
        fail("selected source release metadata changed from the frozen snapshot")

    release = read_json(args.release, max_bytes=MAX_GITHUB_METADATA_BYTES)
    if not isinstance(release, dict):
        fail("source release metadata must be an object")
    if (
        release.get("tag_name") != source_tag
        or release.get("draft") is not False
        or release.get("prerelease") is not True
    ):
        fail("source release is not the selected published staging prerelease")
    release_id = integer(release.get("id"), "source release ID", minimum=1)
    release_target = bounded_text(
        release.get("target_commitish"), "source release target", maximum=256
    )
    tag_ref = read_json(args.tag_ref, max_bytes=MAX_GITHUB_METADATA_BYTES)
    if (
        not isinstance(tag_ref, dict)
        or tag_ref.get("ref") != f"refs/tags/{source_tag}"
        or not isinstance(tag_ref.get("object"), dict)
        or tag_ref["object"].get("type") != "commit"
    ):
        fail("source staging tag is not a direct commit reference")
    tag_object_sha = text_matching(
        tag_ref["object"].get("sha"), HEX_40, "source staging tag object"
    )
    # WHY: a mutable pr-N-staging tag is only the release locator and may still
    # point at an older PR commit. Preserve and race-recheck that observed
    # anchor, but derive producer authority from the exact workflow run head,
    # same-run artifact bytes, release-byte equality, and archive provenance.
    # The new content-addressed preserved tag directly anchors the producer.

    run = read_json(args.run, max_bytes=MAX_GITHUB_METADATA_BYTES)
    if not isinstance(run, dict):
        fail("source workflow run metadata must be an object")
    run_id = integer(run.get("id"), "source workflow run ID", minimum=1)
    if run_id != args.run_id or run.get("head_sha") != package_source_sha:
        fail("source workflow run does not bind the requested run and package SHA")
    run_attempt = integer(run.get("run_attempt"), "source run attempt", minimum=1)
    run_event = bounded_text(run.get("event"), "source run event", maximum=64)
    if run_event != "pull_request":
        fail("source workflow run event must be pull_request")
    workflow_path = bounded_text(
        run.get("path"), "source workflow path", maximum=256
    )
    if workflow_path != ".github/workflows/staging-build.yml":
        fail("source workflow run is not staging-build.yml")

    jobs = read_json(args.jobs, max_bytes=MAX_GITHUB_METADATA_BYTES)
    if not isinstance(jobs, list):
        fail("source workflow jobs must be an array")
    root_job_matches = [
        job
        for job in jobs
        if isinstance(job, dict)
        and isinstance(job.get("name"), str)
        and job["name"].startswith("matrix-build (")
        and f", {projection['root_package']}," in job["name"]
        and job["name"].startswith(f"matrix-build ({projection['arch']},")
    ]
    if len(root_job_matches) != 1:
        fail("source run must contain exactly one selected root-package matrix job")
    root_job = root_job_matches[0]
    if root_job.get("status") != "completed" or root_job.get("conclusion") != "success":
        fail("selected root-package matrix job is not complete and successful")
    root_job_id = integer(root_job.get("id"), "rootfs source job ID", minimum=1)
    root_job_name = bounded_text(
        root_job.get("name"), "rootfs source job name", maximum=1024
    )

    root_log_path = args.root_job_log
    regular_file(root_log_path, "rootfs source job log")
    root_log_bytes = root_log_path.read_bytes()
    if not root_log_bytes or len(root_log_bytes) > MAX_ROOT_JOB_LOG_BYTES:
        fail("rootfs source job log is empty or oversized")
    verify_root_dependency_log(root_log_bytes, projection, expected)

    run_artifacts = read_json(
        args.run_artifacts, max_bytes=MAX_GITHUB_METADATA_BYTES
    )
    if not isinstance(run_artifacts, list):
        fail("source workflow artifacts must be an array")
    expected_artifact_names = {
        f"{entry['package']}-{entry['arch']}" for entry in projection["entries"]
    }
    run_artifacts_by_name: dict[str, dict[str, Any]] = {}
    for raw in run_artifacts:
        if not isinstance(raw, dict) or raw.get("name") not in expected_artifact_names:
            continue
        name = raw["name"]
        if name in run_artifacts_by_name:
            fail(f"source run contains duplicate selected artifact {name}")
        if raw.get("expired") is not False:
            fail(f"source run artifact is expired: {name}")
        workflow_run = raw.get("workflow_run")
        if not isinstance(workflow_run, dict) or workflow_run.get("id") != run_id:
            fail(f"source artifact belongs to another workflow run: {name}")
        run_artifacts_by_name[name] = raw
    if set(run_artifacts_by_name) != expected_artifact_names:
        fail("source run does not contain the complete selected closure")

    archive_by_package = {item["package"]: item for item in archives}
    selected_run_artifacts: list[dict[str, Any]] = []
    for name in sorted(expected_artifact_names):
        raw = run_artifacts_by_name[name]
        artifact_id = integer(raw.get("id"), f"{name} artifact ID", minimum=1)
        artifact_bytes = integer(
            raw.get("size_in_bytes"),
            f"{name} artifact size",
            minimum=1,
            maximum=MAX_ARCHIVE_BYTES * 2,
        )
        package = name.removesuffix(f"-{projection['arch']}")
        wanted = archive_by_package.get(package)
        if wanted is None:
            fail(f"cannot map source run artifact to selected package: {name}")
        run_archive = one_archive_under(
            args.run_archives_dir / name,
            f"source run artifact {name}",
        )
        release_archive = args.archives_dir / wanted["name"]
        regular_file(release_archive, "selected source release archive")
        run_size = run_archive.stat().st_size
        run_digest = sha256_file(run_archive)
        if (
            run_archive.name != wanted["name"]
            or run_size != wanted["bytes"]
            or run_digest != wanted["sha256"]
            or release_archive.stat().st_size != wanted["bytes"]
            or sha256_file(release_archive) != wanted["sha256"]
        ):
            fail(f"same-run and selected release archive bytes differ for {name}")
        selected_run_artifacts.append(
            {
                "id": artifact_id,
                "name": name,
                "bytes": artifact_bytes,
                "archive_name": wanted["name"],
                "archive_bytes": run_size,
                "archive_sha256": run_digest,
            }
        )

    capture = {
        "format": SOURCE_CAPTURE_FORMAT,
        "repository": repository,
        "package_source_sha": package_source_sha,
        "source_staging": {
            "tag": source_tag,
            "release_id": release_id,
            "observed_target_commitish": release_target,
            "observed_tag_object_sha": tag_object_sha,
            "selected_assets": selected_release_assets,
        },
        "source_run": {
            "id": run_id,
            "attempt": run_attempt,
            "event": run_event,
            "workflow_path": workflow_path,
            "head_sha": package_source_sha,
            "root_job": {
                "id": root_job_id,
                "name": root_job_name,
                "log_sha256": sha256_bytes(root_log_bytes),
                "log_bytes": len(root_log_bytes),
            },
            "selected_artifacts": selected_run_artifacts,
        },
    }
    validate_source_capture(
        capture,
        repository=repository,
        package_source_sha=package_source_sha,
        source_tag=source_tag,
        archives=archives,
        projection=projection,
    )
    write_json(args.capture_out, capture)


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


def command_producer_release_evidence(args: argparse.Namespace) -> None:
    preserved_mode = (
        args.preserved_manifest is not None or args.release_assets is not None
    )
    if preserved_mode:
        if args.preserved_manifest is None or args.release_assets is None:
            fail(
                "preserved producer evidence requires both manifest and asset metadata"
            )
        evidence = derive_preserved_producer_release_evidence(
            repository=args.repository,
            source_tag=args.source_tag,
            producer_sha=args.producer_sha,
            release=read_json(args.release, max_bytes=MAX_GITHUB_METADATA_BYTES),
            tag_ref=read_json(args.tag_ref, max_bytes=MAX_GITHUB_METADATA_BYTES),
            producer_commit=read_json(
                args.producer_commit, max_bytes=MAX_GITHUB_METADATA_BYTES
            ),
            preserved_manifest=read_json(
                args.preserved_manifest, max_bytes=MAX_MANIFEST_BYTES
            ),
            release_assets=read_json(
                args.release_assets, max_bytes=MAX_GITHUB_METADATA_BYTES
            ),
        )
    else:
        evidence = derive_producer_release_evidence(
            repository=args.repository,
            source_tag=args.source_tag,
            producer_sha=args.producer_sha,
            release=read_json(args.release, max_bytes=MAX_MANIFEST_BYTES),
            tag_ref=read_json(args.tag_ref, max_bytes=MAX_MANIFEST_BYTES),
            producer_commit=read_json(
                args.producer_commit, max_bytes=MAX_MANIFEST_BYTES
            ),
        )
    write_json(args.output, evidence)


def command_main_validation_evidence(args: argparse.Namespace) -> None:
    evidence = derive_main_validation_evidence(
        repository=args.repository,
        default_ref=args.default_ref,
        validated_main_sha=args.validated_main_sha,
        abi_version=args.abi_version,
        default_ref_value=read_json(
            args.default_ref_value, max_bytes=MAX_MANIFEST_BYTES
        ),
        main_commit=read_json(args.main_commit, max_bytes=MAX_MANIFEST_BYTES),
        abi_snapshot_path=args.abi_snapshot,
        method=args.method,
    )
    write_json(args.output, evidence)


def command_cache_projection_evidence(args: argparse.Namespace) -> None:
    evidence = derive_cache_projection_evidence(
        producer_sha=args.producer_sha,
        producer_tree_sha=args.producer_tree_sha,
        validated_main_sha=args.validated_main_sha,
        validated_main_tree_sha=args.validated_main_tree_sha,
        producer_projection_path=args.producer_projection,
        producer_expected_path=args.producer_expected_ledger,
        main_projection_path=args.main_projection,
        main_expected_path=args.main_expected_ledger,
        producer_components_path=args.producer_components,
        main_components_path=args.main_components,
        producer_tree_value=read_json(
            args.producer_tree, max_bytes=MAX_INDEX_BYTES
        ),
        main_tree_value=read_json(args.main_tree, max_bytes=MAX_INDEX_BYTES),
    )
    write_json(args.output, evidence)


def command_prepare(args: argparse.Namespace) -> None:
    repository = text_matching(args.repository, REPOSITORY, "repository")
    source_tag = args.source_tag
    if not isinstance(source_tag, str):
        fail("package source tag has an invalid value")
    if args.output_dir.exists() or args.output_dir.is_symlink():
        fail(f"output already exists: {args.output_dir}")
    projection = validate_projection(read_json(args.projection))
    legacy_mode = args.source_evidence is not None or args.package_source_sha is not None
    exact_tree_mode = (
        args.producer_evidence is not None
        or args.main_validation is not None
        or args.producer_sha is not None
    )
    if legacy_mode == exact_tree_mode:
        fail("prepare requires exactly one complete v1 or v2 provenance mode")
    authority_sha = text_matching(
        args.authority_sha, HEX_40, "workflow authority SHA"
    )
    if legacy_mode:
        if args.source_evidence is None or args.package_source_sha is None:
            fail("v1 preparation requires source evidence and package source SHA")
        package_source_sha = text_matching(
            args.package_source_sha, HEX_40, "package source SHA"
        )
        text_matching(source_tag, CANONICAL_BINARY_TAG, "canonical binary tag")
        source_evidence = validate_main_source_evidence(
            read_json(args.source_evidence)
        )
        if (
            source_evidence["repository"] != repository
            or source_evidence["tag"] != source_tag
            or source_evidence["package_source_sha"] != package_source_sha
        ):
            fail("main activation evidence does not bind the generation inputs")
    else:
        if (
            args.producer_evidence is None
            or args.main_validation is None
            or args.producer_sha is None
        ):
            fail(
                "v2 preparation requires producer evidence, main validation, and producer SHA"
            )
        producer_sha = text_matching(
            args.producer_sha, HEX_40, "package producer SHA"
        )
        producer_evidence = validate_producer_release_evidence(
            read_json(args.producer_evidence)
        )
        main_validation = validate_main_validation_evidence(
            read_json(args.main_validation)
        )
        if (
            producer_evidence["repository"] != repository
            or producer_evidence["tag"] != source_tag
            or producer_evidence["producer_sha"] != producer_sha
            or main_validation["repository"] != repository
            or main_validation["commit"] != authority_sha
        ):
            fail("v2 evidence does not bind the generation inputs")
        if main_validation["method"] == IDENTICAL_GIT_TREE_METHOD:
            if args.cache_projection is not None:
                fail("exact-tree preparation must not receive cache projection evidence")
            if (
                producer_evidence["producer_tree_sha"]
                != main_validation["tree_sha"]
            ):
                fail("exact-tree evidence does not bind the generation inputs")
            cache_projection = None
        else:
            if args.cache_projection is None:
                fail("cache-projection preparation requires projection evidence")
            cache_projection = validate_cache_projection_evidence(
                read_json(args.cache_projection, max_bytes=MAX_MANIFEST_BYTES)
            )
            if cache_projection["producer"] != {
                "commit": producer_evidence["producer_sha"],
                "tree_sha": producer_evidence["producer_tree_sha"],
            } or cache_projection["validated_main"] != {
                "commit": main_validation["commit"],
                "tree_sha": main_validation["tree_sha"],
            }:
                fail("cache projection evidence does not bind the generation inputs")
    expected_raw = read_json(args.expected_ledger)
    abi_version = integer(expected_raw.get("abi_version"), "expected ABI", minimum=1)
    expected = select_expected(expected_raw, projection, abi_version)
    if expected != expected_raw:
        fail("selected expected ledger is not canonical")
    if not legacy_mode and main_validation["abi_version"] != abi_version:
        fail("main validation evidence differs from the selected ABI")
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
    source_release = {
        "evidence": source_evidence if legacy_mode else producer_evidence,
        "index_sha256": sha256_file(args.source_index),
        "index_bytes": args.source_index.stat().st_size,
    }
    common_identity = {
        "repository": repository,
        "abi_version": abi_version,
        "authority_sha": authority_sha,
        "projection": projection,
        "expected_ledger": expected,
        "validated_snapshot": snapshot,
        "localized_index": {
            "sha256": sha256_bytes(localized_bytes),
            "bytes": len(localized_bytes),
        },
        "archives": archives,
    }
    if legacy_mode:
        # WHY: v1 keeps its original exact-source meaning for byte-compatible
        # materialization of generations that are already public.
        identity = {
            "format": IDENTITY_FORMAT,
            "package_source_sha": package_source_sha,
            "source_activation": source_release,
            **common_identity,
        }
        manifest_format = MANIFEST_FORMAT
    else:
        # WHY: do not rewrite truthful archive provenance to M. The v2 receipt
        # binds immutable producer S to current-main authority M separately.
        identity = {
            "format": IDENTITY_FORMAT_V2,
            "producer": source_release,
            "validated_against_main": main_validation,
            "cache_projection": cache_projection,
            **common_identity,
        }
        manifest_format = MANIFEST_FORMAT_V2
    validate_identity(identity)
    identity_digest = sha256_bytes(canonical_bytes(identity))
    tag = generation_tag(identity, identity_digest)
    release_prefix = (
        f"https://github.com/{repository}/releases/download/{tag}/"
    )
    remote_index = rewrite_localized_index(localized_bytes, archive_names, release_prefix)
    manifest = {
        "format": manifest_format,
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


def command_prepare_preserved(args: argparse.Namespace) -> None:
    repository = text_matching(args.repository, REPOSITORY, "repository")
    package_source_sha = text_matching(
        args.package_source_sha, HEX_40, "package source SHA"
    )
    authority_sha = text_matching(
        args.authority_sha, HEX_40, "publisher authority SHA"
    )
    if args.output_dir.exists() or args.output_dir.is_symlink():
        fail(f"output already exists: {args.output_dir}")
    projection = validate_preserved_projection(read_json(args.projection))
    expected_raw = read_json(args.expected_ledger)
    abi_version = integer(expected_raw.get("abi_version"), "expected ABI", minimum=1)
    expected = select_expected(expected_raw, projection, abi_version)
    if expected != expected_raw:
        fail("selected expected ledger is not canonical")
    snapshot_value = read_json(args.snapshot)
    source_tag = text_matching(
        snapshot_value.get("release_tag"), STAGING_TAG, "source staging tag"
    )
    snapshot, archives = validate_snapshot(
        snapshot_value,
        projection,
        expected,
        source_tag,
        abi_version,
    )
    regular_file(args.localized_index, "localized minimal index")
    localized_bytes = args.localized_index.read_bytes()
    archive_names = [record["name"] for record in archives]
    rewrite_localized_index(localized_bytes, archive_names, "")
    for record in archives:
        archive = args.archives_dir / record["name"]
        regular_file(archive, "validated staging archive")
        if (
            archive.stat().st_size != record["bytes"]
            or sha256_file(archive) != record["sha256"]
        ):
            fail(f"validated archive bytes changed: {record['name']}")

    if (
        not args.supporting_assets_dir.is_dir()
        or args.supporting_assets_dir.is_symlink()
    ):
        fail("supporting assets must be a regular directory")
    supporting_assets: list[dict[str, Any]] = []
    for path in sorted(
        args.supporting_assets_dir.iterdir(), key=lambda item: item.name
    ):
        regular_file(path, "supporting evidence asset")
        text_matching(path.name, SUPPORTING_ASSET, "supporting evidence asset name")
        size = path.stat().st_size
        if size < 1 or size > MAX_SUPPORTING_ASSET_BYTES:
            fail(f"supporting evidence asset is empty or oversized: {path.name}")
        supporting_assets.append(
            {"name": path.name, "sha256": sha256_file(path), "bytes": size}
        )
    validate_supporting_assets(supporting_assets)
    capture = read_json(args.source_capture, max_bytes=MAX_MANIFEST_BYTES)
    validate_source_capture(
        capture,
        repository=repository,
        package_source_sha=package_source_sha,
        source_tag=source_tag,
        archives=archives,
        projection=projection,
    )
    identity = {
        "format": PRESERVED_IDENTITY_FORMAT,
        "repository": repository,
        "package_source_sha": package_source_sha,
        "authority_sha": authority_sha,
        "admission": "none",
        "abi_version": abi_version,
        "projection": projection,
        "expected_ledger": expected,
        "validated_snapshot": snapshot,
        "source_capture": capture,
        "localized_index": {
            "sha256": sha256_bytes(localized_bytes),
            "bytes": len(localized_bytes),
        },
        "archives": archives,
        "supporting_assets": supporting_assets,
    }
    validate_preserved_identity(identity)
    identity_digest = sha256_bytes(canonical_bytes(identity))
    tag = generation_tag(identity, identity_digest)
    release_prefix = f"https://github.com/{repository}/releases/download/{tag}/"
    remote_index = rewrite_localized_index(
        localized_bytes, archive_names, release_prefix
    )
    manifest = {
        "format": PRESERVED_MANIFEST_FORMAT,
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
        for record in supporting_assets:
            shutil.copyfile(
                args.supporting_assets_dir / record["name"],
                temporary / record["name"],
            )
        # WHY: the manifest is uploaded last by the common publisher, so its
        # presence means every archive and evidence byte it binds was verified.
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
        *(record["name"] for record in identity.get("supporting_assets", [])),
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
    for record in identity.get("supporting_assets", []):
        supporting = args.bundle / record["name"]
        regular_file(supporting, "generation supporting asset")
        if (
            supporting.stat().st_size != record["bytes"]
            or sha256_file(supporting) != record["sha256"]
        ):
            fail(
                "generation supporting asset differs from its identity: "
                f"{record['name']}"
            )
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
    if identity["format"] == PRESERVED_IDENTITY_FORMAT:
        fail(
            "preserved PR package generations are evidence only and are not "
            "admitted for consumer materialization"
        )
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


def command_compare_source_capture(args: argparse.Namespace) -> None:
    manifest_value = read_json(
        args.generation_manifest, max_bytes=MAX_MANIFEST_BYTES
    )
    if args.generation_manifest.read_bytes() != canonical_bytes(manifest_value):
        fail("generation.json is not canonical JSON")
    _, identity, tag = validate_manifest(manifest_value)
    if identity["format"] != PRESERVED_IDENTITY_FORMAT:
        fail("source capture comparison requires a preserved PR generation")
    captured_value = read_json(args.source_capture, max_bytes=MAX_MANIFEST_BYTES)
    if args.source_capture.read_bytes() != canonical_bytes(captured_value):
        fail("source capture is not canonical JSON")
    if captured_value != identity["source_capture"]:
        fail("live source capture differs from generation.json")
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

    select_assets = subcommands.add_parser("select-source-assets")
    select_assets.add_argument("--source-tag", required=True)
    select_assets.add_argument("--projection", type=Path, required=True)
    select_assets.add_argument("--expected-ledger", type=Path, required=True)
    select_assets.add_argument("--release-assets", type=Path, required=True)
    select_assets.add_argument("--snapshot-out", type=Path, required=True)
    select_assets.add_argument("--selected-assets-out", type=Path, required=True)
    select_assets.set_defaults(action=command_select_source_assets)

    capture = subcommands.add_parser("capture-source")
    capture.add_argument("--repository", required=True)
    capture.add_argument("--package-source-sha", required=True)
    capture.add_argument("--source-tag", required=True)
    capture.add_argument("--run-id", type=int, required=True)
    capture.add_argument("--projection", type=Path, required=True)
    capture.add_argument("--expected-ledger", type=Path, required=True)
    capture.add_argument("--snapshot", type=Path, required=True)
    capture.add_argument("--release", type=Path, required=True)
    capture.add_argument("--tag-ref", type=Path, required=True)
    capture.add_argument("--release-assets", type=Path, required=True)
    capture.add_argument("--run", type=Path, required=True)
    capture.add_argument("--jobs", type=Path, required=True)
    capture.add_argument("--run-artifacts", type=Path, required=True)
    capture.add_argument("--archives-dir", type=Path, required=True)
    capture.add_argument("--run-archives-dir", type=Path, required=True)
    capture.add_argument("--root-job-log", type=Path, required=True)
    capture.add_argument("--capture-out", type=Path, required=True)
    capture.set_defaults(action=command_capture_source)

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

    producer_evidence = subcommands.add_parser("producer-release-evidence")
    producer_evidence.add_argument("--repository", required=True)
    producer_evidence.add_argument("--source-tag", required=True)
    producer_evidence.add_argument("--producer-sha", required=True)
    producer_evidence.add_argument("--release", type=Path, required=True)
    producer_evidence.add_argument("--tag-ref", type=Path, required=True)
    producer_evidence.add_argument(
        "--producer-commit", type=Path, required=True
    )
    producer_evidence.add_argument("--preserved-manifest", type=Path)
    producer_evidence.add_argument("--release-assets", type=Path)
    producer_evidence.add_argument("--output", type=Path, required=True)
    producer_evidence.set_defaults(action=command_producer_release_evidence)

    main_validation = subcommands.add_parser("main-validation-evidence")
    main_validation.add_argument("--repository", required=True)
    main_validation.add_argument("--default-ref", required=True)
    main_validation.add_argument("--validated-main-sha", required=True)
    main_validation.add_argument("--abi-version", type=int, required=True)
    main_validation.add_argument(
        "--method", choices=sorted(VALIDATION_METHODS), required=True
    )
    main_validation.add_argument(
        "--default-ref-value", type=Path, required=True
    )
    main_validation.add_argument("--main-commit", type=Path, required=True)
    main_validation.add_argument("--abi-snapshot", type=Path, required=True)
    main_validation.add_argument("--output", type=Path, required=True)
    main_validation.set_defaults(action=command_main_validation_evidence)

    cache_projection = subcommands.add_parser("cache-projection-evidence")
    cache_projection.add_argument("--producer-sha", required=True)
    cache_projection.add_argument("--producer-tree-sha", required=True)
    cache_projection.add_argument("--validated-main-sha", required=True)
    cache_projection.add_argument("--validated-main-tree-sha", required=True)
    cache_projection.add_argument(
        "--producer-projection", type=Path, required=True
    )
    cache_projection.add_argument(
        "--producer-expected-ledger", type=Path, required=True
    )
    cache_projection.add_argument("--main-projection", type=Path, required=True)
    cache_projection.add_argument(
        "--main-expected-ledger", type=Path, required=True
    )
    cache_projection.add_argument(
        "--producer-components", type=Path, required=True
    )
    cache_projection.add_argument("--main-components", type=Path, required=True)
    cache_projection.add_argument("--producer-tree", type=Path, required=True)
    cache_projection.add_argument("--main-tree", type=Path, required=True)
    cache_projection.add_argument("--output", type=Path, required=True)
    cache_projection.set_defaults(action=command_cache_projection_evidence)

    prepare = subcommands.add_parser("prepare")
    prepare.add_argument("--repository", required=True)
    prepare.add_argument("--package-source-sha")
    prepare.add_argument("--producer-sha")
    prepare.add_argument("--source-tag", required=True)
    prepare.add_argument("--authority-sha")
    prepare.add_argument("--source-index", type=Path, required=True)
    prepare.add_argument("--source-evidence", type=Path)
    prepare.add_argument("--producer-evidence", type=Path)
    prepare.add_argument("--main-validation", type=Path)
    prepare.add_argument("--cache-projection", type=Path)
    prepare.add_argument("--projection", type=Path, required=True)
    prepare.add_argument("--expected-ledger", type=Path, required=True)
    prepare.add_argument("--snapshot", type=Path, required=True)
    prepare.add_argument("--localized-index", type=Path, required=True)
    prepare.add_argument("--archives-dir", type=Path, required=True)
    prepare.add_argument("--output-dir", type=Path, required=True)
    prepare.set_defaults(action=command_prepare)

    prepare_preserved = subcommands.add_parser("prepare-preserved")
    prepare_preserved.add_argument("--repository", required=True)
    prepare_preserved.add_argument("--package-source-sha", required=True)
    prepare_preserved.add_argument("--authority-sha", required=True)
    prepare_preserved.add_argument("--source-capture", type=Path, required=True)
    prepare_preserved.add_argument("--projection", type=Path, required=True)
    prepare_preserved.add_argument("--expected-ledger", type=Path, required=True)
    prepare_preserved.add_argument("--snapshot", type=Path, required=True)
    prepare_preserved.add_argument("--localized-index", type=Path, required=True)
    prepare_preserved.add_argument("--archives-dir", type=Path, required=True)
    prepare_preserved.add_argument(
        "--supporting-assets-dir", type=Path, required=True
    )
    prepare_preserved.add_argument("--output-dir", type=Path, required=True)
    prepare_preserved.set_defaults(action=command_prepare_preserved)

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

    compare_capture = subcommands.add_parser("compare-source-capture")
    compare_capture.add_argument(
        "--generation-manifest", type=Path, required=True
    )
    compare_capture.add_argument("--source-capture", type=Path, required=True)
    compare_capture.set_defaults(action=command_compare_source_capture)
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
