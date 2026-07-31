#!/usr/bin/env python3
"""Validate the exact sealed shell inputs consumed by mirror publication."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import stat
import sys
import tomllib
from typing import Any


SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MAX_CONTRACT_BYTES = 4 * 1024 * 1024


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


def require_catalog(value: Any, expected: str, label: str) -> None:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("catalog"), dict)
        or value["catalog"].get("tap_commit") != expected
    ):
        raise ContractError(f"{label} does not pin the exact tap catalog")


def positive_revision(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ContractError(f"{label} must be a positive integer")
    return value


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

    # WHY: the top-level UNPUBLISHED marker names this source recipe, whereas
    # the nested Git input names the detached tap catalog used to build it.
    # Treating both `commit` fields as an unstructured grep can validate the
    # wrong owner and silently publish against a different catalog.
    expected_git_inputs = [
        {
            "name": "homebrew_tap_core",
            "repository": "https://github.com/Kandelo-dev/homebrew-tap-core.git",
            "commit": tap_catalog,
        }
    ]
    # WHY: kandelo-ref already binds this file to one reviewed source commit,
    # while the sealed artifact lock binds the bytes fetched for its package
    # identity. Validate the revision's package-schema shape here rather than
    # duplicating today's number and rejecting the next reviewed generation.
    positive_revision(build.get("revision"), "shell build.toml revision")
    if (
        build.get("repo_url") != "https://github.com/Automattic/kandelo.git"
        or build.get("commit") != "UNPUBLISHED"
        or build.get("publication_state") != "ready"
        or build.get("git_inputs") != expected_git_inputs
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
    artifact = json_without_duplicate_keys(
        regular_bytes(source_root, "homebrew/main-shell-lazy-artifact-lock.json"),
        "lazy artifact lock",
    )
    require_catalog(migration, tap_catalog, "migration lock")
    require_catalog(support, tap_catalog, "runtime support")

    installs = support.get("lifecycle_installs") if isinstance(support, dict) else None
    if (
        not isinstance(installs, list)
        or installs
        != [
            {
                "tap": "brandonpayton/kandelo-canary",
                "repository": "brandonpayton/homebrew-kandelo-canary",
                "revision": canary,
                "formula": "m4",
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

    image = artifact.get("image") if isinstance(artifact, dict) else None
    if (
        artifact.get("state") != "sealed"
        or not isinstance(image, dict)
        or not SHA256.fullmatch(image.get("sha256", ""))
        or not isinstance(image.get("bytes"), int)
        or isinstance(image.get("bytes"), bool)
        or image["bytes"] < 1
    ):
        raise ContractError("lazy artifact lock is not sealed to exact image bytes")


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
