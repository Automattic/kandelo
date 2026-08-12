#!/usr/bin/env python3
"""Refresh main-shell locks from a live tap or sealed closed selection."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any


TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
MAX_INPUT_BYTES = 4 * 1024 * 1024
MAX_SELECTION_RECEIPT_BYTES = 64 * 1024 * 1024
EXPECTED_EMBEDDED = 3

MIGRATION_PATH = "homebrew/main-shell-migration-lock.json"
SUPPORT_PATH = "homebrew/main-shell-homebrew-runtime-support.json"
SELECTION_PATH = "homebrew/main-shell-selection-lock.json"
ARTIFACT_PATH = "homebrew/main-shell-lazy-artifact-lock.json"
DOC_PATH = "docs/homebrew-publishing.md"
BREWFILE_PATH = "homebrew/main-shell.Brewfile"
BOUND_INPUTS = {
    "bootstrap_tree_spec_sha256": "homebrew/main-shell-brew-package-tree.json",
    "brewfile_sha256": BREWFILE_PATH,
    "demo_config_sha256": "homebrew/main-shell-demo.json",
    "materialization_policy_sha256": "homebrew/main-shell-materialization-policy.json",
    "migration_lock_sha256": MIGRATION_PATH,
    "runtime_support_sha256": SUPPORT_PATH,
    "selection_lock_sha256": SELECTION_PATH,
    "shell_config_sha256": "homebrew/main-shell-default.json",
}


class FinalizeError(RuntimeError):
    pass


def exact_json(value: bytes, label: str) -> Any:
    def object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise FinalizeError(f"{label} repeats JSON key {key!r}")
            result[key] = item
        return result

    try:
        return json.loads(value, object_pairs_hook=object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FinalizeError(f"{label} is not valid UTF-8 JSON") from error


def regular_bytes(root: pathlib.Path, relative: str) -> bytes:
    path = root / relative
    try:
        metadata = path.lstat()
    except OSError as error:
        raise FinalizeError(f"{relative} is not readable") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size < 1
        or metadata.st_size > MAX_INPUT_BYTES
    ):
        raise FinalizeError(f"{relative} is not one bounded regular file")
    return path.read_bytes()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def require_artifact_lock(value: Any) -> dict[str, Any]:
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schema",
            "kind",
            "source_date_epoch",
            "state",
            "inputs",
            "image",
        }
        or value.get("schema") != 3
        or value.get("kind") != "kandelo-homebrew-lazy-shell-artifact-lock"
        or not isinstance(value.get("source_date_epoch"), int)
        or isinstance(value["source_date_epoch"], bool)
        or value.get("source_date_epoch") != 0
        or not isinstance(value.get("inputs"), dict)
        or set(value["inputs"]) != set(BOUND_INPUTS)
        or any(
            not isinstance(digest, str) or not SHA256.fullmatch(digest)
            for digest in value["inputs"].values()
        )
    ):
        raise FinalizeError("artifact lock is not the exact schema-3 contract")
    image = value.get("image")
    if value.get("state") == "pending" and image is None:
        return value
    if (
        value.get("state") == "sealed"
        and isinstance(image, dict)
        and set(image) == {"sha256", "bytes"}
        and isinstance(image.get("sha256"), str)
        and SHA256.fullmatch(image["sha256"])
        and isinstance(image.get("bytes"), int)
        and not isinstance(image["bytes"], bool)
        and image["bytes"] > 0
    ):
        return value
    raise FinalizeError("artifact lock has an invalid publication state")


def run_git(tap_root: pathlib.Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", os.fspath(tap_root), *arguments],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise FinalizeError(
            f"tap checkout Git command failed: git {' '.join(arguments)}"
        ) from error
    return result.stdout.strip()


def require_tap_checkout(tap_root: pathlib.Path) -> tuple[str, bytes, dict[str, Any]]:
    try:
        metadata = tap_root.lstat()
    except OSError as error:
        raise FinalizeError("tap root is not readable") from error
    if not stat.S_ISDIR(metadata.st_mode) or tap_root.is_symlink():
        raise FinalizeError("tap root must be one non-symlink Git checkout")
    head = run_git(tap_root, "rev-parse", "HEAD")
    if not SHA.fullmatch(head):
        raise FinalizeError("tap checkout HEAD is not one exact commit")
    if run_git(tap_root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise FinalizeError("tap checkout must be clean")
    metadata_bytes = regular_bytes(tap_root, "Kandelo/metadata.json")
    return head, metadata_bytes, require_tap_metadata(metadata_bytes)


def require_tap_metadata(metadata_bytes: bytes) -> dict[str, Any]:
    tap = exact_json(metadata_bytes, "tap metadata")
    if (
        not isinstance(tap, dict)
        or tap.get("schema") != 1
        or tap.get("tap_repository") != TAP_REPOSITORY
        or tap.get("tap_name") != TAP_NAME
        or not SHA.fullmatch(tap.get("tap_commit", ""))
        or not SHA.fullmatch(tap.get("kandelo_commit", ""))
        or tap.get("kandelo_abi") != 42
        or tap.get("release_tag") != "bottles-abi-v42"
        or not isinstance(tap.get("packages"), list)
    ):
        raise FinalizeError("tap metadata is not the exact ABI-42 core-tap catalog")
    return tap


def package_map(tap: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for index, package in enumerate(tap["packages"]):
        if (
            not isinstance(package, dict)
            or not FORMULA.fullmatch(package.get("name", ""))
            or package.get("full_name") != f"{TAP_NAME}/{package.get('name', '')}"
            or not isinstance(package.get("version"), str)
            or not isinstance(package.get("formula_revision"), int)
            or isinstance(package.get("formula_revision"), bool)
            or package["formula_revision"] < 0
            or not isinstance(package.get("bottle_rebuild"), int)
            or isinstance(package.get("bottle_rebuild"), bool)
            or package["bottle_rebuild"] < 0
            or not isinstance(package.get("dependencies"), list)
            or not isinstance(package.get("bottles"), list)
        ):
            raise FinalizeError(
                f"tap metadata package {index} is not a canonical Formula record"
            )
        name = package["name"]
        if name in result:
            raise FinalizeError(f"tap metadata repeats Formula {name}")
        result[name] = package
    return result


def dependencies(package: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for dependency in package["dependencies"]:
        if (
            not isinstance(dependency, dict)
            or not FORMULA.fullmatch(dependency.get("name", ""))
            or dependency.get("full_name", f"{TAP_NAME}/{dependency.get('name', '')}")
            != f"{TAP_NAME}/{dependency.get('name', '')}"
        ):
            raise FinalizeError(
                f"Formula {package['name']} has a non-canonical dependency"
            )
        name = dependency["name"]
        if name in result:
            raise FinalizeError(
                f"Formula {package['name']} repeats dependency {name}"
            )
        result.append(name)
    return result


def closure(root_names: list[str], packages: dict[str, dict[str, Any]]) -> list[str]:
    result: list[str] = []
    state: dict[str, str] = {}
    stack: list[str] = []

    def visit(name: str) -> None:
        if state.get(name) == "done":
            return
        if state.get(name) == "visiting":
            raise FinalizeError(
                f"tap metadata dependency cycle: {' -> '.join([*stack, name])}"
            )
        package = packages.get(name)
        if package is None:
            raise FinalizeError(f"tap metadata is missing Formula {name}")
        state[name] = "visiting"
        stack.append(name)
        for dependency in dependencies(package):
            visit(dependency)
        stack.pop()
        state[name] = "done"
        result.append(f"{TAP_NAME}/{name}")

    for root in root_names:
        visit(root)
    return result


def formula_identities(value: Any, label: str) -> list[str]:
    if not isinstance(value, list):
        raise FinalizeError(f"{label} must be an array")
    result: list[str] = []
    for index, identity in enumerate(value):
        if (
            not isinstance(identity, str)
            or not identity.startswith(f"{TAP_NAME}/")
            or not FORMULA.fullmatch(identity.removeprefix(f"{TAP_NAME}/"))
        ):
            raise FinalizeError(
                f"{label}[{index}] is not a canonical {TAP_NAME}/<formula> identity"
            )
        if identity in result:
            raise FinalizeError(f"{label} repeats Formula {identity}")
        result.append(identity)
    return result


def base_version(package: dict[str, Any]) -> str:
    revision = package["formula_revision"]
    version = package["version"]
    if revision == 0:
        if not version:
            raise FinalizeError(f"Formula {package['name']} has an empty version")
        return version
    suffix = f"_{revision}"
    if not version.endswith(suffix) or len(version) == len(suffix):
        raise FinalizeError(
            f"Formula {package['name']} version {version!r} does not encode "
            f"revision {revision}"
        )
    return version[: -len(suffix)]


def require_bottle(package: dict[str, Any]) -> None:
    bottles = [
        bottle
        for bottle in package["bottles"]
        if isinstance(bottle, dict) and bottle.get("arch") == "wasm32"
    ]
    if len(bottles) != 1:
        raise FinalizeError(
            f"Formula {package['name']} has {len(bottles)} wasm32 bottles; expected one"
        )
    bottle = bottles[0]
    digest = bottle.get("sha256", "")
    built_from = bottle.get("built_from")
    if (
        bottle.get("status") != "success"
        or bottle.get("bottle_tag") != "wasm32_kandelo"
        or bottle.get("kandelo_abi") != 42
        or not isinstance(bottle.get("bytes"), int)
        or isinstance(bottle.get("bytes"), bool)
        or bottle["bytes"] < 1
        or not SHA256.fullmatch(digest)
        or bottle.get("cache_key_sha") != digest
        or bottle.get("url")
        != f"https://ghcr.io/v2/{TAP_REPOSITORY}/{package['name']}/blobs/sha256:{digest}"
        or not isinstance(bottle.get("runtime_support"), list)
        or "node" not in bottle["runtime_support"]
        or not isinstance(built_from, dict)
        or built_from.get("tap_repository") != TAP_REPOSITORY
        or built_from.get("kandelo_repository") != "Automattic/kandelo"
        or not SHA.fullmatch(built_from.get("tap_commit", ""))
        or not SHA.fullmatch(built_from.get("kandelo_commit", ""))
        or not SHA256.fullmatch(built_from.get("formula_sha256", ""))
    ):
        raise FinalizeError(
            f"Formula {package['name']} lacks one admitted public wasm32 ABI-42 bottle"
        )


def update_docs(value: bytes, old_tap: str, new_tap: str) -> bytes:
    try:
        text = value.decode()
    except UnicodeDecodeError as error:
        raise FinalizeError(f"{DOC_PATH} is not UTF-8") from error
    old = f"The checked-in `{old_tap}` tap value"
    new = f"The checked-in `{new_tap}` tap value"
    if text.count(old) != 1:
        raise FinalizeError(
            f"{DOC_PATH} does not name the old catalog exactly once"
        )
    return text.replace(old, new).encode()


def validate_with_canonical_checker(
    source_root: pathlib.Path,
    metadata_path: pathlib.Path,
    migration_bytes: bytes,
    support_bytes: bytes,
) -> str:
    checker = pathlib.Path(__file__).with_name(
        "check-homebrew-main-shell-brewfile.mjs"
    )
    if not checker.is_file() or checker.is_symlink():
        raise FinalizeError("canonical main-shell checker is unavailable")
    with tempfile.TemporaryDirectory(prefix="kandelo-shell-finalize.") as temporary:
        root = pathlib.Path(temporary)
        migration = root / "migration.json"
        support = root / "support.json"
        migration.write_bytes(migration_bytes)
        support.write_bytes(support_bytes)
        try:
            result = subprocess.run(
                [
                    "node",
                    os.fspath(checker),
                    os.fspath(source_root / BREWFILE_PATH),
                    os.fspath(migration),
                    os.fspath(metadata_path),
                    os.fspath(support),
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            detail = (
                error.stderr.strip()
                if isinstance(error, subprocess.CalledProcessError)
                else str(error)
            )
            raise FinalizeError(
                f"canonical main-shell checker rejected the refreshed locks: {detail}"
            ) from error
    return result.stdout.strip()


def runtime_provenance(
    metadata_path: pathlib.Path, support_bytes: bytes
) -> str:
    checker = pathlib.Path(__file__).with_name(
        "check-homebrew-main-shell-brewfile.mjs"
    )
    with tempfile.TemporaryDirectory(prefix="kandelo-shell-provenance.") as temporary:
        support = pathlib.Path(temporary) / "support.json"
        support.write_bytes(support_bytes)
        try:
            result = subprocess.run(
                [
                    "node",
                    os.fspath(checker),
                    "--print-runtime-bottle-provenance-sha256",
                    os.fspath(metadata_path),
                    os.fspath(support),
                ],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            detail = (
                error.stderr.strip()
                if isinstance(error, subprocess.CalledProcessError)
                else str(error)
            )
            raise FinalizeError(
                f"cannot derive the canonical runtime provenance digest: {detail}"
            ) from error
    digest = result.stdout.strip()
    if not SHA256.fullmatch(digest):
        raise FinalizeError("canonical runtime provenance helper returned an invalid digest")
    return digest


def load_selection_lock_module() -> Any:
    path = pathlib.Path(__file__).with_name(
        "homebrew-main-shell-selection-lock.py"
    )
    spec = importlib.util.spec_from_file_location(
        "homebrew_main_shell_selection_lock_for_finalizer",
        path,
    )
    if spec is None or spec.loader is None:
        raise FinalizeError("closed-selection verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def require_closed_selection(
    source_root: pathlib.Path,
    selection_root: pathlib.Path,
    receipt_path: pathlib.Path,
) -> dict[str, Any]:
    verifier = load_selection_lock_module()
    current_lock = exact_json(
        regular_bytes(source_root, SELECTION_PATH),
        "main-shell selection lock",
    )
    try:
        # WHY: the finalizer may replace a pending lock, but it must not use a
        # stale or hand-written predecessor as permission to change product
        # inputs. Validate the checked-in lock before deriving its successor.
        verifier.validate_lock(current_lock, source_root)
    except verifier.LockError as error:
        raise FinalizeError(
            f"checked-in closed-selection lock is invalid: {error}"
        ) from error
    executor = verifier.executor()
    try:
        selection, selection_payload, tap_root = (
            executor.load_selection_candidate(selection_root)
        )
        receipt, receipt_payload = verifier.load_json(
            receipt_path,
            "closed selection public readback receipt",
        )
        if receipt_payload != verifier.pretty_json(receipt):
            raise FinalizeError(
                "closed selection readback receipt is not canonical JSON"
            )
        receipt = verifier.validate_receipt(receipt)
    except FinalizeError:
        raise
    except (verifier.LockError, executor.ExecutorError) as error:
        raise FinalizeError(f"closed selection is invalid: {error}") from error

    metadata_path = tap_root / "Kandelo/metadata.json"
    metadata_bytes = regular_bytes(tap_root, "Kandelo/metadata.json")
    tap = require_tap_metadata(metadata_bytes)
    source_commit = selection.get("tap", {}).get("source_commit")
    if (
        not SHA.fullmatch(source_commit or "")
        or tap.get("tap_commit") != source_commit
        or receipt.get("target_commitish") != source_commit
    ):
        raise FinalizeError(
            "closed selection does not retain one exact source-tap authority"
        )
    return {
        "metadata_bytes": metadata_bytes,
        "metadata_path": metadata_path,
        "receipt": receipt,
        "selection": selection,
        "selection_payload": selection_payload,
        "selection_root": selection_root,
        "source_commit": source_commit,
        "tap": tap,
        "tap_root": tap_root,
        "verifier": verifier,
    }


def insert_dependency_order(
    existing: list[str], required: list[str]
) -> list[str]:
    result = list(existing)
    for position, identity in enumerate(required):
        if identity in result:
            continue
        later = next(
            (
                candidate
                for candidate in required[position + 1 :]
                if candidate in result
            ),
            None,
        )
        if later is not None:
            result.insert(result.index(later), identity)
            continue
        earlier = [
            result.index(candidate)
            for candidate in required[:position]
            if candidate in result
        ]
        result.insert(max(earlier) + 1 if earlier else len(result), identity)
    return result


def refresh_runtime_support(
    support: dict[str, Any],
    packages: dict[str, dict[str, Any]],
    reviewed_closure: list[str],
) -> None:
    roots = support.get("formula_roots")
    if not isinstance(roots, list) or not roots:
        raise FinalizeError("runtime support has no Formula roots")
    root_names: list[str] = []
    for index, entry in enumerate(roots):
        identity = entry.get("package") if isinstance(entry, dict) else None
        if (
            not isinstance(identity, str)
            or not identity.startswith(f"{TAP_NAME}/")
            or not FORMULA.fullmatch(identity.removeprefix(f"{TAP_NAME}/"))
        ):
            raise FinalizeError(
                f"runtime-support Formula root {index} is invalid"
            )
        root_names.append(identity.removeprefix(f"{TAP_NAME}/"))
    if len(set(root_names)) != len(root_names):
        raise FinalizeError("runtime-support Formula roots are duplicated")

    runtime_formulae = closure(root_names, packages)
    support["formula_order"] = runtime_formulae
    support["additional_formula_order"] = [
        identity
        for identity in runtime_formulae
        if identity not in reviewed_closure
    ]

    availability = support.get("availability")
    if not isinstance(availability, dict):
        raise FinalizeError("runtime support lacks its availability partition")
    reusable = formula_identities(
        availability.get("reusable_public_abi42"),
        "Homebrew runtime-support availability.reusable_public_abi42",
    )
    for key in ["requires_rebuild", "missing_metadata", "can_be_deferred"]:
        entries = formula_identities(
            availability.get(key),
            f"Homebrew runtime-support availability.{key}",
        )
        if entries:
            # WHY: a sealed product selection proves the bytes it contains;
            # it does not silently decide that an earlier unavailable or
            # deferred audit candidate has become product policy.
            raise FinalizeError(
                "closed-selection finalization requires the reviewed "
                f"availability.{key} partition to be empty"
            )
    reusable = insert_dependency_order(reusable, runtime_formulae)
    if len(set(reusable)) != len(reusable):
        raise FinalizeError(
            "Homebrew runtime-support reusable cohort repeats a Formula"
        )
    for identity in reusable:
        package = packages.get(identity.removeprefix(f"{TAP_NAME}/"))
        if package is None:
            raise FinalizeError(
                f"closed selection omits audited Formula {identity}"
            )
        require_bottle(package)
    availability["reusable_public_abi42"] = reusable


def selection_lock_inputs(
    *,
    source_root: pathlib.Path,
    verifier: Any,
    migration: dict[str, Any],
    migration_bytes: bytes,
    support: dict[str, Any],
    support_bytes: bytes,
) -> tuple[
    dict[str, tuple[dict[str, Any], bytes]],
    dict[str, dict[str, str]],
]:
    inputs: dict[str, tuple[dict[str, Any], bytes]] = {}
    records: dict[str, dict[str, str]] = {}
    for name, relative in verifier.INPUT_PATHS.items():
        if name == "migration_lock":
            value, payload = migration, migration_bytes
        elif name == "runtime_support":
            value, payload = support, support_bytes
        else:
            payload = regular_bytes(source_root, relative)
            value = {} if name == "brewfile" else exact_json(
                payload, f"main-shell {name}"
            )
        inputs[name] = (value, payload)
        records[name] = {
            "path": relative,
            "sha256": sha256(payload),
        }
    return inputs, records


def create_pending_selection_lock(
    *,
    source_root: pathlib.Path,
    migration: dict[str, Any],
    migration_bytes: bytes,
    support: dict[str, Any],
    support_bytes: bytes,
) -> bytes:
    verifier = load_selection_lock_module()
    try:
        # WHY: --tap-root is a review-only catalog refresh. Rebuilding the
        # pending lock keeps its input digests coherent with the refreshed
        # catalog while deliberately granting no immutable release authority.
        # It must also repair an intentionally edited input, so it does not
        # require the superseded pending lock to match that input first.
        inputs, records = selection_lock_inputs(
            source_root=source_root,
            verifier=verifier,
            migration=migration,
            migration_bytes=migration_bytes,
            support=support,
            support_bytes=support_bytes,
        )
        verifier.derive_roots_and_required_formulae(source_root, inputs)
    except verifier.LockError as error:
        raise FinalizeError(
            f"cannot refresh the pending closed-selection lock: {error}"
        ) from error
    return verifier.pretty_json(
        {
            "arch": "wasm32",
            "inputs": records,
            "kind": "kandelo-homebrew-main-shell-closed-selection-lock",
            "release": None,
            "schema": 1,
            "state": "pending",
        }
    )


def seal_selection_lock(
    *,
    source_root: pathlib.Path,
    migration: dict[str, Any],
    migration_bytes: bytes,
    support: dict[str, Any],
    support_bytes: bytes,
    selection_input: dict[str, Any],
) -> tuple[bytes, dict[str, Any]]:
    verifier = selection_input["verifier"]
    inputs, records = selection_lock_inputs(
        source_root=source_root,
        verifier=verifier,
        migration=migration,
        migration_bytes=migration_bytes,
        support=support,
        support_bytes=support_bytes,
    )
    lock = {
        "arch": "wasm32",
        "inputs": records,
        "kind": "kandelo-homebrew-main-shell-closed-selection-lock",
        "release": verifier.release_from_receipt(
            selection_input["receipt"]
        ),
        "schema": 1,
        "state": "sealed",
    }
    try:
        report = verifier.verify_selection(
            root=source_root,
            lock=lock,
            inputs=inputs,
            selection_root=selection_input["selection_root"],
            receipt=selection_input["receipt"],
            allow_pending=False,
        )
    except verifier.LockError as error:
        raise FinalizeError(
            f"closed selection does not match refreshed product inputs: {error}"
        ) from error
    return verifier.pretty_json(lock), report


def atomic_write(path: pathlib.Path, value: bytes) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise FinalizeError(f"refusing to replace non-regular file {path}")
    temporary = path.with_name(f".{path.name}.finalize-{os.getpid()}")
    if temporary.exists() or temporary.is_symlink():
        raise FinalizeError(f"temporary output already exists: {temporary}")
    try:
        temporary.write_bytes(value)
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def snapshot_closed_selection(
    selection_root: pathlib.Path,
    receipt_path: pathlib.Path,
    snapshot_root: pathlib.Path,
) -> tuple[pathlib.Path, pathlib.Path]:
    try:
        selection_metadata = selection_root.lstat()
    except OSError as error:
        raise FinalizeError("closed selection is not readable") from error
    if (
        not stat.S_ISDIR(selection_metadata.st_mode)
        or selection_root.is_symlink()
    ):
        raise FinalizeError(
            "closed selection must be one non-symlink directory"
        )

    stable_selection = snapshot_root / "selection"
    stable_receipt = snapshot_root / "selection-readback.json"
    try:
        # WHY: fetched release inputs are caller-owned local paths. Later
        # provenance and lock checks reopen their files, so consuming those
        # paths directly would permit an edit/restore race after validation.
        # Validate and consume only this one private, internally owned copy.
        shutil.copytree(selection_root, stable_selection, symlinks=True)
        flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
        )
        with os.fdopen(os.open(receipt_path, flags), "rb") as receipt:
            receipt_metadata = os.fstat(receipt.fileno())
            if (
                not stat.S_ISREG(receipt_metadata.st_mode)
                or receipt_metadata.st_size < 1
                or receipt_metadata.st_size > MAX_SELECTION_RECEIPT_BYTES
            ):
                raise FinalizeError(
                    "closed selection receipt is not one bounded regular file"
                )
            receipt_bytes = receipt.read(MAX_SELECTION_RECEIPT_BYTES + 1)
        if not receipt_bytes or len(receipt_bytes) > MAX_SELECTION_RECEIPT_BYTES:
            raise FinalizeError(
                "closed selection receipt is not one bounded regular file"
            )
        stable_receipt.write_bytes(receipt_bytes)
    except OSError as error:
        raise FinalizeError(
            "closed selection and receipt could not be snapshotted"
        ) from error
    return stable_selection, stable_receipt


def prepare(
    source_root: pathlib.Path,
    tap_root: pathlib.Path | None,
    selection_root: pathlib.Path | None,
    selection_receipt: pathlib.Path | None,
    artifact_file: pathlib.Path | None,
) -> tuple[dict[str, bytes], dict[str, Any]]:
    if tap_root is not None and artifact_file is not None:
        # WHY: a clean source tap proves reviewed catalog contents, but it is
        # not an immutable closed-selection release. Accepting artifact bytes
        # here would advertise a publishable shell without selection authority.
        raise FinalizeError(
            "--artifact requires --selection and --selection-receipt"
        )
    if selection_root is not None:
        assert selection_receipt is not None
        with tempfile.TemporaryDirectory(
            prefix="kandelo-shell-selection-inputs."
        ) as temporary:
            stable_selection, stable_receipt = snapshot_closed_selection(
                selection_root,
                selection_receipt,
                pathlib.Path(temporary),
            )
            return prepare_stable_inputs(
                source_root,
                tap_root,
                stable_selection,
                stable_receipt,
                artifact_file,
            )
    return prepare_stable_inputs(
        source_root,
        tap_root,
        selection_root,
        selection_receipt,
        artifact_file,
    )


def prepare_stable_inputs(
    source_root: pathlib.Path,
    tap_root: pathlib.Path | None,
    selection_root: pathlib.Path | None,
    selection_receipt: pathlib.Path | None,
    artifact_file: pathlib.Path | None,
) -> tuple[dict[str, bytes], dict[str, Any]]:
    try:
        source_metadata = source_root.lstat()
    except OSError as error:
        raise FinalizeError("source root is not readable") from error
    if not stat.S_ISDIR(source_metadata.st_mode) or source_root.is_symlink():
        raise FinalizeError("source root must be one non-symlink directory")

    old = {
        path: regular_bytes(source_root, path)
        for path in [
            MIGRATION_PATH,
            SUPPORT_PATH,
            SELECTION_PATH,
            ARTIFACT_PATH,
            DOC_PATH,
        ]
    }
    migration = exact_json(old[MIGRATION_PATH], "migration lock")
    support = exact_json(old[SUPPORT_PATH], "runtime support")
    provenance = (
        support.get("availability", {}).get("provenance")
        if isinstance(support, dict)
        else None
    )
    if (
        isinstance(provenance, dict)
        and provenance.get("provenance_kind") == "local-test"
    ):
        # WHY: the review-pending harness can prove local bytes, but neither a
        # clean tap nor a closed selection turns that evidence into release
        # authority. Reject it before reading tap/selection inputs or staging
        # any replacement lock bytes.
        raise FinalizeError(
            "local-test provenance is not promotable or selectable"
        )
    artifact_lock = require_artifact_lock(
        exact_json(old[ARTIFACT_PATH], "artifact lock")
    )
    if not isinstance(migration, dict) or not isinstance(support, dict):
        raise FinalizeError("main-shell migration and runtime-support locks must be objects")
    old_tap = migration.get("catalog", {}).get("tap_commit")
    if (
        not SHA.fullmatch(old_tap or "")
        or support.get("catalog", {}).get("tap_commit") != old_tap
        or support.get("availability", {})
        .get("audited_catalog", {})
        .get("checkout_commit")
        != old_tap
    ):
        raise FinalizeError("existing main-shell catalog locks disagree")

    closed_selection: dict[str, Any] | None = None
    if selection_root is not None:
        assert selection_receipt is not None
        closed_selection = require_closed_selection(
            source_root,
            selection_root,
            selection_receipt,
        )
        final_tap = closed_selection["source_commit"]
        metadata_bytes = closed_selection["metadata_bytes"]
        metadata_path = closed_selection["metadata_path"]
        tap = closed_selection["tap"]
    else:
        assert tap_root is not None
        final_tap, metadata_bytes, tap = require_tap_checkout(tap_root)
        metadata_path = tap_root / "Kandelo/metadata.json"
    packages = package_map(tap)
    roots = migration.get("packages")
    reviewed_closure = formula_identities(
        migration.get("formula_closure"), "main-shell reviewed closure"
    )
    materialization = exact_json(
        regular_bytes(source_root, "homebrew/main-shell-materialization-policy.json"),
        "materialization policy",
    )
    if not isinstance(roots, list) or not roots or not reviewed_closure:
        raise FinalizeError(
            "main-shell migration lock must contain roots and a reviewed closure"
        )
    if (
        not isinstance(materialization, dict)
        or set(materialization)
        != {"schema", "kind", "embedded_roots", "embedded_package_order"}
        or materialization.get("schema") != 1
        or materialization.get("kind")
        != "kandelo-homebrew-vfs-materialization-policy"
    ):
        raise FinalizeError("main-shell materialization policy is invalid")
    embedded_roots = formula_identities(
        materialization.get("embedded_roots"),
        "main-shell embedded roots",
    )
    embedded_formulae = formula_identities(
        materialization.get("embedded_package_order"),
        "main-shell embedded Formula order",
    )
    if len(embedded_formulae) != EXPECTED_EMBEDDED:
        raise FinalizeError(
            "main-shell materialization policy must embed exactly three Formulae; "
            f"found {len(embedded_formulae)}"
        )
    embedded_outside_base = sorted(set(embedded_formulae) - set(reviewed_closure))
    if embedded_outside_base:
        raise FinalizeError(
            "main-shell embedded Formulae are outside the reviewed base closure: "
            + ", ".join(embedded_outside_base)
        )

    root_names: list[str] = []
    for index, entry in enumerate(roots):
        formula = entry.get("formula") if isinstance(entry, dict) else None
        name = formula.get("name") if isinstance(formula, dict) else None
        if not FORMULA.fullmatch(name or "") or name in root_names:
            raise FinalizeError(f"migration root {index} is invalid or duplicated")
        package = packages.get(name)
        if package is None:
            raise FinalizeError(f"final tap metadata is missing shell root {name}")
        require_bottle(package)
        formula["version"] = base_version(package)
        formula["revision"] = package["formula_revision"]
        formula["bottle_rebuild"] = package["bottle_rebuild"]
        root_names.append(name)

    resolved = closure(root_names, packages)
    if set(resolved) != set(reviewed_closure) or len(resolved) != len(reviewed_closure):
        missing = sorted(set(reviewed_closure) - set(resolved))
        extra = sorted(set(resolved) - set(reviewed_closure))
        raise FinalizeError(
            "final tap dependency closure changes the reviewed main-shell scope; "
            f"missing={missing or '(none)'}, extra={extra or '(none)'}"
        )
    for identity in reviewed_closure:
        if identity.split("/")[-1] not in packages:
            raise FinalizeError(f"reviewed closure contains invalid Formula {identity!r}")
        require_bottle(packages[identity.split("/")[-1]])

    resolved_embedded = closure(
        [identity.removeprefix(f"{TAP_NAME}/") for identity in embedded_roots],
        packages,
    )
    if resolved_embedded != embedded_formulae:
        raise FinalizeError(
            "main-shell embedded Formula order is not the exact dependency closure "
            "of its reviewed roots"
        )

    if closed_selection is not None:
        # WHY: a closed selection owns the exact generated tap bytes that the
        # shell will consume. The clean source checkout owns review history,
        # but its source-only Formulae cannot reveal newly selected runtime
        # dependencies such as Ruby's libyaml dependency.
        refresh_runtime_support(support, packages, reviewed_closure)

    migration["catalog"]["tap_commit"] = final_tap
    support["catalog"]["tap_commit"] = final_tap
    audited = support.get("availability", {}).get("audited_catalog")
    if not isinstance(audited, dict):
        raise FinalizeError("runtime support lacks its audited catalog")
    audited["checkout_commit"] = final_tap
    audited["metadata_sha256"] = sha256(metadata_bytes)
    audited["metadata_tap_commit"] = tap["tap_commit"]
    audited["kandelo_commit"] = tap["kandelo_commit"]

    # WHY: aggregate metadata can mix unchanged bottles from older producers
    # with newly built bottles. Reuse the canonical projection helper instead
    # of replacing truthful per-bottle provenance with final catalog authority.
    provisional_support = json_bytes(support)
    audited["runtime_bottle_provenance_sha256"] = runtime_provenance(
        metadata_path, provisional_support
    )

    migration_bytes = json_bytes(migration)
    support_bytes = json_bytes(support)
    checker_output = validate_with_canonical_checker(
        source_root,
        metadata_path,
        migration_bytes,
        support_bytes,
    )

    selection_bytes: bytes
    selection_report: dict[str, Any] | None = None
    if closed_selection is not None:
        selection_bytes, selection_report = seal_selection_lock(
            source_root=source_root,
            migration=migration,
            migration_bytes=migration_bytes,
            support=support,
            support_bytes=support_bytes,
            selection_input=closed_selection,
        )
    else:
        selection_bytes = create_pending_selection_lock(
            source_root=source_root,
            migration=migration,
            migration_bytes=migration_bytes,
            support=support,
            support_bytes=support_bytes,
        )

    # WHY: these counts describe the reviewed descriptors that the canonical
    # checker just proved against tap metadata. Deriving them keeps a new
    # dependency from requiring an unrelated executable-code cardinality bump.
    runtime_formulae = formula_identities(
        support.get("formula_order"), "Homebrew runtime-support Formula order"
    )
    additional_formulae = formula_identities(
        support.get("additional_formula_order"),
        "Homebrew runtime-support additional Formula order",
    )
    availability = support.get("availability")
    if not isinstance(availability, dict):
        raise FinalizeError("runtime support lacks its availability partition")
    audited_formulae: list[str] = []
    for key in [
        "reusable_public_abi42",
        "requires_rebuild",
        "missing_metadata",
        "can_be_deferred",
    ]:
        audited_formulae.extend(
            formula_identities(
                availability.get(key), f"Homebrew runtime-support availability.{key}"
            )
        )
    if len(set(audited_formulae)) != len(audited_formulae):
        raise FinalizeError(
            "Homebrew runtime-support availability partition repeats a Formula"
        )
    total_formulae = [*reviewed_closure, *additional_formulae]
    if len(set(total_formulae)) != len(total_formulae):
        raise FinalizeError("Homebrew shell/runtime Formula union repeats a Formula")

    sealed = artifact_file is not None
    docs_bytes = update_docs(old[DOC_PATH], old_tap, final_tap)
    staged: dict[str, bytes] = {
        MIGRATION_PATH: migration_bytes,
        SUPPORT_PATH: support_bytes,
        SELECTION_PATH: selection_bytes,
        DOC_PATH: docs_bytes,
    }

    bound_values: dict[str, str] = {}
    for key, relative in BOUND_INPUTS.items():
        if relative == MIGRATION_PATH:
            value = migration_bytes
        elif relative == SUPPORT_PATH:
            value = support_bytes
        elif relative == SELECTION_PATH:
            value = selection_bytes
        else:
            value = regular_bytes(source_root, relative)
        bound_values[key] = sha256(value)
    artifact_lock["inputs"] = bound_values
    if sealed:
        assert artifact_file is not None
        try:
            artifact_metadata = artifact_file.lstat()
        except OSError as error:
            raise FinalizeError("reviewed shell artifact is not readable") from error
        if (
            not stat.S_ISREG(artifact_metadata.st_mode)
            or artifact_file.is_symlink()
            or artifact_metadata.st_size < 1
        ):
            raise FinalizeError("reviewed shell artifact must be one non-empty regular file")
        artifact_lock["state"] = "sealed"
        artifact_lock["image"] = {
            "sha256": sha256_file(artifact_file),
            "bytes": artifact_metadata.st_size,
        }
    else:
        artifact_lock["state"] = "pending"
        artifact_lock["image"] = None
    staged[ARTIFACT_PATH] = json_bytes(artifact_lock)

    summary = {
        "old_tap_commit": old_tap,
        "final_tap_commit": final_tap,
        "metadata_sha256": sha256(metadata_bytes),
        "metadata_tap_commit": tap["tap_commit"],
        "kandelo_commit": tap["kandelo_commit"],
        "roots": len(root_names),
        "base_formulae": len(reviewed_closure),
        "embedded": len(embedded_formulae),
        "lazy": len(reviewed_closure) - len(embedded_formulae),
        "runtime_formulae": len(runtime_formulae),
        "audited_formulae": len(audited_formulae),
        "runtime_extra": len(additional_formulae),
        "total": len(total_formulae),
        "artifact_state": artifact_lock["state"],
        "artifact": artifact_lock["image"],
        "checker": checker_output,
        "selection": selection_report,
        "changed_paths": sorted(staged),
    }
    return staged, summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument(
        "--tap-root",
        type=pathlib.Path,
        help="one clean final live-tap checkout",
    )
    inputs.add_argument(
        "--selection",
        type=pathlib.Path,
        help="one fetched immutable closed-selection directory",
    )
    parser.add_argument(
        "--selection-receipt",
        type=pathlib.Path,
        help="public readback receipt required with --selection",
    )
    parser.add_argument(
        "--artifact",
        type=pathlib.Path,
        help="seal the refreshed lock to these independently reproduced bytes",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="replace the reviewed files; otherwise print a read-only preview",
    )
    arguments = parser.parse_args()
    if (arguments.selection is None) != (
        arguments.selection_receipt is None
    ):
        parser.error("--selection and --selection-receipt must be used together")
    return arguments


def main() -> int:
    args = parse_args()
    try:
        staged, summary = prepare(
            args.source_root,
            args.tap_root,
            args.selection,
            args.selection_receipt,
            args.artifact,
        )
        if args.apply:
            # WHY: the legacy lock pair remains fail-closed across an
            # interruption. It no longer owns the canonical shell package's
            # publication state.
            if summary["artifact_state"] == "pending":
                order = [
                    ARTIFACT_PATH,
                    MIGRATION_PATH,
                    SUPPORT_PATH,
                    DOC_PATH,
                ]
            else:
                order = [
                    MIGRATION_PATH,
                    SUPPORT_PATH,
                    DOC_PATH,
                    ARTIFACT_PATH,
                ]
            # Any intermediate mix of old/new inputs and lock fails closed.
            # Put the pending or sealed selection beside its refreshed
            # authorities before the artifact identity is installed.
            position = order.index(SUPPORT_PATH) + 1
            order.insert(position, SELECTION_PATH)
            for relative in order:
                atomic_write(args.source_root / relative, staged[relative])
            summary["applied"] = True
        else:
            summary["applied"] = False
        print(json.dumps(summary, indent=2))
    except FinalizeError as error:
        print(f"finalize-homebrew-main-shell-release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
