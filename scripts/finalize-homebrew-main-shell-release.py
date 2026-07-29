#!/usr/bin/env python3
"""Refresh the reviewed main-shell locks from one exact final tap checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import tomllib
from typing import Any


TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core"
TAP_NAME = "kandelo-dev/tap-core"
TAP_URL = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
MAX_INPUT_BYTES = 4 * 1024 * 1024
EXPECTED_ROOTS = 32
EXPECTED_BASE_FORMULAE = 38
EXPECTED_EMBEDDED = 3
EXPECTED_LAZY = 35
EXPECTED_RUNTIME_EXTRA = 1
EXPECTED_TOTAL = 39

MIGRATION_PATH = "homebrew/main-shell-migration-lock.json"
SUPPORT_PATH = "homebrew/main-shell-homebrew-runtime-support.json"
ARTIFACT_PATH = "homebrew/main-shell-lazy-artifact-lock.json"
BUILD_PATH = "packages/registry/shell/build.toml"
DOC_PATH = "docs/homebrew-publishing.md"
BREWFILE_PATH = "homebrew/main-shell.Brewfile"
BOUND_INPUTS = {
    "bootstrap_source_lock_sha256": "homebrew/homebrew-bootstrap-source-lock.json",
    "bootstrap_tree_spec_sha256": "homebrew/main-shell-brew-package-tree.json",
    "brewfile_sha256": BREWFILE_PATH,
    "demo_config_sha256": "homebrew/main-shell-demo.json",
    "materialization_policy_sha256": "homebrew/main-shell-materialization-policy.json",
    "migration_lock_sha256": MIGRATION_PATH,
    "runtime_support_sha256": SUPPORT_PATH,
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
        or set(value) != {
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
    return head, metadata_bytes, tap


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


def update_build_toml(value: bytes, old_tap: str, new_tap: str, sealed: bool) -> bytes:
    try:
        text = value.decode()
    except UnicodeDecodeError as error:
        raise FinalizeError(f"{BUILD_PATH} is not UTF-8") from error
    block = re.compile(
        r'(\[\[git_inputs\]\]\n'
        r'name = "homebrew_tap_core"\n'
        r'repository = "https://github\.com/Kandelo-dev/homebrew-tap-core\.git"\n'
        r'commit = ")'
        + re.escape(old_tap)
        + r'("\n)'
    )
    text, count = block.subn(rf"\g<1>{new_tap}\g<2>", text)
    if count != 1:
        raise FinalizeError(
            f"{BUILD_PATH} does not contain one exact old core-tap Git input"
        )
    expected_state = "ready" if sealed else "pending"
    text, count = re.subn(
        r'^publication_state = "(?:ready|pending)"$',
        f'publication_state = "{expected_state}"',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise FinalizeError(f"{BUILD_PATH} lacks one publication_state")
    try:
        build = tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise FinalizeError(f"{BUILD_PATH} became invalid TOML") from error
    if (
        build.get("commit") != "UNPUBLISHED"
        or build.get("revision") != 22
        or build.get("publication_state") != expected_state
        or build.get("git_inputs")
        != [
            {
                "name": "homebrew_tap_core",
                "repository": TAP_URL,
                "commit": new_tap,
            }
        ]
    ):
        raise FinalizeError(f"{BUILD_PATH} release identity is not exact")
    return text.encode()


def update_docs(value: bytes, old_tap: str, new_tap: str) -> bytes:
    try:
        text = value.decode()
    except UnicodeDecodeError as error:
        raise FinalizeError(f"{DOC_PATH} is not UTF-8") from error
    old = f"The checked-in `{old_tap}` first-party tap value"
    new = f"The checked-in `{new_tap}` first-party tap value"
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


def prepare(
    source_root: pathlib.Path,
    tap_root: pathlib.Path,
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
        for path in [MIGRATION_PATH, SUPPORT_PATH, ARTIFACT_PATH, BUILD_PATH, DOC_PATH]
    }
    migration = exact_json(old[MIGRATION_PATH], "migration lock")
    support = exact_json(old[SUPPORT_PATH], "runtime support")
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

    final_tap, metadata_bytes, tap = require_tap_checkout(tap_root)
    packages = package_map(tap)
    roots = migration.get("packages")
    reviewed_closure = migration.get("formula_closure")
    materialization = exact_json(
        regular_bytes(source_root, "homebrew/main-shell-materialization-policy.json"),
        "materialization policy",
    )
    if (
        not isinstance(roots, list)
        or len(roots) != EXPECTED_ROOTS
        or not isinstance(reviewed_closure, list)
        or len(reviewed_closure) != EXPECTED_BASE_FORMULAE
        or not isinstance(materialization, dict)
        or len(materialization.get("embedded_package_order", [])) != EXPECTED_EMBEDDED
        or EXPECTED_BASE_FORMULAE - EXPECTED_EMBEDDED != EXPECTED_LAZY
        or len(support.get("additional_formula_order", [])) != EXPECTED_RUNTIME_EXTRA
        or EXPECTED_BASE_FORMULAE + EXPECTED_RUNTIME_EXTRA != EXPECTED_TOTAL
    ):
        raise FinalizeError(
            "main-shell scope drifted from 32 roots / embedded 3 / lazy 35 / "
            "runtime-extra 1 / total 39"
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
            "final tap dependency closure changes the reviewed 38-Formula scope; "
            f"missing={missing or '(none)'}, extra={extra or '(none)'}"
        )
    for identity in reviewed_closure:
        if (
            not isinstance(identity, str)
            or not identity.startswith(f"{TAP_NAME}/")
            or identity.split("/")[-1] not in packages
        ):
            raise FinalizeError(f"reviewed closure contains invalid Formula {identity!r}")
        require_bottle(packages[identity.split("/")[-1]])

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
        tap_root / "Kandelo/metadata.json", provisional_support
    )

    migration_bytes = json_bytes(migration)
    support_bytes = json_bytes(support)
    checker_output = validate_with_canonical_checker(
        source_root,
        tap_root / "Kandelo/metadata.json",
        migration_bytes,
        support_bytes,
    )

    sealed = artifact_file is not None
    build_bytes = update_build_toml(old[BUILD_PATH], old_tap, final_tap, sealed)
    docs_bytes = update_docs(old[DOC_PATH], old_tap, final_tap)
    staged: dict[str, bytes] = {
        MIGRATION_PATH: migration_bytes,
        SUPPORT_PATH: support_bytes,
        BUILD_PATH: build_bytes,
        DOC_PATH: docs_bytes,
    }

    bound_values: dict[str, str] = {}
    for key, relative in BOUND_INPUTS.items():
        if relative == MIGRATION_PATH:
            value = migration_bytes
        elif relative == SUPPORT_PATH:
            value = support_bytes
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
        "roots": EXPECTED_ROOTS,
        "base_formulae": EXPECTED_BASE_FORMULAE,
        "embedded": EXPECTED_EMBEDDED,
        "lazy": EXPECTED_LAZY,
        "runtime_extra": EXPECTED_RUNTIME_EXTRA,
        "total": EXPECTED_TOTAL,
        "artifact_state": artifact_lock["state"],
        "artifact": artifact_lock["image"],
        "checker": checker_output,
        "changed_paths": sorted(staged),
    }
    return staged, summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=pathlib.Path, required=True)
    parser.add_argument("--tap-root", type=pathlib.Path, required=True)
    parser.add_argument(
        "--artifact",
        type=pathlib.Path,
        help="seal the refreshed lock to these independently reproduced bytes",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="replace the five reviewed files; otherwise print a read-only preview",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        staged, summary = prepare(args.source_root, args.tap_root, args.artifact)
        if args.apply:
            # WHY: pending publication state is written first when invalidating
            # an old seal, while ready is written last when installing a new
            # one. A host interruption can therefore leave an inconsistent
            # checkout, but never a partially refreshed checkout that still
            # advertises itself as publishable.
            if summary["artifact_state"] == "pending":
                order = [
                    BUILD_PATH,
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
                    BUILD_PATH,
                ]
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
