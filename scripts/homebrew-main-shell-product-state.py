#!/usr/bin/env python3
"""Classify the checked-in main-shell product publication state."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import tomllib
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_CONTRACT_BYTES = 16 * 1024 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ProductStateError(RuntimeError):
    """The checked-in product contracts do not form one valid state."""


def fail(message: str) -> NoReturn:
    raise ProductStateError(message)


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            fail(f"JSON repeats key {key!r}")
        value[key] = item
    return value


def regular_text(path: pathlib.Path, label: str) -> str:
    try:
        metadata = path.lstat()
        if (
            not path.is_file()
            or path.is_symlink()
            or metadata.st_size < 1
            or metadata.st_size > MAX_CONTRACT_BYTES
        ):
            fail(f"{label} must be one bounded regular non-symlink file")
        return path.read_text(encoding="utf-8")
    except ProductStateError:
        raise
    except (OSError, UnicodeDecodeError) as error:
        fail(f"cannot read {label}: {error}")


def load_json(path: pathlib.Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            regular_text(path, label),
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except ProductStateError:
        raise
    except json.JSONDecodeError as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def load_toml(path: pathlib.Path, label: str) -> dict[str, Any]:
    try:
        value = tomllib.loads(regular_text(path, label))
    except ProductStateError:
        raise
    except tomllib.TOMLDecodeError as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must be a TOML table")
    return value


def classify(root: pathlib.Path) -> str:
    selection = load_json(
        root / "homebrew/main-shell-selection-lock.json",
        "main-shell selection lock",
    )
    artifact = load_json(
        root / "homebrew/main-shell-lazy-artifact-lock.json",
        "main-shell artifact lock",
    )
    build = load_toml(
        root / "packages/registry/shell/build.toml",
        "shell build contract",
    )
    package = load_toml(
        root / "packages/registry/shell/package.toml",
        "shell package contract",
    )

    if (
        set(selection)
        != {"arch", "inputs", "kind", "release", "schema", "state"}
        or selection.get("schema") != 1
        or selection.get("kind")
        != "kandelo-homebrew-main-shell-closed-selection-lock"
        or selection.get("arch") != "wasm32"
    ):
        fail("main-shell selection lock has an unsupported contract")
    artifact_inputs = artifact.get("inputs")
    if not isinstance(artifact_inputs, dict):
        fail("main-shell artifact lock has unsupported inputs")
    if (
        set(artifact)
        != {"image", "inputs", "kind", "schema", "source_date_epoch", "state"}
        or set(artifact_inputs)
        != {
            "bootstrap_tree_spec_sha256",
            "brewfile_sha256",
            "demo_config_sha256",
            "materialization_policy_sha256",
            "migration_lock_sha256",
            "runtime_support_sha256",
            "selection_lock_sha256",
            "shell_config_sha256",
        }
        or any(
            not isinstance(digest, str) or SHA256.fullmatch(digest) is None
            for digest in artifact_inputs.values()
        )
        or artifact.get("schema") != 3
        or artifact.get("kind")
        != "kandelo-homebrew-lazy-shell-artifact-lock"
        or artifact.get("source_date_epoch") != 0
    ):
        fail("main-shell artifact lock has an unsupported contract")
    if (
        build.get("commit") != "UNPUBLISHED"
        or not isinstance(build.get("revision"), int)
        or isinstance(build.get("revision"), bool)
        or build["revision"] < 1
        or build.get("git_inputs") is not None
    ):
        fail("shell build contract has unsupported publication inputs")
    if package.get("depends_on") != []:
        fail("shell package must not depend on transitional registry packages")

    triple = (
        selection.get("state"),
        artifact.get("state"),
        build.get("publication_state"),
    )
    states = {
        ("pending", "pending", "pending"): "awaiting-selection",
        ("sealed", "pending", "pending"): "candidate",
        ("sealed", "sealed", "ready"): "publishable",
    }
    state = states.get(triple)
    if state is None:
        fail(
            "selection, artifact, and package publication states disagree: "
            f"{triple!r}"
        )
    if state == "awaiting-selection" and selection.get("release") is not None:
        fail("pending selection lock must not name a release")
    if state != "awaiting-selection" and not isinstance(
        selection.get("release"), dict
    ):
        fail("sealed selection lock must name its immutable release")
    if state == "publishable" and not isinstance(artifact.get("image"), dict):
        fail("sealed artifact lock must name its image")
    if state != "publishable" and artifact.get("image") is not None:
        fail("pending artifact lock must not name an image")
    return state


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=ROOT)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        print(classify(pathlib.Path(arguments.root)))
    except ProductStateError as error:
        print(f"homebrew-main-shell-product-state: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
