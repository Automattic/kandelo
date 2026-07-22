#!/usr/bin/env python3
"""Validate and stage inert inputs for one immutable GitHub Release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
from typing import NoReturn


MAX_ASSETS = 256
MAX_ACCEPTED_EXISTING_SETS = 16
MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_TITLE_BYTES = 256
MAX_BODY_BYTES = 125_000

REPOSITORY_RE = re.compile(
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/"
    r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\Z"
)
TAG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
ASSET_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\Z")


class ValidationError(Exception):
    pass


def fail(message: str) -> NoReturn:
    raise ValidationError(message)


def exact_keys(value: object, expected: set[str], context: str) -> dict[str, object]:
    if not isinstance(value, dict):
        fail(f"{context} must be an object")
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        fail(f"{context} fields differ: missing={missing}, extra={extra}")
    return value


def required_string(value: object, context: str, *, maximum: int) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{context} must be a nonempty string")
    if len(value.encode("utf-8")) > maximum:
        fail(f"{context} exceeds {maximum} bytes")
    return value


def presentation_string(
    value: object,
    context: str,
    *,
    maximum: int,
    multiline: bool,
) -> str:
    result = required_string(value, context, maximum=maximum)
    for character in result:
        codepoint = ord(character)
        if codepoint == 0x7F or (codepoint < 0x20 and not (multiline and character == "\n")):
            fail(f"{context} contains an unsupported control character")
    if result.endswith("\n"):
        fail(f"{context} must not end with a newline")
    return result


def regular_file(path: pathlib.Path, context: str) -> os.stat_result:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"{context} is missing: {path}")
    if not stat.S_ISREG(metadata.st_mode):
        fail(f"{context} must be a regular non-symlink file: {path}")
    return metadata


def safe_asset_name(value: object, context: str) -> str:
    if not isinstance(value, str) or not ASSET_NAME_RE.fullmatch(value):
        fail(
            f"{context} must be a safe ASCII basename using "
            "letters, digits, dot, underscore, plus, or hyphen"
        )
    if value in {".", ".."} or pathlib.PurePosixPath(value).name != value:
        fail(f"{context} must be a safe basename")
    return value


def load_json(path: pathlib.Path) -> object:
    metadata = regular_file(path, "release manifest")
    if metadata.st_size < 1 or metadata.st_size > MAX_MANIFEST_BYTES:
        fail(f"release manifest must be 1 to {MAX_MANIFEST_BYTES} bytes")
    try:
        with path.open("rb") as input_file:
            raw = input_file.read(MAX_MANIFEST_BYTES + 1)
        if len(raw) < 1 or len(raw) > MAX_MANIFEST_BYTES:
            fail(f"release manifest must be 1 to {MAX_MANIFEST_BYTES} bytes")
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_object_pairs,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"release manifest is not valid UTF-8 JSON: {error}")


def reject_duplicate_object_pairs(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail(f"release manifest contains duplicate JSON object key {key!r}")
        result[key] = value
    return result


def parse_name_set(
    value: object,
    context: str,
    declared_names: set[str],
) -> list[str]:
    if not isinstance(value, list) or not value:
        fail(f"{context} must be a nonempty array")
    names = [safe_asset_name(item, f"{context} item") for item in value]
    if len(names) != len(set(names)):
        fail(f"{context} contains duplicate asset names")
    undeclared = sorted(set(names) - declared_names)
    if undeclared:
        fail(f"{context} contains undeclared assets: {undeclared}")
    return sorted(names)


def copy_verified_asset(
    source: pathlib.Path,
    destination: pathlib.Path,
    expected_sha256: str,
    expected_bytes: int,
) -> None:
    source_metadata = regular_file(source, "release asset")
    if source_metadata.st_size != expected_bytes:
        fail(
            f"release asset {source.name} size differs: "
            f"expected {expected_bytes}, found {source_metadata.st_size}"
        )

    digest = hashlib.sha256()
    copied = 0
    with source.open("rb") as input_file, destination.open("xb") as output_file:
        while chunk := input_file.read(1024 * 1024):
            copied += len(chunk)
            digest.update(chunk)
            output_file.write(chunk)
    os.chmod(destination, 0o600)

    if copied != expected_bytes or digest.hexdigest() != expected_sha256:
        fail(f"release asset {source.name} bytes differ from its manifest")
    staged_metadata = regular_file(destination, "staged release asset")
    if staged_metadata.st_size != expected_bytes:
        fail(f"staged release asset {source.name} changed while it was copied")


def validate_and_stage(args: argparse.Namespace) -> None:
    if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        fail("manifest validation must run without GitHub credentials")

    manifest_path = pathlib.Path(args.manifest)
    asset_root = pathlib.Path(args.asset_root)
    stage_dir = pathlib.Path(args.stage_dir)
    normalized_path = pathlib.Path(args.out_manifest)

    try:
        root_metadata = asset_root.lstat()
    except FileNotFoundError:
        fail(f"asset root is missing: {asset_root}")
    if not stat.S_ISDIR(root_metadata.st_mode):
        fail(f"asset root must be a real non-symlink directory: {asset_root}")
    if stage_dir.exists():
        fail(f"stage directory already exists: {stage_dir}")
    normalized_path.parent.mkdir(parents=True, exist_ok=True)
    stage_dir.mkdir(mode=0o700, parents=False)

    manifest = exact_keys(
        load_json(manifest_path),
        {
            "schema",
            "repository",
            "tag",
            "target_commitish",
            "title",
            "body",
            "assets",
            "preferred_asset_names",
            "accepted_existing_asset_sets",
        },
        "release manifest",
    )
    if manifest["schema"] != 1:
        fail("release manifest schema must be 1")

    repository = required_string(manifest["repository"], "repository", maximum=140)
    if not REPOSITORY_RE.fullmatch(repository):
        fail("repository must be one conservative owner/name GitHub identity")
    repository = repository.lower()
    tag = required_string(manifest["tag"], "tag", maximum=255)
    if not TAG_RE.fullmatch(tag):
        fail("tag must use the state-lock-safe [A-Za-z0-9._-] alphabet")
    target = required_string(manifest["target_commitish"], "target_commitish", maximum=40)
    if not COMMIT_RE.fullmatch(target):
        fail("target_commitish must be one lowercase 40-hex commit SHA")
    title = presentation_string(
        manifest["title"], "title", maximum=MAX_TITLE_BYTES, multiline=False
    )
    body = presentation_string(
        manifest["body"], "body", maximum=MAX_BODY_BYTES, multiline=True
    )

    raw_assets = manifest["assets"]
    if not isinstance(raw_assets, list) or not (1 <= len(raw_assets) <= MAX_ASSETS):
        fail(f"assets must contain 1 to {MAX_ASSETS} entries")

    assets: list[dict[str, object]] = []
    names: set[str] = set()
    total_bytes = 0
    for index, raw_asset in enumerate(raw_assets):
        asset = exact_keys(
            raw_asset,
            {"name", "sha256", "bytes"},
            f"assets[{index}]",
        )
        name = safe_asset_name(asset["name"], f"assets[{index}].name")
        if name in names:
            fail(f"assets contains duplicate name {name}")
        names.add(name)
        sha256 = asset["sha256"]
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            fail(f"assets[{index}].sha256 must be lowercase 64-hex")
        byte_count = asset["bytes"]
        if (
            not isinstance(byte_count, int)
            or isinstance(byte_count, bool)
            or byte_count < 1
            or byte_count > MAX_ASSET_BYTES
        ):
            fail(f"assets[{index}].bytes must be between 1 and {MAX_ASSET_BYTES}")
        total_bytes += byte_count
        if total_bytes > MAX_TOTAL_BYTES:
            fail(f"release assets exceed the {MAX_TOTAL_BYTES}-byte aggregate limit")
        assets.append({"name": name, "sha256": sha256, "bytes": byte_count})

    preferred = parse_name_set(
        manifest["preferred_asset_names"],
        "preferred_asset_names",
        names,
    )
    raw_accepted = manifest["accepted_existing_asset_sets"]
    if not isinstance(raw_accepted, list) or len(raw_accepted) > MAX_ACCEPTED_EXISTING_SETS:
        fail(
            "accepted_existing_asset_sets must be an array with at most "
            f"{MAX_ACCEPTED_EXISTING_SETS} entries"
        )
    accepted: list[list[str]] = []
    seen_sets = {tuple(preferred)}
    for index, raw_set in enumerate(raw_accepted):
        name_set = parse_name_set(
            raw_set,
            f"accepted_existing_asset_sets[{index}]",
            names,
        )
        identity = tuple(name_set)
        if identity in seen_sets:
            fail("accepted_existing_asset_sets contains a duplicate asset set")
        seen_sets.add(identity)
        accepted.append(name_set)
    referenced_names = set(preferred)
    for name_set in accepted:
        referenced_names.update(name_set)
    unused = sorted(names - referenced_names)
    if unused:
        fail(f"asset declarations are not referenced by an allowed set: {unused}")

    for asset in sorted(assets, key=lambda item: str(item["name"])):
        name = str(asset["name"])
        copy_verified_asset(
            asset_root / name,
            stage_dir / name,
            str(asset["sha256"]),
            int(asset["bytes"]),
        )

    normalized = {
        "schema": 1,
        "repository": repository,
        "tag": tag,
        "target_commitish": target,
        "title": title,
        "body": body,
        "assets": sorted(assets, key=lambda item: str(item["name"])),
        "preferred_asset_names": preferred,
        "accepted_existing_asset_sets": sorted(accepted),
    }
    temporary = normalized_path.with_name(normalized_path.name + ".tmp")
    temporary.write_text(
        json.dumps(normalized, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(normalized_path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--manifest", required=True)
    result.add_argument("--asset-root", required=True)
    result.add_argument("--stage-dir", required=True)
    result.add_argument("--out-manifest", required=True)
    return result


def main() -> int:
    try:
        validate_and_stage(parser().parse_args())
    except ValidationError as error:
        print(f"validate-immutable-github-release-manifest: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
