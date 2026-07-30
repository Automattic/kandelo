#!/usr/bin/env python3
"""Seal and read one Formula handoff in the Homebrew prefix campaign."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from typing import Any, NoReturn


ROOT = pathlib.Path(__file__).resolve().parent.parent
FORMULA = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
REPOSITORY = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})/"
    r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$"
)
COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
CAMPAIGN_TAG = re.compile(
    r"^homebrew-prefix-campaign-sha256-([0-9a-f]{64})$"
)
HANDOFF_TAG = re.compile(
    r"^homebrew-prefix-handoff-sha256-([0-9a-f]{64})$"
)
SAFE_PATH = re.compile(
    r"^[A-Za-z0-9_.+-]+(?:/[A-Za-z0-9_.+-]+)*$"
)
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
MAX_FORMULAE = 256
MAX_DEPENDENCIES = 256
MAX_RELEASE_ASSETS = 32
HTTP_TIMEOUT = 300
PUBLICATION_FILES = (
    "build/bottle.json",
    "build/bottle.tar.gz",
    "build/dependency-provenance.json",
    "build/manifest.json",
    "composition/sidecars-input.json",
    "receipt.json",
)


class ExecutorError(RuntimeError):
    """A fail-closed campaign handoff error."""


def fail(message: str) -> NoReturn:
    raise ExecutorError(message)


def duplicate_rejecting_object(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def pretty_json(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_keys(
    value: Any,
    expected: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(
    value: Any,
    label: str,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\0" in value
        or (pattern is not None and pattern.fullmatch(value) is None)
    ):
        fail(f"{label} is invalid")
    return value


def require_int(
    value: Any,
    label: str,
    minimum: int = 0,
    maximum: int | None = None,
) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < minimum
        or (maximum is not None and value > maximum)
    ):
        fail(f"{label} is invalid")
    return value


def regular_file(
    path: pathlib.Path,
    label: str,
    maximum: int = MAX_JSON_BYTES,
) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size < 1
        or metadata.st_size > maximum
    ):
        fail(f"{label} must be one bounded regular non-symlink file")
    return path


def real_directory(path: pathlib.Path, label: str) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except OSError as error:
        fail(f"{label} is unavailable: {error}")
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        fail(f"{label} must be a real non-symlink directory")
    return path.resolve()


def load_json_bytes(
    path: pathlib.Path,
    label: str,
    *,
    canonical: bool = True,
) -> tuple[Any, bytes]:
    payload = regular_file(path, label).read_bytes()
    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
            parse_constant=lambda item: fail(
                f"{label} contains invalid constant {item}"
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if canonical and payload != pretty_json(value):
        fail(f"{label} is not canonical pretty JSON")
    return value, payload


def safe_relative(value: Any, label: str) -> str:
    path = require_string(value, label, SAFE_PATH)
    if (
        pathlib.PurePosixPath(path).is_absolute()
        or any(part in (".", "..") for part in path.split("/"))
    ):
        fail(f"{label} is not a safe repository-relative path")
    return path


def resolved_candidate(path: pathlib.Path, label: str) -> pathlib.Path:
    candidate = path.resolve(strict=False)
    if path.exists() or path.is_symlink():
        fail(f"{label} already exists")
    parent = real_directory(path.parent, f"{label} parent")
    if candidate != parent / path.name:
        fail(f"{label} crosses an indirect parent")
    return candidate


def paths_overlap(left: pathlib.Path, right: pathlib.Path) -> bool:
    return (
        left == right
        or left in right.parents
        or right in left.parents
    )


def validate_new_output(
    output: pathlib.Path,
    label: str,
    inputs: Iterable[pathlib.Path],
) -> pathlib.Path:
    candidate = resolved_candidate(output, label)
    for input_path in inputs:
        resolved_input = input_path.resolve(strict=True)
        if paths_overlap(candidate, resolved_input):
            fail(f"{label} overlaps an input path")
    return candidate


def validate_output_pair(
    output: pathlib.Path,
    output_label: str,
    receipt: pathlib.Path,
    receipt_label: str,
    inputs: Iterable[pathlib.Path],
) -> tuple[pathlib.Path, pathlib.Path]:
    input_paths = tuple(inputs)
    if paths_overlap(
        output.resolve(strict=False),
        receipt.resolve(strict=False),
    ):
        fail(f"{output_label} and {receipt_label} overlap")
    output = validate_new_output(output, output_label, input_paths)
    receipt = validate_new_output(receipt, receipt_label, input_paths)
    if output.parent.stat().st_dev != receipt.parent.stat().st_dev:
        fail(f"{output_label} and {receipt_label} use different filesystems")
    return output, receipt


def private_destination(
    root: pathlib.Path,
    relative: str,
    label: str,
) -> pathlib.Path:
    root = real_directory(root, f"{label} root")
    relative = safe_relative(relative, label)
    destination = (root / relative).resolve(strict=False)
    try:
        destination.relative_to(root)
    except ValueError:
        fail(f"{label} escapes its private staging root")
    if destination.exists() or destination.is_symlink():
        fail(f"{label} repeats a staged path")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.parent.resolve() != (root / relative).parent.resolve():
        fail(f"{label} crosses an indirect staging parent")
    return destination


def git_object_id(kind: str, payload: bytes) -> str:
    header = f"{kind} {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()


def filesystem_git_tree_oid(root: pathlib.Path, label: str) -> str:
    root = real_directory(root, label)

    def visit(directory: pathlib.Path) -> bytes:
        entries: list[tuple[bytes, bytes]] = []
        for child in directory.iterdir():
            name = child.name.encode("utf-8")
            if b"\0" in name or b"/" in name:
                fail(f"{label} contains an unsafe name")
            metadata = child.lstat()
            if stat.S_ISDIR(metadata.st_mode) and not child.is_symlink():
                payload = visit(child)
                mode = b"40000"
                object_id = git_object_id("tree", payload)
                sort_key = name + b"/"
            elif stat.S_ISREG(metadata.st_mode) and not child.is_symlink():
                payload = child.read_bytes()
                mode = (
                    b"100755"
                    if metadata.st_mode
                    & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                    else b"100644"
                )
                object_id = git_object_id("blob", payload)
                sort_key = name
            elif stat.S_ISLNK(metadata.st_mode):
                payload = os.readlink(child).encode("utf-8")
                mode = b"120000"
                object_id = git_object_id("blob", payload)
                sort_key = name
            else:
                fail(f"{label} contains a special file")
            entries.append(
                (
                    sort_key,
                    mode + b" " + name + b"\0" + bytes.fromhex(object_id),
                )
            )
        entries.sort(key=lambda item: item[0])
        return b"".join(entry for _key, entry in entries)

    return git_object_id("tree", visit(root))


def source_tree_identity(authority: dict[str, Any]) -> str:
    source = authority.get("source_materialization")
    if not isinstance(source, dict):
        fail("campaign authority lacks source materialization")
    kind = source.get("kind")
    if kind == "sealed-target-overlay-v1":
        return require_string(
            source.get("target_tree_git_oid"),
            "campaign target source tree",
            COMMIT,
        )
    if kind == "exact-git-tree-v1":
        return require_string(
            source.get("tree_git_oid"),
            "campaign exact source tree",
            COMMIT,
        )
    fail("campaign source materialization kind is unsupported")


def dependency_names(
    formula: dict[str, Any],
    tap_name: str,
) -> tuple[str, ...]:
    values = formula.get("dependencies")
    if not isinstance(values, list) or len(values) > MAX_DEPENDENCIES:
        fail(f"{formula.get('name')} dependencies are invalid")
    prefix = f"{tap_name}/"
    result: list[str] = []
    prior = ""
    for index, value in enumerate(values):
        value = exact_keys(
            value,
            {"full_name", "version"},
            f"{formula.get('name')} dependency #{index}",
        )
        full_name = require_string(
            value["full_name"],
            f"{formula.get('name')} dependency #{index} full_name",
        )
        if not full_name.startswith(prefix):
            fail("campaign dependency is not a same-tap Formula")
        name = full_name.removeprefix(prefix)
        require_string(name, "campaign dependency name", FORMULA)
        require_string(
            value["version"], "campaign dependency version", VERSION
        )
        if name <= prior:
            fail("campaign dependencies must be unique and sorted")
        prior = name
        result.append(name)
    return tuple(result)


def load_campaign(
    path: pathlib.Path,
) -> tuple[dict[str, Any], bytes, dict[str, dict[str, Any]]]:
    value, payload = load_json_bytes(path, "campaign manifest")
    if (
        not isinstance(value, dict)
        or value.get("schema") != 1
        or value.get("kind")
        != "kandelo-homebrew-guest-prefix-campaign"
    ):
        fail("campaign manifest has an unsupported contract")
    authority = value.get("authority")
    if not isinstance(authority, dict):
        fail("campaign manifest lacks authority")
    require_string(
        authority.get("kandelo_commit"),
        "campaign Kandelo commit",
        COMMIT,
    )
    require_string(
        authority.get("source_tap_commit"),
        "campaign source tap commit",
        COMMIT,
    )
    require_string(
        authority.get("tap_repository"),
        "campaign tap repository",
        REPOSITORY,
    )
    tap_name = require_string(
        authority.get("tap_name"),
        "campaign tap name",
        REPOSITORY,
    )
    source_tree_identity(authority)
    formulae = value.get("formulae")
    if (
        not isinstance(formulae, list)
        or not formulae
        or len(formulae) > MAX_FORMULAE
    ):
        fail("campaign Formula inventory is invalid")
    index: dict[str, dict[str, Any]] = {}
    prior = ""
    for position, formula in enumerate(formulae):
        if not isinstance(formula, dict):
            fail(f"campaign Formula #{position} must be an object")
        name = require_string(
            formula.get("name"),
            f"campaign Formula #{position} name",
            FORMULA,
        )
        require_string(
            formula.get("version"),
            f"campaign Formula {name} version",
            VERSION,
        )
        if name <= prior:
            fail("campaign Formulae must be unique and sorted")
        prior = name
        dependency_names(formula, tap_name)
        index[name] = formula
    for name, formula in index.items():
        dependencies = dependency_names(formula, tap_name)
        missing = sorted(set(dependencies) - set(index))
        if missing:
            fail(f"campaign Formula {name} has missing dependencies {missing}")
        for dependency, edge in zip(
            dependencies, formula["dependencies"], strict=True
        ):
            if edge["version"] != index[dependency]["version"]:
                fail(
                    f"campaign Formula {name} dependency {dependency} "
                    "version differs from its Formula"
                )
    return value, payload, index


def dependency_closure(
    campaign: dict[str, Any],
    index: dict[str, dict[str, Any]],
    formula_name: str,
) -> tuple[str, ...]:
    tap_name = campaign["authority"]["tap_name"]
    reached: set[str] = set()
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            fail(f"campaign dependency graph cycles at {name}")
        if name in reached:
            return
        if name not in index:
            fail(f"campaign dependency {name} is missing")
        visiting.add(name)
        for dependency in dependency_names(index[name], tap_name):
            visit(dependency)
        visiting.remove(name)
        reached.add(name)

    for name in dependency_names(index[formula_name], tap_name):
        visit(name)
    return tuple(sorted(reached))


def validate_source_root(
    root: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> pathlib.Path:
    root = real_directory(root, "campaign target source")
    expected_tree = source_tree_identity(campaign["authority"])
    if (
        filesystem_git_tree_oid(root, "campaign target source")
        != expected_tree
    ):
        fail("campaign target source differs from its sealed Git tree")
    name = formula["name"]
    source = exact_keys(
        formula.get("formula_source"),
        {"identity_excluding_bottle_sha256", "path", "sha256"},
        f"{name} Formula source",
    )
    if source["path"] != f"Formula/{name}.rb":
        fail(f"{name} Formula source path is not canonical")
    formula_path = regular_file(
        root / source["path"],
        f"{name} target Formula",
        1024 * 1024,
    )
    if sha256_file(formula_path) != require_string(
        source["sha256"], f"{name} Formula SHA-256", SHA256
    ):
        fail(f"{name} target Formula differs from the campaign")
    return root


def walk_regular_files(root: pathlib.Path, label: str) -> list[str]:
    root = real_directory(root, label)
    result: list[str] = []
    for path in root.rglob("*"):
        metadata = path.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not path.is_symlink():
            continue
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            fail(f"{label} contains a symlink or special file")
        result.append(path.relative_to(root).as_posix())
    return sorted(result)


def copy_verified(
    source: pathlib.Path,
    destination: pathlib.Path,
    *,
    expected_bytes: int | None = None,
    expected_sha256: str | None = None,
) -> tuple[int, str]:
    metadata = regular_file(
        source,
        f"input file {source}",
        MAX_ASSET_BYTES,
    ).stat()
    if expected_bytes is not None and metadata.st_size != expected_bytes:
        fail(f"{source} byte count differs from its manifest")
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    copied = 0
    with source.open("rb") as input_file, destination.open("xb") as output:
        while chunk := input_file.read(1024 * 1024):
            copied += len(chunk)
            digest.update(chunk)
            output.write(chunk)
    actual = digest.hexdigest()
    if expected_sha256 is not None and actual != expected_sha256:
        fail(f"{source} SHA-256 differs from its manifest")
    return copied, actual


def campaign_formula_evidence(
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> dict[str, Any]:
    destination = formula.get("destination")
    if not isinstance(destination, dict):
        fail(f"{formula.get('name')} lacks campaign destination")
    return {
        "bottle_rebuild": require_int(
            destination.get("bottle_rebuild"),
            f"{formula.get('name')} bottle rebuild",
        ),
        "dependencies": formula["dependencies"],
        "formula_sha256": require_string(
            formula["formula_source"].get("sha256"),
            f"{formula.get('name')} Formula SHA-256",
            SHA256,
        ),
        "name": formula["name"],
        "version": formula["version"],
    }


def validate_handoff_arches(
    handoff: dict[str, Any],
    formula: dict[str, Any],
) -> None:
    variants = formula.get("variants")
    if not isinstance(variants, list) or not variants:
        fail(f"{formula.get('name')} campaign variants are invalid")
    expected = [
        require_string(
            variant.get("arch") if isinstance(variant, dict) else None,
            f"{formula.get('name')} campaign variant architecture",
        )
        for variant in variants
    ]
    actual = [
        publication["arch"] for publication in handoff["publications"]
    ]
    if actual != expected:
        fail("Formula handoff architectures differ from the campaign")


def publication_asset_name(arch: str, relative: str) -> str:
    return f"{arch}.{relative.replace('/', '.')}"


def default_publication_validator(
    campaign: dict[str, Any],
    formula: dict[str, Any],
    arch: str,
    publication: pathlib.Path,
    source_root: pathlib.Path,
) -> None:
    authority = campaign["authority"]
    command = [
        "bash",
        str(ROOT / "scripts/homebrew-validate-publish-handoff.sh"),
        "--handoff",
        str(publication),
        "--formula",
        formula["name"],
        "--arch",
        arch,
        "--release-tag",
        f"bottles-abi-v{authority['current_kandelo_abi']}",
        "--tap-repository",
        authority["tap_repository"],
        "--tap-name",
        authority["tap_name"],
        "--tap-commit",
        authority["source_tap_commit"],
        "--kandelo-commit",
        authority["kandelo_commit"],
        "--bottle-root-url",
        f"https://ghcr.io/v2/{authority['tap_repository'].lower()}",
        "--tap-root",
        str(source_root),
        "--forbidden-root",
        str(publication.parent),
        "--forbidden-root",
        str(source_root.parent),
        "--defer-whole-tap-validation",
        "--prefix-campaign-layout-sha256",
        authority["guest_layout"]["sha256"],
    ]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=1800,
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f"cannot validate publication {formula['name']}/{arch}: {error}")
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[-16_384:]
        fail(
            f"publication validation failed for "
            f"{formula['name']}/{arch}: {detail}"
        )


def validate_publication_shape(
    publication: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
) -> None:
    actual = walk_regular_files(
        publication, f"{formula['name']}/{arch} publication"
    )
    if actual != list(PUBLICATION_FILES):
        fail(
            f"{formula['name']}/{arch} publication file set differs "
            "from the publisher handoff contract"
        )
    sidecars, _payload = load_json_bytes(
        publication / "composition/sidecars-input.json",
        f"{formula['name']}/{arch} composition input",
    )
    packages = sidecars.get("packages") if isinstance(sidecars, dict) else None
    if (
        not isinstance(packages, list)
        or len(packages) != 1
        or not isinstance(packages[0], dict)
    ):
        fail(f"{formula['name']}/{arch} composition has no exact package")
    package = packages[0]
    evidence = campaign_formula_evidence({}, formula)
    package_dependencies = package.get("dependencies")
    if not isinstance(package_dependencies, list):
        fail(f"{formula['name']}/{arch} dependencies are invalid")
    normalized_dependencies: list[dict[str, str]] = []
    for dependency in package_dependencies:
        dependency = exact_keys(
            dependency,
            {"full_name", "name", "version"},
            f"{formula['name']}/{arch} dependency",
        )
        if not dependency["full_name"].endswith(
            f"/{dependency['name']}"
        ):
            fail(f"{formula['name']}/{arch} dependency name is inconsistent")
        normalized_dependencies.append(
            {
                "full_name": dependency["full_name"],
                "version": dependency["version"],
            }
        )
    if (
        package.get("name") != evidence["name"]
        or package.get("version") != evidence["version"]
        or package.get("bottle_rebuild") != evidence["bottle_rebuild"]
        or package.get("formula_source_sha256")
        != evidence["formula_sha256"]
        or normalized_dependencies != evidence["dependencies"]
    ):
        fail(
            f"{formula['name']}/{arch} composition differs from the campaign"
        )
    bottles = package.get("bottles")
    if (
        not isinstance(bottles, list)
        or len(bottles) != 1
        or not isinstance(bottles[0], dict)
        or bottles[0].get("arch") != arch
    ):
        fail(f"{formula['name']}/{arch} composition bottle is invalid")


def file_record(
    path: pathlib.Path,
    relative: str,
    asset_name: str,
) -> dict[str, Any]:
    require_string(asset_name, "handoff asset name", ASSET_NAME)
    metadata = regular_file(
        path, f"handoff payload {relative}", MAX_ASSET_BYTES
    ).stat()
    return {
        "asset_name": asset_name,
        "bytes": metadata.st_size,
        "path": relative,
        "sha256": sha256_file(path),
    }


def handoff_tag(payload: bytes) -> str:
    return f"homebrew-prefix-handoff-sha256-{sha256_bytes(payload)}"


def validate_handoff_manifest(
    value: Any,
    campaign: dict[str, Any],
    campaign_payload: bytes,
) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "campaign",
            "dependency_handoffs",
            "formula",
            "kind",
            "publications",
            "schema",
            "source",
        },
        "Formula handoff",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-prefix-formula-handoff"
    ):
        fail("Formula handoff has an unsupported contract")
    campaign_record = exact_keys(
        value["campaign"], {"sha256"}, "handoff campaign"
    )
    if campaign_record["sha256"] != sha256_bytes(campaign_payload):
        fail("Formula handoff belongs to a different campaign")
    source = exact_keys(
        value["source"],
        {
            "kandelo_commit",
            "source_tap_commit",
            "target_tree_git_oid",
            "tap_name",
            "tap_repository",
        },
        "handoff source",
    )
    authority = campaign["authority"]
    expected_source = {
        "kandelo_commit": authority["kandelo_commit"],
        "source_tap_commit": authority["source_tap_commit"],
        "target_tree_git_oid": source_tree_identity(authority),
        "tap_name": authority["tap_name"],
        "tap_repository": authority["tap_repository"],
    }
    if source != expected_source:
        fail("Formula handoff source differs from the campaign")
    return value


def validate_handoff_inventory(
    value: Any,
    campaign: dict[str, Any],
    campaign_payload: bytes,
    manifest_bytes: bytes,
) -> tuple[dict[str, Any], list[dict[str, Any]], set[str]]:
    value = validate_handoff_manifest(value, campaign, campaign_payload)
    total = len(manifest_bytes)
    asset_names = {"handoff.json"}
    paths: set[str] = set()
    records: list[dict[str, Any]] = []
    publications = value["publications"]
    if not isinstance(publications, list) or not publications:
        fail("Formula handoff has no publications")
    prior_arch = ""
    for publication in publications:
        publication = exact_keys(
            publication, {"arch", "files"}, "handoff publication"
        )
        arch = publication["arch"]
        if arch not in ("wasm32", "wasm64") or arch <= prior_arch:
            fail("handoff publication architectures are invalid")
        prior_arch = arch
        files = publication["files"]
        if not isinstance(files, list) or len(files) != len(
            PUBLICATION_FILES
        ):
            fail(f"handoff {arch} file inventory is invalid")
        expected_paths = [
            f"payload/{arch}/{relative}"
            for relative in PUBLICATION_FILES
        ]
        actual_paths: list[str] = []
        for index, record in enumerate(files):
            record = exact_keys(
                record,
                {"asset_name", "bytes", "path", "sha256"},
                f"handoff {arch} file #{index}",
            )
            relative = safe_relative(
                record["path"], f"handoff {arch} file #{index} path"
            )
            actual_paths.append(relative)
            if relative in paths:
                fail("Formula handoff repeats a payload path")
            paths.add(relative)
            expected_asset = publication_asset_name(
                arch, PUBLICATION_FILES[index]
            )
            asset_name = require_string(
                record["asset_name"],
                f"handoff {arch} file #{index} asset name",
                ASSET_NAME,
            )
            if asset_name in asset_names:
                fail("handoff repeats a release asset name")
            if asset_name != expected_asset:
                fail(f"handoff {arch} asset name is not canonical")
            asset_names.add(asset_name)
            byte_count = require_int(
                record["bytes"],
                f"handoff {arch} file #{index} bytes",
                1,
                MAX_ASSET_BYTES,
            )
            require_string(
                record["sha256"],
                f"handoff {arch} file #{index} SHA-256",
                SHA256,
            )
            total += byte_count
            if total > MAX_TOTAL_BYTES:
                fail("Formula handoff exceeds its aggregate size bound")
            records.append(record)
        if actual_paths != expected_paths:
            fail(f"handoff {arch} payload paths are not canonical")
    return value, records, asset_names


def validate_dependency_records(
    records: Any,
    expected: dict[str, tuple[str, str]],
) -> None:
    if (
        not isinstance(records, list)
        or len(records) > MAX_DEPENDENCIES
    ):
        fail("handoff dependency evidence is invalid")
    actual: dict[str, tuple[str, str]] = {}
    prior = ""
    for index, value in enumerate(records):
        value = exact_keys(
            value,
            {"formula", "manifest_sha256", "tag"},
            f"handoff dependency #{index}",
        )
        name = require_string(
            value["formula"], f"handoff dependency #{index} formula", FORMULA
        )
        tag = require_string(
            value["tag"], f"handoff dependency #{index} tag", HANDOFF_TAG
        )
        digest = require_string(
            value["manifest_sha256"],
            f"handoff dependency #{index} manifest SHA-256",
            SHA256,
        )
        if tag != f"homebrew-prefix-handoff-sha256-{digest}":
            fail("handoff dependency tag differs from its manifest")
        if name <= prior:
            fail("handoff dependencies must be unique and sorted")
        prior = name
        actual[name] = (tag, digest)
    if actual != expected:
        fail("handoff dependencies differ from the exact campaign closure")


def load_handoff(
    root: pathlib.Path,
    campaign: dict[str, Any],
    campaign_payload: bytes,
) -> tuple[dict[str, Any], bytes]:
    root = real_directory(root, "Formula handoff root")
    value, payload = load_json_bytes(
        root / "handoff.json", "Formula handoff manifest"
    )
    value, records, _asset_names = validate_handoff_inventory(
        value,
        campaign,
        campaign_payload,
        payload,
    )
    actual_files = walk_regular_files(root, "Formula handoff root")
    expected_files = {"handoff.json"}
    for record in records:
        relative = record["path"]
        path = regular_file(
            root / relative,
            f"handoff payload {relative}",
            MAX_ASSET_BYTES,
        )
        if (
            path.stat().st_size != record["bytes"]
            or sha256_file(path) != record["sha256"]
        ):
            fail(f"handoff payload {relative} differs from its manifest")
        expected_files.add(relative)
    if actual_files != sorted(expected_files):
        fail("Formula handoff contains unmanifested files")
    return value, payload


def validate_dependency_handoffs(
    roots: Iterable[pathlib.Path],
    campaign: dict[str, Any],
    campaign_payload: bytes,
    index: dict[str, dict[str, Any]],
    formula_name: str,
) -> tuple[list[dict[str, Any]], dict[str, tuple[str, str]]]:
    expected_names = dependency_closure(
        campaign, index, formula_name
    )
    loaded: dict[str, tuple[str, str]] = {}
    loaded_values: dict[str, dict[str, Any]] = {}
    records: list[dict[str, Any]] = []
    for root in roots:
        value, payload = load_handoff(
            root, campaign, campaign_payload
        )
        formula = value["formula"]
        name = require_string(
            formula.get("name"), "dependency handoff Formula", FORMULA
        )
        if name in loaded:
            fail(f"dependency handoff {name} is duplicated")
        if name not in index:
            fail(f"dependency handoff {name} is outside the campaign")
        expected_formula = campaign_formula_evidence(
            campaign, index[name]
        )
        if formula != expected_formula:
            fail(f"dependency handoff {name} differs from the campaign")
        digest = sha256_bytes(payload)
        tag = handoff_tag(payload)
        loaded[name] = (tag, digest)
        loaded_values[name] = value
        records.append(
            {
                "formula": name,
                "manifest_sha256": digest,
                "tag": tag,
            }
        )
    if tuple(sorted(loaded)) != expected_names:
        fail("dependency handoffs differ from the exact campaign closure")
    for dependency_name, value in loaded_values.items():
        nested_expected = {
            name: loaded[name]
            for name in dependency_closure(
                campaign, index, dependency_name
            )
        }
        validate_dependency_records(
            value["dependency_handoffs"], nested_expected
        )
    records.sort(key=lambda item: item["formula"])
    return records, loaded


PublicationValidator = Callable[
    [dict[str, Any], dict[str, Any], str, pathlib.Path, pathlib.Path],
    None,
]


def snapshot_source_root(
    source: pathlib.Path,
    destination: pathlib.Path,
    campaign: dict[str, Any],
    formula: dict[str, Any],
) -> pathlib.Path:
    try:
        shutil.copytree(source, destination, symlinks=True)
    except OSError as error:
        fail(f"cannot snapshot campaign target source: {error}")
    # WHY: validation tools must never observe a mutable checkout and then
    # permit different bytes to be sealed. The private copy is authoritative
    # only after its complete Git tree and selected Formula match the campaign.
    return validate_source_root(destination, campaign, formula)


def snapshot_publication(
    source: pathlib.Path,
    destination: pathlib.Path,
    formula: dict[str, Any],
    arch: str,
) -> tuple[pathlib.Path, dict[str, dict[str, Any]]]:
    validate_publication_shape(source, formula, arch)
    destination.mkdir(parents=True)
    records: dict[str, dict[str, Any]] = {}
    for relative in PUBLICATION_FILES:
        copied = destination / relative
        copy_verified(source / relative, copied)
        handoff_relative = f"payload/{arch}/{relative}"
        records[relative] = file_record(
            copied,
            handoff_relative,
            publication_asset_name(arch, relative),
        )
    validate_publication_shape(destination, formula, arch)
    return destination, records


def derive_build(
    *,
    campaign_path: pathlib.Path,
    source_tap_root: pathlib.Path,
    formula_name: str,
    publications: list[tuple[str, pathlib.Path]],
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
    validator: PublicationValidator = default_publication_validator,
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    formula_name = require_string(formula_name, "Formula name", FORMULA)
    if formula_name not in index:
        fail(f"Formula {formula_name} is outside the campaign")
    formula = index[formula_name]
    source_tap_root = validate_source_root(
        source_tap_root, campaign, formula
    )
    if not publications:
        fail("Formula handoff needs at least one publication")
    expected_arches = [
        variant.get("arch")
        for variant in formula.get("variants", [])
        if isinstance(variant, dict)
    ]
    actual_arches = [arch for arch, _path in publications]
    if (
        actual_arches != sorted(set(actual_arches))
        or actual_arches != expected_arches
    ):
        fail("publication architectures differ from the campaign")
    publications = [
        (
            arch,
            real_directory(
                publication, f"{formula_name}/{arch} publication"
            ),
        )
        for arch, publication in publications
    ]
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "Formula handoff output",
        (
            campaign_path,
            source_tap_root,
            *(publication for _arch, publication in publications),
            *dependency_roots,
        ),
    )
    dependency_records, dependency_identities = (
        validate_dependency_handoffs(
            dependency_roots,
            campaign,
            campaign_payload,
            index,
            formula_name,
        )
    )
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        result = temporary / "handoff"
        result.mkdir()
        private_source = snapshot_source_root(
            source_tap_root,
            temporary / "source",
            campaign,
            formula,
        )
        publication_records: list[dict[str, Any]] = []
        for arch, publication in publications:
            private_publication, bound_records = snapshot_publication(
                publication,
                temporary / "publications" / arch,
                formula,
                arch,
            )
            validator(
                campaign,
                formula,
                arch,
                private_publication,
                private_source,
            )
            validate_source_root(private_source, campaign, formula)
            validate_publication_shape(
                private_publication, formula, arch
            )
            records: list[dict[str, Any]] = []
            for relative in PUBLICATION_FILES:
                record = bound_records[relative]
                destination = result / record["path"]
                copied, digest = copy_verified(
                    private_publication / relative,
                    destination,
                    expected_bytes=record["bytes"],
                    expected_sha256=record["sha256"],
                )
                if (
                    copied != record["bytes"]
                    or digest != record["sha256"]
                ):
                    fail(
                        "private publication changed after validation"
                    )
                records.append(record)
            publication_records.append(
                {"arch": arch, "files": records}
            )
        manifest = {
            "campaign": {"sha256": sha256_bytes(campaign_payload)},
            "dependency_handoffs": dependency_records,
            "formula": campaign_formula_evidence(campaign, formula),
            "kind": "kandelo-homebrew-prefix-formula-handoff",
            "publications": publication_records,
            "schema": 1,
            "source": {
                "kandelo_commit": campaign["authority"][
                    "kandelo_commit"
                ],
                "source_tap_commit": campaign["authority"][
                    "source_tap_commit"
                ],
                "target_tree_git_oid": source_tree_identity(
                    campaign["authority"]
                ),
                "tap_name": campaign["authority"]["tap_name"],
                "tap_repository": campaign["authority"][
                    "tap_repository"
                ],
            },
        }
        validate_dependency_records(
            manifest["dependency_handoffs"],
            dependency_identities,
        )
        (result / "handoff.json").write_bytes(pretty_json(manifest))
        load_handoff(result, campaign, campaign_payload)
        os.rename(result, output)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def prepare_release(
    *,
    campaign_path: pathlib.Path,
    handoff_root: pathlib.Path,
    dependency_roots: list[pathlib.Path],
    output: pathlib.Path,
) -> None:
    campaign, campaign_payload, index = load_campaign(campaign_path)
    handoff_root = real_directory(
        handoff_root, "Formula handoff root"
    )
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output = validate_new_output(
        output,
        "prepared release output",
        (campaign_path, handoff_root, *dependency_roots),
    )
    handoff, handoff_payload = load_handoff(
        handoff_root, campaign, campaign_payload
    )
    name = require_string(
        handoff["formula"].get("name"), "handoff Formula", FORMULA
    )
    records, identities = validate_dependency_handoffs(
        dependency_roots,
        campaign,
        campaign_payload,
        index,
        name,
    )
    if handoff["dependency_handoffs"] != records:
        fail("Formula handoff dependency evidence changed before release")
    validate_dependency_records(handoff["dependency_handoffs"], identities)
    if handoff["formula"] != campaign_formula_evidence(
        campaign, index[name]
    ):
        fail("Formula handoff differs from its campaign Formula")
    validate_handoff_arches(handoff, index[name])
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        assets = temporary / "assets"
        assets.mkdir()
        asset_records: list[dict[str, Any]] = []
        handoff_asset = assets / "handoff.json"
        handoff_asset.write_bytes(handoff_payload)
        handoff_record = file_record(
            handoff_asset, "handoff.json", "handoff.json"
        )
        asset_records.append(
            {
                "bytes": handoff_record["bytes"],
                "name": "handoff.json",
                "sha256": handoff_record["sha256"],
            }
        )
        for publication in handoff["publications"]:
            for record in publication["files"]:
                source = handoff_root / record["path"]
                destination = assets / record["asset_name"]
                copied, digest = copy_verified(
                    source,
                    destination,
                    expected_bytes=record["bytes"],
                    expected_sha256=record["sha256"],
                )
                if copied != record["bytes"] or digest != record["sha256"]:
                    fail("prepared release asset changed while copied")
                asset_records.append(
                    {
                        "bytes": copied,
                        "name": record["asset_name"],
                        "sha256": digest,
                    }
                )
        asset_records.sort(key=lambda item: item["name"])
        tag = handoff_tag(handoff_payload)
        authority = campaign["authority"]
        release = {
            "accepted_existing_asset_sets": [],
            "assets": asset_records,
            "body": (
                f"Immutable {name} handoff for the Kandelo Homebrew "
                "guest-prefix campaign."
            ),
            "preferred_asset_names": [
                record["name"] for record in asset_records
            ],
            "repository": authority["tap_repository"].lower(),
            "schema": 1,
            "tag": tag,
            "target_commitish": authority["source_tap_commit"],
            "title": f"Kandelo Homebrew prefix handoff: {name}",
        }
        (temporary / "release-manifest.json").write_bytes(
            pretty_json(release)
        )
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def http_json(url: str, label: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "kandelo-homebrew-prefix-campaign",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=HTTP_TIMEOUT
        ) as response:
            payload = response.read(MAX_JSON_BYTES + 1)
    except (OSError, urllib.error.URLError) as error:
        fail(f"cannot fetch {label}: {error}")
    if not payload or len(payload) > MAX_JSON_BYTES:
        fail(f"{label} exceeds its JSON size bound")
    try:
        return json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is invalid JSON: {error}")


def http_asset(
    url: str,
    output: pathlib.Path,
    expected_bytes: int,
    expected_sha256: str,
) -> None:
    if not url.startswith("https://"):
        fail("release asset URL must use HTTPS")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "kandelo-homebrew-prefix-campaign"},
    )
    try:
        with urllib.request.urlopen(
            request, timeout=HTTP_TIMEOUT
        ) as response, output.open("xb") as destination:
            digest = hashlib.sha256()
            copied = 0
            while chunk := response.read(1024 * 1024):
                copied += len(chunk)
                if copied > expected_bytes:
                    fail("release asset exceeds its declared byte count")
                digest.update(chunk)
                destination.write(chunk)
    except ExecutorError:
        raise
    except (OSError, urllib.error.URLError) as error:
        fail(f"cannot fetch release asset: {error}")
    if copied != expected_bytes or digest.hexdigest() != expected_sha256:
        fail("release asset bytes differ from GitHub release evidence")


JsonFetcher = Callable[[str, str], Any]
AssetFetcher = Callable[[str, pathlib.Path, int, str], None]


def release_assets(
    repository: str,
    tag: str,
    *,
    json_fetcher: JsonFetcher = http_json,
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    repository = require_string(repository, "release repository", REPOSITORY)
    tag = require_string(tag, "release tag")
    encoded = urllib.parse.quote(tag, safe="")
    release = json_fetcher(
        f"https://api.github.com/repos/{repository}/releases/tags/{encoded}",
        "GitHub release",
    )
    if not isinstance(release, dict):
        fail("GitHub release response must be an object")
    if (
        release.get("tag_name") != tag
        or release.get("draft") is not False
        or release.get("prerelease") is not False
        or release.get("immutable") is not True
        or not isinstance(release.get("id"), int)
        or release["id"] < 1
    ):
        fail("GitHub release is not the exact public immutable release")
    raw_assets = release.get("assets")
    if (
        not isinstance(raw_assets, list)
        or not raw_assets
        or len(raw_assets) > MAX_RELEASE_ASSETS
    ):
        fail("GitHub release asset inventory is invalid")
    assets: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(raw_assets):
        if not isinstance(value, dict):
            fail(f"GitHub release asset #{index} is invalid")
        name = require_string(
            value.get("name"),
            f"GitHub release asset #{index} name",
            ASSET_NAME,
        )
        if name in assets:
            fail(f"GitHub release repeats asset {name}")
        byte_count = require_int(
            value.get("size"),
            f"GitHub release asset {name} size",
            1,
            MAX_ASSET_BYTES,
        )
        digest_value = require_string(
            value.get("digest"),
            f"GitHub release asset {name} digest",
        )
        if not digest_value.startswith("sha256:"):
            fail(f"GitHub release asset {name} lacks a SHA-256 digest")
        digest = require_string(
            digest_value.removeprefix("sha256:"),
            f"GitHub release asset {name} SHA-256",
            SHA256,
        )
        require_int(
            value.get("id"),
            f"GitHub release asset {name} id",
            1,
        )
        if value.get("state") != "uploaded":
            fail(f"GitHub release asset {name} is not uploaded")
        download_url = require_string(
            value.get("browser_download_url"),
            f"GitHub release asset {name} URL",
        )
        expected_url = (
            f"https://github.com/{repository}/releases/download/"
            f"{urllib.parse.quote(tag, safe='')}/"
            f"{urllib.parse.quote(name, safe='')}"
        )
        if download_url.lower() != expected_url.lower():
            fail(f"GitHub release asset {name} has an unexpected URL")
        assets[name] = {
            "bytes": byte_count,
            "sha256": digest,
            "url": download_url,
        }
    return assets, release


def fetch_one_asset(
    assets: dict[str, dict[str, Any]],
    name: str,
    output: pathlib.Path,
    *,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    if name not in assets:
        fail(f"GitHub release lacks asset {name}")
    record = assets[name]
    asset_fetcher(
        record["url"],
        output,
        record["bytes"],
        record["sha256"],
    )


def commit_output_pair(
    staged_output: pathlib.Path,
    output: pathlib.Path,
    staged_receipt: pathlib.Path,
    receipt_output: pathlib.Path,
) -> None:
    regular_file(
        staged_receipt,
        "staged readback receipt",
        MAX_JSON_BYTES,
    )
    output_is_directory = staged_output.is_dir()
    committed = False
    try:
        # WHY: POSIX has no one-call commit for two arbitrary pathnames.
        # Install the data first, then publish the receipt; if the second
        # name loses a race, roll the data back so the whole command remains
        # safely retryable.
        if output_is_directory:
            os.rename(staged_output, output)
        else:
            regular_file(
                staged_output,
                "staged readback output",
                MAX_ASSET_BYTES,
            )
            os.link(staged_output, output)
        committed = True
        os.link(staged_receipt, receipt_output)
    except OSError as error:
        if committed:
            try:
                if output_is_directory:
                    os.rename(output, staged_output)
                else:
                    output.unlink()
            except OSError as rollback_error:
                fail(
                    "cannot roll back an incomplete readback commit: "
                    f"{rollback_error}"
                )
        fail(f"cannot commit readback output and receipt together: {error}")


def fetch_campaign_release(
    *,
    repository: str,
    tag: str,
    output: pathlib.Path,
    receipt_output: pathlib.Path,
    json_fetcher: JsonFetcher = http_json,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    match = CAMPAIGN_TAG.fullmatch(tag)
    if match is None:
        fail("campaign release tag is invalid")
    output, receipt_output = validate_output_pair(
        output,
        "campaign output",
        receipt_output,
        "campaign receipt output",
        (),
    )
    assets, release = release_assets(
        repository, tag, json_fetcher=json_fetcher
    )
    if set(assets) != {"campaign.json"}:
        fail("campaign release must contain exactly campaign.json")
    campaign_asset = assets["campaign.json"]
    if (
        campaign_asset["bytes"] > MAX_JSON_BYTES
        or campaign_asset["sha256"] != match.group(1)
    ):
        fail("campaign release evidence differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        staged = temporary / "campaign.json"
        fetch_one_asset(
            assets,
            "campaign.json",
            staged,
            asset_fetcher=asset_fetcher,
        )
        campaign, payload, _index = load_campaign(staged)
        if sha256_bytes(payload) != match.group(1):
            fail("campaign release tag differs from campaign.json")
        authority = campaign["authority"]
        if authority["tap_repository"].lower() != repository.lower():
            fail(
                "campaign release repository differs from campaign authority"
            )
        if release.get("target_commitish") != authority[
            "source_tap_commit"
        ]:
            fail("campaign release target differs from campaign authority")
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(
            pretty_json(
                {
                    "asset": {
                        "bytes": len(payload),
                        "name": "campaign.json",
                        "sha256": sha256_bytes(payload),
                    },
                    "kind": (
                        "kandelo-homebrew-prefix-campaign-readback"
                    ),
                    "release_id": release["id"],
                    "repository": repository.lower(),
                    "schema": 1,
                    "tag": tag,
                    "target_commitish": authority[
                        "source_tap_commit"
                    ],
                }
            )
        )
        commit_output_pair(
            staged,
            output,
            staged_receipt,
            receipt_output,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def fetch_release(
    *,
    campaign_path: pathlib.Path,
    tag: str,
    output: pathlib.Path,
    receipt_output: pathlib.Path,
    dependency_roots: list[pathlib.Path],
    json_fetcher: JsonFetcher = http_json,
    asset_fetcher: AssetFetcher = http_asset,
) -> None:
    match = HANDOFF_TAG.fullmatch(tag)
    if match is None:
        fail("Formula handoff release tag is invalid")
    campaign, campaign_payload, index = load_campaign(campaign_path)
    dependency_roots = [
        real_directory(root, "dependency handoff root")
        for root in dependency_roots
    ]
    output, receipt_output = validate_output_pair(
        output,
        "Formula handoff output",
        receipt_output,
        "Formula handoff receipt output",
        (campaign_path, *dependency_roots),
    )
    authority = campaign["authority"]
    assets, release = release_assets(
        authority["tap_repository"],
        tag,
        json_fetcher=json_fetcher,
    )
    if release.get("target_commitish") != authority["source_tap_commit"]:
        fail("Formula handoff release targets the wrong source commit")
    if "handoff.json" not in assets:
        fail("Formula handoff release lacks handoff.json")
    handoff_asset = assets["handoff.json"]
    if (
        handoff_asset["bytes"] > MAX_JSON_BYTES
        or handoff_asset["sha256"] != match.group(1)
    ):
        fail("Formula handoff release evidence differs from its tag")
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        handoff_root = temporary / "handoff"
        handoff_root.mkdir()
        handoff_path = handoff_root / "handoff.json"
        fetch_one_asset(
            assets,
            "handoff.json",
            handoff_path,
            asset_fetcher=asset_fetcher,
        )
        handoff, handoff_payload = load_json_bytes(
            handoff_path, "downloaded Formula handoff manifest"
        )
        handoff, inventory, expected_assets = (
            validate_handoff_inventory(
                handoff,
                campaign,
                campaign_payload,
                handoff_payload,
            )
        )
        if sha256_bytes(handoff_payload) != match.group(1):
            fail("Formula handoff tag differs from handoff.json")
        if set(assets) != expected_assets:
            fail("Formula handoff release contains unexpected assets")
        for record in inventory:
            released = assets[record["asset_name"]]
            if (
                released["bytes"] != record["bytes"]
                or released["sha256"] != record["sha256"]
            ):
                fail(
                    "Formula handoff release evidence differs from "
                    "handoff.json"
                )
        formula_record = handoff["formula"]
        if not isinstance(formula_record, dict):
            fail("downloaded handoff Formula is invalid")
        name = require_string(
            formula_record.get("name"),
            "downloaded handoff Formula",
            FORMULA,
        )
        if name not in index or formula_record != (
            campaign_formula_evidence(campaign, index[name])
        ):
            fail("downloaded Formula handoff differs from the campaign")
        validate_handoff_arches(handoff, index[name])
        records, identities = validate_dependency_handoffs(
            dependency_roots,
            campaign,
            campaign_payload,
            index,
            name,
        )
        if handoff["dependency_handoffs"] != records:
            fail("downloaded Formula handoff dependency evidence is invalid")
        validate_dependency_records(
            handoff["dependency_handoffs"], identities
        )
        for record in inventory:
            destination = private_destination(
                handoff_root,
                record["path"],
                "downloaded handoff payload",
            )
            fetch_one_asset(
                assets,
                record["asset_name"],
                destination,
                asset_fetcher=asset_fetcher,
            )
            if (
                destination.stat().st_size != record["bytes"]
                or sha256_file(destination) != record["sha256"]
            ):
                fail(
                    "downloaded handoff payload differs from handoff.json"
                )
        load_handoff(handoff_root, campaign, campaign_payload)
        staged_receipt = temporary / "receipt.json"
        staged_receipt.write_bytes(
            pretty_json(
                {
                    "formula": name,
                    "handoff_sha256": match.group(1),
                    "kind": (
                        "kandelo-homebrew-prefix-handoff-readback"
                    ),
                    "release_id": release["id"],
                    "repository": authority[
                        "tap_repository"
                    ].lower(),
                    "schema": 1,
                    "tag": tag,
                    "target_commitish": authority[
                        "source_tap_commit"
                    ],
                }
            )
        )
        commit_output_pair(
            handoff_root,
            output,
            staged_receipt,
            receipt_output,
        )
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def parse_publication(value: str) -> tuple[str, pathlib.Path]:
    arch, separator, path = value.partition("=")
    if separator != "=" or arch not in ("wasm32", "wasm64") or not path:
        fail("--publication must be wasm32=<dir> or wasm64=<dir>")
    return arch, pathlib.Path(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    campaign = commands.add_parser("fetch-campaign-release")
    campaign.add_argument("--repository", required=True)
    campaign.add_argument("--tag", required=True)
    campaign.add_argument("--out", required=True)
    campaign.add_argument("--receipt-out", required=True)

    derive = commands.add_parser("derive-build")
    derive.add_argument("--campaign", required=True)
    derive.add_argument("--source-tap-root", required=True)
    derive.add_argument("--formula", required=True)
    derive.add_argument(
        "--publication", action="append", default=[], required=True
    )
    derive.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    derive.add_argument("--out", required=True)

    prepare = commands.add_parser("prepare-release")
    prepare.add_argument("--campaign", required=True)
    prepare.add_argument("--handoff", required=True)
    prepare.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    prepare.add_argument("--out", required=True)

    fetch = commands.add_parser("fetch-release")
    fetch.add_argument("--campaign", required=True)
    fetch.add_argument("--tag", required=True)
    fetch.add_argument("--out", required=True)
    fetch.add_argument("--receipt-out", required=True)
    fetch.add_argument(
        "--dependency-handoff", action="append", default=[]
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "fetch-campaign-release":
            fetch_campaign_release(
                repository=arguments.repository,
                tag=arguments.tag,
                output=pathlib.Path(arguments.out),
                receipt_output=pathlib.Path(arguments.receipt_out),
            )
        elif arguments.command == "derive-build":
            derive_build(
                campaign_path=pathlib.Path(arguments.campaign),
                source_tap_root=pathlib.Path(arguments.source_tap_root),
                formula_name=arguments.formula,
                publications=[
                    parse_publication(value)
                    for value in arguments.publication
                ],
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "prepare-release":
            prepare_release(
                campaign_path=pathlib.Path(arguments.campaign),
                handoff_root=pathlib.Path(arguments.handoff),
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
                output=pathlib.Path(arguments.out),
            )
        elif arguments.command == "fetch-release":
            fetch_release(
                campaign_path=pathlib.Path(arguments.campaign),
                tag=arguments.tag,
                output=pathlib.Path(arguments.out),
                receipt_output=pathlib.Path(arguments.receipt_out),
                dependency_roots=[
                    pathlib.Path(value)
                    for value in arguments.dependency_handoff
                ],
            )
        else:
            raise AssertionError(arguments.command)
        return 0
    except (ExecutorError, OSError, UnicodeError) as error:
        print(
            f"homebrew-prefix-campaign-executor.py: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
