#!/usr/bin/env python3
"""Classify the checked-in main-shell product publication state."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_CONTRACT_BYTES = 16 * 1024 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")
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
    "materialization_policy_sha256": (
        "homebrew/main-shell-materialization-policy.json"
    ),
    "migration_lock_sha256": "homebrew/main-shell-migration-lock.json",
    "runtime_support_sha256": (
        "homebrew/main-shell-homebrew-runtime-support.json"
    ),
    "selection_lock_sha256": "homebrew/main-shell-selection-lock.json",
    "shell_config_sha256": "homebrew/main-shell-default.json",
}


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


def regular_bytes(path: pathlib.Path, label: str) -> bytes:
    try:
        metadata = path.lstat()
        if (
            not path.is_file()
            or path.is_symlink()
            or metadata.st_size < 1
            or metadata.st_size > MAX_CONTRACT_BYTES
        ):
            fail(f"{label} must be one bounded regular non-symlink file")
        return path.read_bytes()
    except ProductStateError:
        raise
    except OSError as error:
        fail(f"cannot read {label}: {error}")


def regular_text(path: pathlib.Path, label: str) -> str:
    try:
        return regular_bytes(path, label).decode("utf-8")
    except UnicodeDecodeError as error:
        fail(f"cannot read {label}: {error}")


def digest(root: pathlib.Path, relative: str, label: str) -> str:
    return hashlib.sha256(regular_bytes(root / relative, label)).hexdigest()


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


def verify_selection_inputs(root: pathlib.Path, value: Any) -> None:
    if not isinstance(value, dict) or set(value) != set(SELECTION_INPUTS):
        fail("main-shell selection lock has unsupported inputs")
    for key, relative in SELECTION_INPUTS.items():
        record = value[key]
        if (
            not isinstance(record, dict)
            or set(record) != {"path", "sha256"}
            or record.get("path") != relative
            or not isinstance(record.get("sha256"), str)
            or SHA256.fullmatch(record["sha256"]) is None
        ):
            fail(f"main-shell selection input {key} is invalid")
        if record["sha256"] != digest(
            root, relative, f"main-shell selection input {key}"
        ):
            fail(f"main-shell selection input digest changed: {relative}")


def verify_artifact_inputs(root: pathlib.Path, value: Any) -> None:
    if not isinstance(value, dict) or set(value) != set(ARTIFACT_INPUTS):
        fail("main-shell artifact lock has unsupported inputs")
    for key, relative in ARTIFACT_INPUTS.items():
        expected = value[key]
        if (
            not isinstance(expected, str)
            or SHA256.fullmatch(expected) is None
        ):
            fail(f"main-shell artifact input {key} is invalid")
        if expected != digest(
            root, relative, f"main-shell artifact input {key}"
        ):
            fail(f"main-shell artifact input digest changed: {relative}")


def classify(root: pathlib.Path) -> str:
    selection = load_json(
        root / "homebrew/main-shell-selection-lock.json",
        "main-shell selection lock",
    )
    artifact = load_json(
        root / "homebrew/main-shell-lazy-artifact-lock.json",
        "main-shell artifact lock",
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
    verify_selection_inputs(root, selection.get("inputs"))
    artifact_inputs = artifact.get("inputs")
    verify_artifact_inputs(root, artifact_inputs)
    if (
        set(artifact)
        != {"image", "inputs", "kind", "schema", "source_date_epoch", "state"}
        or artifact.get("schema") != 3
        or artifact.get("kind")
        != "kandelo-homebrew-lazy-shell-artifact-lock"
        or artifact.get("source_date_epoch") != 0
    ):
        fail("main-shell artifact lock has an unsupported contract")
    pair = (
        selection.get("state"),
        artifact.get("state"),
    )
    states = {
        ("pending", "pending"): "awaiting-selection",
        ("sealed", "pending"): "candidate",
        ("sealed", "sealed"): "publishable",
    }
    state = states.get(pair)
    if state is None:
        fail(
            "selection and artifact publication states disagree: "
            f"{pair!r}"
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
