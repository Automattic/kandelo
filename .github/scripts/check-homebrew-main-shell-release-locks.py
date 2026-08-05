#!/usr/bin/env python3
"""Validate the exact sealed shell inputs consumed by mirror publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import stat
import sys
import tomllib
from typing import Any


SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
SELECTION_TAG = re.compile(
    r"^homebrew-prefix-selection-sha256-([0-9a-f]{64})$"
)
MAX_CONTRACT_BYTES = 4 * 1024 * 1024
SELECTION_INPUTS = {
    "brewfile": "homebrew/main-shell.Brewfile",
    "guest_layout": "homebrew/kandelo-guest-layout.json",
    "migration_lock": "homebrew/main-shell-migration-lock.json",
    "runtime_support": "homebrew/main-shell-homebrew-runtime-support.json",
}
ARTIFACT_INPUTS = {
    "bootstrap_tree_spec_sha256": "homebrew/main-shell-brew-package-tree.json",
    "brewfile_sha256": "homebrew/main-shell.Brewfile",
    "demo_config_sha256": "homebrew/main-shell-demo.json",
    "materialization_policy_sha256": "homebrew/main-shell-materialization-policy.json",
    "migration_lock_sha256": "homebrew/main-shell-migration-lock.json",
    "runtime_support_sha256": "homebrew/main-shell-homebrew-runtime-support.json",
    "selection_lock_sha256": "homebrew/main-shell-selection-lock.json",
    "shell_config_sha256": "homebrew/main-shell-default.json",
}


class ContractError(RuntimeError):
    pass


def regular_bytes(root: pathlib.Path, relative: str) -> bytes:
    path = root / relative
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ContractError(f"{relative} is not readable") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size < 1
        or metadata.st_size > MAX_CONTRACT_BYTES
    ):
        raise ContractError(f"{relative} is not one bounded regular file")
    return path.read_bytes()


def json_without_duplicate_keys(value: bytes, label: str) -> Any:
    def exact_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise ContractError(f"{label} repeats JSON key {key!r}")
            result[key] = item
        return result

    try:
        return json.loads(value, object_pairs_hook=exact_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError(f"{label} is not valid JSON") from error


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ContractError(f"{label} has an unsupported shape")
    return value


def positive_integer(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ContractError(f"{label} must be a positive integer")
    return value


def require_selection_inputs(source_root: pathlib.Path, value: Any) -> None:
    records = exact_object(value, set(SELECTION_INPUTS), "selection lock inputs")
    for key, relative in SELECTION_INPUTS.items():
        record = exact_object(
            records[key], {"path", "sha256"}, f"selection lock input {key}"
        )
        if (
            record.get("path") != relative
            or not isinstance(record.get("sha256"), str)
            or not SHA256.fullmatch(record["sha256"])
            or record["sha256"] != sha256(regular_bytes(source_root, relative))
        ):
            raise ContractError(f"selection lock input {key} is not exact")


def require_selection(
    source_root: pathlib.Path,
    value: Any,
    tap_catalog: str,
) -> None:
    selection = exact_object(
        value,
        {"arch", "inputs", "kind", "release", "schema", "state"},
        "selection lock",
    )
    if (
        selection.get("schema") != 1
        or selection.get("kind")
        != "kandelo-homebrew-main-shell-closed-selection-lock"
        or selection.get("arch") != "wasm32"
        or selection.get("state") != "sealed"
    ):
        raise ContractError("selection lock is not sealed for the main shell")
    require_selection_inputs(source_root, selection.get("inputs"))

    release = exact_object(
        selection.get("release"),
        {
            "assets",
            "formula_count",
            "prepared_tree_git_oid",
            "repository",
            "roots",
            "selection_manifest_sha256",
            "tag",
            "target_commitish",
        },
        "selection release",
    )
    assets = exact_object(
        release.get("assets"),
        {"closed-selection.json", "closed-selection.zip"},
        "selection release assets",
    )
    for name, value in assets.items():
        record = exact_object(
            value, {"bytes", "sha256"}, f"selection release asset {name}"
        )
        positive_integer(record.get("bytes"), f"selection release asset {name} bytes")
        if not isinstance(record.get("sha256"), str) or not SHA256.fullmatch(
            record["sha256"]
        ):
            raise ContractError(f"selection release asset {name} digest is invalid")

    roots = release.get("roots")
    if (
        not isinstance(roots, list)
        or not roots
        or any(
            not isinstance(root, str) or not FORMULA.fullmatch(root)
            for root in roots
        )
        or roots != sorted(set(roots))
    ):
        raise ContractError("selection release roots are invalid")
    formula_count = positive_integer(
        release.get("formula_count"), "selection release Formula count"
    )
    tag = release.get("tag")
    tag_match = SELECTION_TAG.fullmatch(tag) if isinstance(tag, str) else None
    if (
        formula_count < len(roots)
        or release.get("repository") != "kandelo-dev/homebrew-tap-core"
        or release.get("target_commitish") != tap_catalog
        or not isinstance(release.get("prepared_tree_git_oid"), str)
        or not SHA.fullmatch(release["prepared_tree_git_oid"])
        or not isinstance(release.get("selection_manifest_sha256"), str)
        or not SHA256.fullmatch(release["selection_manifest_sha256"])
        or tag_match is None
        or tag_match.group(1) != assets["closed-selection.json"]["sha256"]
    ):
        raise ContractError("selection release identity is not exact")


def require_artifact_inputs(source_root: pathlib.Path, value: Any) -> None:
    records = exact_object(value, set(ARTIFACT_INPUTS), "artifact lock inputs")
    for key, relative in ARTIFACT_INPUTS.items():
        expected = records[key]
        if (
            not isinstance(expected, str)
            or not SHA256.fullmatch(expected)
            or expected != sha256(regular_bytes(source_root, relative))
        ):
            raise ContractError(f"artifact lock input {key} is not exact")


def require_artifact(source_root: pathlib.Path, value: Any) -> None:
    artifact = exact_object(
        value,
        {"image", "inputs", "kind", "schema", "source_date_epoch", "state"},
        "lazy artifact lock",
    )
    require_artifact_inputs(source_root, artifact.get("inputs"))
    image = exact_object(
        artifact.get("image"), {"bytes", "sha256"}, "lazy artifact image"
    )
    if (
        artifact.get("schema") != 3
        or artifact.get("kind") != "kandelo-homebrew-lazy-shell-artifact-lock"
        or artifact.get("source_date_epoch") != 0
        or artifact.get("state") != "sealed"
        or not isinstance(image.get("sha256"), str)
        or not SHA256.fullmatch(image["sha256"])
    ):
        raise ContractError("lazy artifact lock is not sealed to exact image bytes")
    positive_integer(image.get("bytes"), "lazy artifact image byte count")


def require_catalog(value: Any, expected: str, label: str) -> None:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("catalog"), dict)
        or value["catalog"].get("tap_commit") != expected
    ):
        raise ContractError(f"{label} does not pin the exact tap catalog")


def positive_revision(value: Any, label: str) -> int:
    return positive_integer(value, label)


def check(source_root: pathlib.Path, tap_catalog: str, canary: str) -> None:
    try:
        root_metadata = source_root.lstat()
    except OSError as error:
        raise ContractError("source root is not readable") from error
    if not stat.S_ISDIR(root_metadata.st_mode) or source_root.is_symlink():
        raise ContractError("source root must be a regular directory")
    if not SHA.fullmatch(tap_catalog) or not SHA.fullmatch(canary):
        raise ContractError("tap catalog and canary must be exact commit SHAs")

    try:
        build = tomllib.loads(
            regular_bytes(source_root, "packages/registry/shell/build.toml").decode()
        )
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ContractError("shell build.toml is not valid UTF-8 TOML") from error

    # WHY: kandelo-ref already binds this file to one reviewed source commit,
    # while the sealed artifact lock binds the bytes fetched for its package
    # identity. Validate the revision's package-schema shape here rather than
    # duplicating today's number and rejecting the next reviewed generation.
    positive_revision(build.get("revision"), "shell build.toml revision")
    if (
        build.get("repo_url") != "https://github.com/Automattic/kandelo.git"
        or build.get("commit") != "UNPUBLISHED"
        or build.get("publication_state") != "ready"
        # WHY: the immutable closed selection is the package's one Formula
        # authority. A raw tap Git input beside it could compose different
        # source-only bytes than the public selection used by runtime proofs.
        or build.get("git_inputs") is not None
    ):
        raise ContractError("shell build.toml release identity is not exact")

    migration = json_without_duplicate_keys(
        regular_bytes(source_root, "homebrew/main-shell-migration-lock.json"),
        "migration lock",
    )
    support = json_without_duplicate_keys(
        regular_bytes(
            source_root, "homebrew/main-shell-homebrew-runtime-support.json"
        ),
        "runtime support",
    )
    selection = json_without_duplicate_keys(
        regular_bytes(source_root, "homebrew/main-shell-selection-lock.json"),
        "selection lock",
    )
    artifact = json_without_duplicate_keys(
        regular_bytes(source_root, "homebrew/main-shell-lazy-artifact-lock.json"),
        "lazy artifact lock",
    )
    require_catalog(migration, tap_catalog, "migration lock")
    require_catalog(support, tap_catalog, "runtime support")
    require_selection(source_root, selection, tap_catalog)

    installs = support.get("lifecycle_installs") if isinstance(support, dict) else None
    if (
        not isinstance(installs, list)
        or installs
        != [
            {
                "tap": "brandonpayton/kandelo-canary",
                "repository": "brandonpayton/homebrew-kandelo-canary",
                "revision": canary,
                "formula": "m4-canary",
                "phase": "guest-lifecycle",
                "image_closure": False,
                "reason": (
                    "The independent tap is proof of live third-party installation, "
                    "not a trusted base-image input."
                ),
            }
        ]
    ):
        raise ContractError("runtime support does not bind the exact canary lifecycle")

    require_artifact(source_root, artifact)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--tap-catalog-ref", required=True)
    parser.add_argument("--canary-ref", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        # Preserve the caller-provided path for lstat: resolving first would
        # silently turn a rejected symlink root into its target directory.
        check(args.source_root, args.tap_catalog_ref, args.canary_ref)
    except ContractError as error:
        print(f"check-homebrew-main-shell-release-locks: {error}", file=sys.stderr)
        return 1
    print("check-homebrew-main-shell-release-locks: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
